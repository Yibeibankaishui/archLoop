import { exec, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it, vi } from "vitest";
import { appendHubBatchEvent, createHubRunContext } from "./hubExecution.js";
import {
  createHubRunDisplayState,
  formatPlainHubRunEvent,
  reduceHubRunDisplayState,
} from "./hubRunDisplay.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";
import {
  createHubFlowRunImplementer,
  createHubFlowRunReviewer,
  formatHubFlowResultLines,
  matchProviderTransientReason,
  parseHubFlowIdleTimeoutSeconds,
  runHubFlow,
  type HubFlowImplementer,
  type HubFlowReviewer,
  type HubImplementTaskInput,
  type HubReviewTaskInput,
} from "./hubFlowExecution.js";
import { AgentError, HubFlowError } from "./errors.js";
import {
  resolveHubFlowPromptPath,
  validateHubFlowRegistries,
} from "./hubFlows.js";
import {
  configureHubProjectDevelopmentContract,
  resolveHubProjectDevelopmentContractState,
} from "./hubProjectDevelopmentContract.js";
import * as runModule from "./run.js";
import {
  loadHubReadyQueue,
  resolveHubTaskBranch,
  selectHubFlowTasks,
  type HubTaskProjection,
} from "./taskBoard.js";
import * as taskBoard from "./taskBoard.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { leaseLockPath, leaseNameFromBranch } from "./WorktreeLease.js";

const execAsync = promisify(exec);

describe("matchProviderTransientReason", () => {
  it("recognises well-known provider transient markers", () => {
    expect(
      matchProviderTransientReason(
        "claude-code exited with code 1:\nAPI Error: 400 Invalid request parameters (request id: abc)",
      ),
    ).toBe("API Error: 400 Invalid request parameters");
    expect(
      matchProviderTransientReason(
        "cursor exited with code 1:\nRetriableError: Connection stalled",
      ),
    ).toBe("RetriableError: Connection stalled");
    expect(
      matchProviderTransientReason(
        "cursor exited with code 1:\nRetriableError: [unavailable] PING timed out",
      ),
    ).toBe("RetriableError: [unavailable] PING timed out");
  });

  it("ignores non-transient provider exits", () => {
    expect(
      matchProviderTransientReason(
        "cursor exited with code 1:\nAuthentication failed",
      ),
    ).toBeUndefined();
  });
});

const runLeaseEffect = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<
      A,
      never
    >,
  );

const spawnExitedPid = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", () => {
      if (child.pid === undefined) {
        reject(new Error("child pid missing"));
        return;
      }
      resolve(child.pid);
    });
  });

const writeLeaseFile = async (
  repoDir: string,
  branch: string,
  content: string,
) => {
  const lockPath = leaseLockPath(repoDir, leaseNameFromBranch(branch));
  await mkdir(join(repoDir, ".archloop", "locks"), { recursive: true });
  await writeFile(lockPath, content, "utf-8");
};

const expectBundledHubFlowPrompt = (promptPath: string, segment: string) => {
  expect(promptPath).toContain(segment);
  expect(promptPath).toContain("src/hub-flows/");
};

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const readJsonl = async (path: string): Promise<unknown[]> => {
  const content = await readFile(path, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
};

interface MockBeadsTask {
  id: string;
  title: string;
  status: string;
  labels: string[];
  metadata: Record<string, unknown>;
  remoteRefs?: readonly { url: string }[];
}

const writeMockBd = async (
  repoDir: string,
  stateFile: string,
  initialTasks: MockBeadsTask[],
  options: { readonly argsFile?: string } = {},
) => {
  seedHubTaskStoreMetadata(repoDir);
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));

  const argsFile = options.argsFile ?? join(repoDir, "bd-args.txt");
  await writeFile(argsFile, "");
  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const argsFile = process.env.BD_ARGS_FILE;
const args = process.argv.slice(2);
const [command, id] = args;
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const findTask = (state, taskId) => state.find((task) => task.id === taskId);

if (command === "ready" && args.includes("--json")) {
  const state = readState();
  const ready = state.filter((task) =>
    task.labels.includes("ready-for-agent") && task.status === "open",
  );
  process.stdout.write(JSON.stringify(ready));
  process.exit(0);
}

if (command === "list" && args.includes("--json")) {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}

if (command === "show" && id) {
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "update" && id) {
  fs.writeFileSync(argsFile, args.join("\\n"));
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  const statusIndex = args.indexOf("--status");
  if (statusIndex >= 0) {
    task.status = args[statusIndex + 1];
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      task.labels = [];
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      const label = args[index + 1];
      if (!task.labels.includes(label)) task.labels.push(label);
    }
    if (args[index] === "--add-label") {
      const label = args[index + 1];
      if (!task.labels.includes(label)) task.labels.push(label);
    }
    if (args[index] === "--remove-label") {
      const label = args[index + 1];
      task.labels = task.labels.filter((entry) => entry !== label);
    }
  }
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = {
      ...task.metadata,
      ...JSON.parse(args[metadataIndex + 1]),
    };
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--unset-metadata") {
      delete task.metadata[args[index + 1]];
    }
  }
  writeState(state);
  process.exit(0);
}

process.exit(1);
`,
  );
  await chmod(bdPath, 0o755);

  return {
    binDir,
    argsFile,
    stateFile,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCHLOOP_BD_PATH: bdPath,
      BD_STATE_FILE: stateFile,
      BD_ARGS_FILE: argsFile,
    },
  };
};

describe("Hub flow registry", () => {
  it("ships bundled no-review prompts outside repo-local .archloop/", () => {
    validateHubFlowRegistries();
    expectBundledHubFlowPrompt(
      resolveHubFlowPromptPath("no-review", "implement"),
      "hub-flows/no-review/implement-prompt.md",
    );
    expectBundledHubFlowPrompt(
      resolveHubFlowPromptPath("no-review", "batchPlanner"),
      "hub-flows/no-review/batch-planner-prompt.md",
    );
  });

  it("ships bundled with-review prompts outside repo-local .archloop/", () => {
    validateHubFlowRegistries();
    expectBundledHubFlowPrompt(
      resolveHubFlowPromptPath("with-review", "implement"),
      "hub-flows/with-review/implement-prompt.md",
    );
    expectBundledHubFlowPrompt(
      resolveHubFlowPromptPath("with-review", "review"),
      "hub-flows/with-review/review-prompt.md",
    );
  });

  it.each(["no-review", "with-review"] as const)(
    "implement prompt for %s injects contract guidance instead of hardcoded Node verification text",
    async (flowId) => {
      const prompt = await readFile(
        resolveHubFlowPromptPath(flowId, "implement"),
        "utf-8",
      );

      expect(prompt).toContain("{{PROJECT_PROFILE}}");
      expect(prompt).toContain("{{PROJECT_DEVELOPMENT_CONTRACT_SETUP}}");
      expect(prompt).toContain("{{PROJECT_DEVELOPMENT_CONTRACT_VERIFY}}");
      expect(prompt).toContain("{{PROJECT_DEVELOPMENT_CONTRACT_CONTEXT}}");
      expect(prompt).not.toContain("npm run typecheck");
      expect(prompt).not.toContain("npm run test");
    },
  );

  it.each(["no-review", "with-review"] as const)(
    "implement prompt for %s forbids remote push and Beads sync",
    async (flowId) => {
      const prompt = await readFile(
        resolveHubFlowPromptPath(flowId, "implement"),
        "utf-8",
      );

      expect(prompt).toContain("git push");
      expect(prompt).toContain("bd dolt push");
      expect(prompt).toContain("bd dolt commit");
      expect(prompt).toMatch(/do not sync Beads|must NOT sync Beads/i);
      expect(prompt).toMatch(
        /Hub handles merge and remote sync|merge and remote sync later/i,
      );
    },
  );

  it.each(["no-review", "with-review"] as const)(
    "batch planner prompt for %s treats empty live blockers as unblocked",
    async (flowId) => {
      const prompt = await readFile(
        resolveHubFlowPromptPath(flowId, "batchPlanner"),
        "utf-8",
      );

      expect(prompt).toContain("openBlockers");
      expect(prompt).toContain("unknownBlockers");
      expect(prompt).toContain(
        "When both `openBlockers` and `unknownBlockers` are empty",
      );
      expect(prompt).toContain(
        "Do not infer blockers from raw description text.",
      );
      expect(prompt).not.toContain("blockersDeclared");
    },
  );
});

describe("Hub flow planner", () => {
  it("selects ready_for_agent tasks from the Beads ready queue and skips active claims", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-planner-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-ready",
        title: "Ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-human",
        title: "Human task",
        status: "open",
        labels: ["ready-for-human"],
        metadata: {},
      },
      {
        id: "bd-claimed",
        title: "Already claimed",
        status: "in_progress",
        labels: ["ready-for-agent", "implementing"],
        metadata: {
          claim: {
            runId: "run-existing",
            batchId: "batch-existing",
            branch: "archloop/bd-claimed-other",
            claimedAt: "2026-06-11T15:30:00Z",
          },
        },
      },
    ]);

    const board = loadHubReadyQueue(repoDir, env);
    expect(board.tasks.map((task) => task.id)).toEqual(["bd-ready"]);
    expect(selectHubFlowTasks(board).map((task) => task.id)).toEqual([
      "bd-ready",
    ]);
    expect(resolveHubTaskBranch("bd-ready", "Ready task")).toBe(
      "archloop/bd-ready-ready-task",
    );
  });

  it("conservative batch strategy selects and claims only one eligible ready task", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-conservative-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "conservative",
    );

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      batchStrategy: "conservative",
      maxTasks: 3,
      implementer: async (input) => {
        invocations.push(input);
        return {
          outcome: "success",
          commits: [{ sha: "abc123" }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      runMergePhase: false,
    });

    expect(result.selectedTaskIds).toEqual(["bd-first", "bd-second"]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyUsed: "conservative",
      maxTasks: 3,
      deferredTasks: [{ taskId: "bd-second", reason: "over_max_tasks" }],
    });
    expect(result.completedBatchCount).toBe(2);
    expect(result.completedTaskCount).toBe(2);
    expect(result.stopReason).toBe("no_ready_tasks");
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.taskId).toBe("bd-first");
    expect(invocations[1]?.taskId).toBe("bd-second");

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const plannedEvents = batchEvents.filter(
      (event) => (event as { type?: string }).type === "batch_planned",
    );
    expect(plannedEvents).toHaveLength(3);
    expect(plannedEvents[0]).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-first"],
      batchStrategyUsed: "conservative",
      maxTasks: 3,
      deferredTasks: [{ taskId: "bd-second", reason: "over_max_tasks" }],
    });
    expect(plannedEvents[1]).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-second"],
    });
    expect(plannedEvents[2]).toMatchObject({
      type: "batch_planned",
      taskIds: [],
    });

    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "Batch strategy: conservative (max 3)",
    );

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(
      finalState.find((task) => task.id === "bd-first")?.metadata.hubStatus,
    ).toBe("waiting_for_merge");
    expect(
      finalState.find((task) => task.id === "bd-second")?.labels,
    ).toContain("waiting-for-merge");
  });

  it("defaults to planned batch strategy with max 3 and conservative fallback until planner is wired", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-default-batch-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "default-batch",
    );

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async (input) => {
        invocations.push(input);
        return {
          outcome: "success",
          commits: [{ sha: "abc123" }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      runMergePhase: false,
    });

    expect(result.selectedTaskIds).toEqual(["bd-first", "bd-second"]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyRequested: "planned",
      batchStrategyUsed: "conservative",
      maxTasks: 3,
      fallbackReason: "planner_unavailable",
      deferredTasks: [{ taskId: "bd-second", reason: "over_max_tasks" }],
    });
    expect(result.completedBatchCount).toBe(2);
    expect(result.completedTaskCount).toBe(2);
    expect(result.stopReason).toBe("no_ready_tasks");
    expect(invocations).toHaveLength(2);

    const output = formatHubFlowResultLines(result).join("\n");
    expect(output).toContain("Batch strategy: conservative (max 3)");
    expect(output).toContain("Batch strategy requested: planned");
    expect(output).toContain("Batch fallback: planner_unavailable");
  }, 20000);

  it("fresh-validates conservative selection before claim and falls back when the first task gains an active claim", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-flow-fresh-validate-claim-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "fresh-validate-claim",
    );

    let readyLoadCount = 0;
    const originalLoadHubReadyQueue = taskBoard.loadHubReadyQueue;
    const loadReadyQueueSpy = vi
      .spyOn(taskBoard, "loadHubReadyQueue")
      .mockImplementation((cwd, loadEnv) => {
        readyLoadCount += 1;
        const board = originalLoadHubReadyQueue(cwd, loadEnv);
        if (readyLoadCount === 1) {
          return board;
        }

        const claimedFirstTask = {
          ...board.tasks.find((task) => task.id === "bd-first")!,
          claimState: "active",
          hubStatus: "implementing",
        } as HubTaskProjection;

        return {
          ...board,
          tasks: board.tasks.map((task) =>
            task.id === "bd-first" ? claimedFirstTask : task,
          ),
        };
      });

    try {
      const result = await runHubFlow({
        flowId: "no-review",
        cwd: repoDir,
        hubProjectDir,
        env,
        batchStrategy: "conservative",
        maxTasks: 3,
        implementer: async (input) => {
          invocations.push(input);
          return {
            outcome: "success",
            commits: [{ sha: "abc123" }],
            completionSignal: "<promise>COMPLETE</promise>",
          };
        },
        runMergePhase: false,
      });

      expect(readyLoadCount).toBeGreaterThanOrEqual(2);
      expect(result.selectedTaskIds).toEqual(["bd-second"]);
      expect(result.batchSelection?.fallbackReason).toBe("active_claim");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.taskId).toBe("bd-second");

      const batchEvents = await readJsonl(
        join(result.runDir, "events", "batch.jsonl"),
      );
      const plannedEvent = batchEvents.find(
        (event) => (event as { type?: string }).type === "batch_planned",
      );
      expect(plannedEvent).toMatchObject({
        taskIds: ["bd-second"],
        batchStrategyRequested: "conservative",
        batchStrategyUsed: "conservative",
        fallbackReason: "active_claim",
      });
    } finally {
      loadReadyQueueSpy.mockRestore();
    }
  });

  it("fresh-validates conservative selection before claim and falls back when status changes", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-flow-fresh-validate-status-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "fresh-validate-status",
    );

    let readyLoadCount = 0;
    const originalLoadHubReadyQueue = taskBoard.loadHubReadyQueue;
    const loadReadyQueueSpy = vi
      .spyOn(taskBoard, "loadHubReadyQueue")
      .mockImplementation((cwd, loadEnv) => {
        readyLoadCount += 1;
        const board = originalLoadHubReadyQueue(cwd, loadEnv);
        if (readyLoadCount === 1) {
          return board;
        }

        const staleFirstTask = {
          ...board.tasks.find((task) => task.id === "bd-first")!,
          hubStatus: "ready_for_human",
        } as HubTaskProjection;

        return {
          ...board,
          tasks: board.tasks.map((task) =>
            task.id === "bd-first" ? staleFirstTask : task,
          ),
        };
      });

    try {
      const result = await runHubFlow({
        flowId: "no-review",
        cwd: repoDir,
        hubProjectDir,
        env,
        batchStrategy: "conservative",
        maxTasks: 3,
        implementer: async (input) => {
          invocations.push(input);
          return {
            outcome: "success",
            commits: [{ sha: "abc123" }],
            completionSignal: "<promise>COMPLETE</promise>",
          };
        },
        runMergePhase: false,
      });

      expect(result.selectedTaskIds).toEqual(["bd-second"]);
      expect(result.batchSelection?.fallbackReason).toBe("not_ready_for_agent");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.taskId).toBe("bd-second");
    } finally {
      loadReadyQueueSpy.mockRestore();
    }
  });

  it("planned batch strategy uses the flow-owned batch planner before claim", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-planned-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-third",
        title: "Third ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "planned",
    );

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      batchStrategy: "planned",
      maxTasks: 2,
      batchPlanner: async () =>
        `<batch-plan>${JSON.stringify({
          selectedTaskIds: ["bd-first", "bd-second"],
          deferred: [{ taskId: "bd-third", reason: "same_core_module" }],
          rationale: "Two independent tasks can run in parallel.",
        })}</batch-plan>`,
      implementer: async (input) => {
        invocations.push(input);
        return {
          outcome: "success",
          commits: [{ sha: "abc123" }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      runMergePhase: false,
    });

    expect(result.selectedTaskIds).toEqual([
      "bd-first",
      "bd-second",
      "bd-third",
    ]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyUsed: "planned",
      maxTasks: 2,
      deferredTasks: [{ taskId: "bd-third", reason: "same_core_module" }],
      rationale: "Two independent tasks can run in parallel.",
    });
    expect(invocations.map((input) => input.taskId)).toEqual([
      "bd-first",
      "bd-second",
      "bd-third",
    ]);
    expect(result.completedBatchCount).toBe(2);
    expect(result.completedTaskCount).toBe(3);
    expect(result.stopReason).toBe("no_ready_tasks");

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const plannedEvents = batchEvents.filter(
      (event) => (event as { type?: string }).type === "batch_planned",
    );
    expect(plannedEvents).toHaveLength(3);
    expect(plannedEvents[0]).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-first", "bd-second"],
      batchStrategyUsed: "planned",
      maxTasks: 2,
      deferredTasks: [{ taskId: "bd-third", reason: "same_core_module" }],
      rationale: "Two independent tasks can run in parallel.",
    });
    expect(plannedEvents[1]).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-third"],
    });
    expect(plannedEvents[2]).toMatchObject({
      type: "batch_planned",
      taskIds: [],
    });

    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "Batch strategy: planned (max 2)",
    );
  }, 20000);

  it("does not claim when the planned batch planner returns no safe tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-planned-empty-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-blocked",
        title: "Blocked task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-dependent",
        title: "Dependent task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir: join(
        repoDir,
        "data",
        "archloop",
        "hub",
        "projects",
        "planned-empty",
      ),
      env,
      batchStrategy: "planned",
      maxTasks: 2,
      batchPlanner: async () =>
        `<batch-plan>${JSON.stringify({
          selectedTaskIds: [],
          deferred: [
            { taskId: "bd-blocked", reason: "explicit_blocker" },
            { taskId: "bd-dependent", reason: "design_decision_dependency" },
          ],
          rationale: "All candidates depend on unresolved base behavior.",
        })}</batch-plan>`,
      implementer: async () => {
        throw new Error("implementer should not run for an empty safe batch");
      },
    });

    expect(result.selectedTaskIds).toEqual([]);
    expect(result.stopReason).toBe("no_ready_tasks");
    expect(result.completedBatchCount).toBe(0);
    expect(result.completedTaskCount).toBe(0);
    expect(result.mergeResult).toBeUndefined();
    expect(result.batchSelection).toMatchObject({
      batchStrategyRequested: "planned",
      batchStrategyUsed: "planned",
      maxTasks: 2,
      deferredTasks: [
        { taskId: "bd-blocked", reason: "explicit_blocker" },
        { taskId: "bd-dependent", reason: "design_decision_dependency" },
      ],
      rationale: "All candidates depend on unresolved base behavior.",
    });
    expect(result.batchSelection?.fallbackReason).toBeUndefined();

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState.map((task) => task.labels)).toEqual([
      ["ready-for-agent"],
      ["ready-for-agent"],
    ]);
    expect(finalState.map((task) => task.metadata.hubStatus)).toEqual([
      undefined,
      undefined,
    ]);

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    expect(batchEvents).toContainEqual(
      expect.objectContaining({
        type: "batch_planned",
        taskIds: [],
        batchStrategyUsed: "planned",
        maxTasks: 2,
        deferredTasks: [
          { taskId: "bd-blocked", reason: "explicit_blocker" },
          { taskId: "bd-dependent", reason: "design_decision_dependency" },
        ],
        rationale: "All candidates depend on unresolved base behavior.",
      }),
    );
    expect(
      batchEvents.some(
        (event) =>
          (event as { type?: string }).type === "batch_merge_selection",
      ),
    ).toBe(false);
  }, 20000);

  it("records invalid explicit blocker deferrals and recovers stale ready tasks up to max-tasks", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-flow-planned-invalid-deferral-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-github-152",
        title: "Closed blocker",
        status: "done",
        labels: [],
        metadata: {},
        remoteRefs: [{ url: "github#152" }],
      },
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-third",
        title: "Third ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "planned-invalid-deferral",
    );

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      batchStrategy: "planned",
      maxTasks: 3,
      batchPlanner: async () =>
        `<batch-plan>${JSON.stringify({
          selectedTaskIds: ["bd-first"],
          deferred: [
            { taskId: "bd-second", reason: "explicit_blocker" },
            { taskId: "bd-third", reason: "explicit_blocker" },
          ],
          rationale: "Planner incorrectly deferred stale blocker prose.",
        })}</batch-plan>`,
      implementer: async (input) => {
        invocations.push(input);
        return {
          outcome: "success",
          commits: [{ sha: "abc123" }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      runMergePhase: false,
    });

    expect(result.selectedTaskIds).toEqual([
      "bd-first",
      "bd-second",
      "bd-third",
    ]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyUsed: "planned",
      maxTasks: 3,
      deferredTasks: [],
      diagnosticReason: "invalid_explicit_blocker_deferral",
      rationale: "Planner incorrectly deferred stale blocker prose.",
    });
    expect(new Set(invocations.map((input) => input.taskId))).toEqual(
      new Set(["bd-first", "bd-second", "bd-third"]),
    );

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const plannedEvent = batchEvents.find(
      (event) => (event as { type?: string }).type === "batch_planned",
    );
    expect(plannedEvent).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-first", "bd-second", "bd-third"],
      batchStrategyUsed: "planned",
      maxTasks: 3,
      diagnosticReason: "invalid_explicit_blocker_deferral",
    });

    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "Batch diagnostic: invalid_explicit_blocker_deferral",
    );
  }, 20000);

  it("starts planned batch implementations before the first selected task finishes", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-parallel-batch-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    let finishImplementations!: () => void;
    const finishImplementationsPromise = new Promise<void>((resolve) => {
      finishImplementations = resolve;
    });
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const startedTaskIds: string[] = [];
    const implementer: HubFlowImplementer = async (input) => {
      startedTaskIds.push(input.taskId);
      if (startedTaskIds.length === 2) {
        resolveBothStarted();
      }
      await finishImplementationsPromise;
      return {
        outcome: "success",
        commits: [{ sha: `commit-${input.taskId}` }],
        completionSignal: "<promise>COMPLETE</promise>",
      };
    };
    const waitForBothStarted = async (): Promise<boolean> =>
      await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 10000);
        void bothStarted.then(() => {
          clearTimeout(timeout);
          resolve(true);
        });
      });

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "parallel-batch",
    );
    const runPromise = runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      batchStrategy: "planned",
      maxTasks: 2,
      batchPlanner: async () =>
        `<batch-plan>${JSON.stringify({
          selectedTaskIds: ["bd-first", "bd-second"],
          deferred: [],
          rationale: "Two independent tasks can run in parallel.",
        })}</batch-plan>`,
      implementer,
      runMergePhase: false,
    });

    const secondTaskStartedBeforeFirstFinished = await waitForBothStarted();
    finishImplementations();
    const result = await runPromise;

    expect(secondTaskStartedBeforeFirstFinished).toBe(true);
    expect(new Set(startedTaskIds)).toEqual(new Set(["bd-first", "bd-second"]));
    expect(result.selectedTaskIds).toEqual(["bd-first", "bd-second"]);
    expect(result.results).toHaveLength(2);

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    const firstSuccessIndex = taskEvents.findIndex(
      (event) =>
        (event as { type?: string }).type === "task_implementation_succeeded",
    );
    const startedBeforeFirstSuccess = taskEvents
      .slice(0, firstSuccessIndex)
      .filter(
        (event) =>
          (event as { type?: string }).type === "task_implementation_started",
      )
      .map((event) => (event as { taskId: string }).taskId);
    expect(new Set(startedBeforeFirstSuccess)).toEqual(
      new Set(["bd-first", "bd-second"]),
    );

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(
      finalState.every(
        (task) => task.metadata.hubStatus === "waiting_for_merge",
      ),
    ).toBe(true);
  }, 20000);

  it("limited batch strategy selects eligible ready tasks in ready queue order up to max-tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-limited-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-z-queue-first",
        title: "Queue first",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-m-queue-second",
        title: "Queue second",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-a-queue-third",
        title: "Queue third",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-claimed",
        title: "Already claimed",
        status: "in_progress",
        labels: ["ready-for-agent", "implementing"],
        metadata: {
          claim: {
            runId: "run-existing",
            batchId: "batch-existing",
            branch: "archloop/bd-claimed-other",
            claimedAt: "2026-06-11T15:30:00Z",
          },
        },
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "limited",
    );

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      batchStrategy: "limited",
      maxTasks: 2,
      implementer: async (input) => {
        invocations.push(input);
        return {
          outcome: "success",
          commits: [{ sha: "abc123" }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      runMergePhase: false,
    });

    expect(result.selectedTaskIds).toEqual([
      "bd-z-queue-first",
      "bd-m-queue-second",
      "bd-a-queue-third",
    ]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyUsed: "limited",
      maxTasks: 2,
      deferredTasks: [{ taskId: "bd-a-queue-third", reason: "over_max_tasks" }],
    });
    expect(invocations.map((input) => input.taskId)).toEqual([
      "bd-z-queue-first",
      "bd-m-queue-second",
      "bd-a-queue-third",
    ]);
    expect(result.completedBatchCount).toBe(2);
    expect(result.completedTaskCount).toBe(3);
    expect(result.stopReason).toBe("no_ready_tasks");

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const plannedEvents = batchEvents.filter(
      (event) => (event as { type?: string }).type === "batch_planned",
    );
    expect(plannedEvents).toHaveLength(3);
    expect(plannedEvents[0]).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-z-queue-first", "bd-m-queue-second"],
      batchStrategyUsed: "limited",
      maxTasks: 2,
    });
    expect(plannedEvents[1]).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-a-queue-third"],
      batchStrategyUsed: "limited",
      maxTasks: 2,
    });
    expect(plannedEvents[2]).toMatchObject({
      type: "batch_planned",
      taskIds: [],
    });

    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "Batch strategy: limited (max 2)",
    );

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(
      finalState.find((task) => task.id === "bd-a-queue-third")?.labels,
    ).toContain("waiting-for-merge");
  }, 20000);

  it("continues selecting successful task-board batches until the ready queue is empty", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-multi-batch-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-third",
        title: "Third ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    let displayState = createHubRunDisplayState({
      hubProjectName: "Multi-batch project",
      flowId: "no-review",
    });
    const plainLines: string[] = [];
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "multi-batch",
    );

    let readyLoadCount = 0;
    const originalLoadHubReadyQueue = taskBoard.loadHubReadyQueue;
    const loadReadyQueueSpy = vi
      .spyOn(taskBoard, "loadHubReadyQueue")
      .mockImplementation((cwd, loadEnv) => {
        readyLoadCount += 1;
        return originalLoadHubReadyQueue(cwd, loadEnv);
      });

    try {
      const result = await runHubFlow({
        flowId: "no-review",
        cwd: repoDir,
        hubProjectDir,
        env,
        batchStrategy: "limited",
        maxTasks: 2,
        implementer: async (input) => {
          invocations.push(input);
          return {
            outcome: "success",
            commits: [{ sha: `commit-${input.taskId}` }],
            completionSignal: "<promise>COMPLETE</promise>",
          };
        },
        runMergePhase: false,
        onEvent: (event) => {
          const nextState = reduceHubRunDisplayState(displayState, event);
          if (nextState !== displayState) {
            displayState = nextState;
            plainLines.push(formatPlainHubRunEvent(event, displayState));
          }
        },
      });

      expect(readyLoadCount).toBeGreaterThanOrEqual(4);
      expect(result.selectedTaskIds).toEqual([
        "bd-first",
        "bd-second",
        "bd-third",
      ]);
      expect(result.completedBatchCount).toBe(2);
      expect(result.completedTaskCount).toBe(3);
      expect(result.stopReason).toBe("no_ready_tasks");
      expect(result.batchResults).toHaveLength(2);
      expect(invocations.map((input) => input.taskId)).toEqual([
        "bd-first",
        "bd-second",
        "bd-third",
      ]);
      expect(
        plainLines.filter((line) => line.startsWith("event=batch_planned")),
      ).toEqual([
        expect.stringContaining('selected_tasks=["bd-first","bd-second"]'),
        expect.stringContaining('selected_tasks=["bd-third"]'),
        expect.stringContaining("selected_tasks=[]"),
      ]);
      expect(plainLines.at(-1)).toMatch(
        /^event=run_completed outcome="completed" summary="Run completed" completed_batches=2 completed_tasks=3 /,
      );

      const taskEvents = await readJsonl(
        join(result.runDir, "events", "task.jsonl"),
      );
      const implementationStartEvents = taskEvents.filter(
        (event) =>
          (event as { type?: string }).type === "task_implementation_started",
      );
      expect(implementationStartEvents).toHaveLength(3);

      const batchEvents = await readJsonl(
        join(result.runDir, "events", "batch.jsonl"),
      );
      expect(
        batchEvents.filter(
          (event) => (event as { type?: string }).type === "batch_planned",
        ),
      ).toHaveLength(3);
    } finally {
      loadReadyQueueSpy.mockRestore();
    }
  });

  it("stops task-board flow execution when the max-batches cap is reached", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-max-batches-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-second",
        title: "Second ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-third",
        title: "Third ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir: join(
        repoDir,
        "data",
        "archloop",
        "hub",
        "projects",
        "max-batches",
      ),
      env,
      batchStrategy: "limited",
      maxTasks: 1,
      maxBatches: 2,
      implementer: async (input) => {
        invocations.push(input);
        return {
          outcome: "success",
          commits: [{ sha: `commit-${input.taskId}` }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      runMergePhase: false,
    });

    expect(result.selectedTaskIds).toEqual(["bd-first", "bd-second"]);
    expect(result.completedBatchCount).toBe(2);
    expect(result.completedTaskCount).toBe(2);
    expect(result.stopReason).toBe("max_batches_reached");
    expect(result.batchResults).toHaveLength(2);
    expect(invocations.map((input) => input.taskId)).toEqual([
      "bd-first",
      "bd-second",
    ]);

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState.find((task) => task.id === "bd-third")?.labels).toContain(
      "ready-for-agent",
    );
  });
});

describe("no-review Hub flow execution", () => {
  it("projects a successful task through user-facing plain lifecycle stages", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-plain-success-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-plain",
        title: "Do not print this agent prose",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "plain-success",
    );
    let displayState = createHubRunDisplayState({
      hubProjectName: "Plain project",
      flowId: "no-review",
    });
    const lines: string[] = [];

    await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async () => ({
        outcome: "success",
        commits: [{ sha: "abc123" }],
        completionSignal: "<promise>COMPLETE</promise>",
        message: "raw agent prose that must stay out of lifecycle output",
      }),
      runMergePhase: false,
      onEvent: (event) => {
        displayState = reduceHubRunDisplayState(displayState, event);
        lines.push(formatPlainHubRunEvent(event, displayState));
      },
    });

    expect(lines).toContainEqual(
      expect.stringMatching(
        /^event=batch_planned .* selected_tasks=\["bd-plain"\]$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^event=task_implementation_started .* task_id="bd-plain" stage="Implementing"$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^event=task_implementation_succeeded .* task_id="bd-plain" stage="Waiting for merge"$/,
      ),
    );
    expect(lines.at(-1)).toMatch(
      /^event=run_completed outcome="completed" summary="Run completed" completed_batches=1 completed_tasks=1 /,
    );
    expect(lines.join("\n")).not.toContain("raw agent prose");
    expect(lines.join("\n")).not.toContain("Do not print this agent prose");
  });

  it("claims tasks, invokes the implementer with task metadata, and advances successful work to waiting_for_merge", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-run-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-70",
        title: "Implement me",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const invocations: HubImplementTaskInput[] = [];
    const implementer: HubFlowImplementer = async (input) => {
      invocations.push(input);
      return {
        outcome: "success",
        commits: [{ sha: "abc123" }],
        completionSignal: "<promise>COMPLETE</promise>",
      };
    };

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "abc",
    );
    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer,
      runMergePhase: false,
    });

    expect(result.selectedTaskIds).toEqual(["bd-70"]);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      taskId: "bd-70",
      title: "Implement me",
      branch: "archloop/bd-70-implement-me",
      flowId: "no-review",
    });
    expectBundledHubFlowPrompt(
      invocations[0]!.promptFile,
      "hub-flows/no-review/implement-prompt.md",
    );

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("in_progress");
    expect(finalState[0]?.labels).toContain("waiting-for-merge");
    expect(finalState[0]?.labels).not.toContain("implementing");
    expect(finalState[0]?.labels).not.toContain("ready-for-agent");
    expect(finalState[0]?.metadata.hubStatus).toBe("waiting_for_merge");
    expect(result.results[0]).toMatchObject({
      taskId: "bd-70",
      outcome: "implemented",
      hubStatus: "waiting_for_merge",
      commitCount: 1,
    });

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      [
        "task_claimed",
        "task_implementation_started",
        "task_implementation_succeeded",
        "task_status_advanced",
      ],
    );
    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "bd-70: implemented -> waiting_for_merge",
    );
  });

  it.each([
    {
      title: "creates and passes a generic fallback contract when none exists",
      configureContract: undefined as
        | ((input: {
            readonly repoDir: string;
            readonly hubProjectDir: string;
          }) => void)
        | undefined,
      expectedProfile: "generic",
      expectedFallback: true,
      expectedVerifySnippet: "customize this prompt section",
    },
    {
      title: "passes a configured Node contract through to the implementer",
      configureContract: async ({
        repoDir,
        hubProjectDir,
      }: {
        readonly repoDir: string;
        readonly hubProjectDir: string;
      }) => {
        await writeFile(
          join(repoDir, "package.json"),
          JSON.stringify(
            { scripts: { test: "vitest", typecheck: "tsc -p ." } },
            null,
            2,
          ),
        );
        return configureHubProjectDevelopmentContract({
          repoRoot: repoDir,
          hubProjectDir,
          projectProfileName: "node",
          now: new Date("2026-06-27T10:00:00.000Z"),
        });
      },
      expectedProfile: "node",
      expectedFallback: false,
      expectedVerifySnippet: "npm run typecheck",
    },
  ] as const)(
    "$title",
    async ({
      configureContract,
      expectedProfile,
      expectedFallback,
      expectedVerifySnippet,
    }) => {
      const repoDir = await mkdtemp(
        join(tmpdir(), "hub-flow-contract-prompt-"),
      );
      await initRepo(repoDir);
      await commitFile(repoDir, "hello.txt", "hello", "initial commit");

      const hubProjectDir = join(
        repoDir,
        "data",
        "archloop",
        "hub",
        "projects",
        "contract-prompt",
      );
      await configureContract?.({ repoDir, hubProjectDir });

      const stateFile = join(repoDir, "bd-state.json");
      const { env } = await writeMockBd(repoDir, stateFile, [
        {
          id: "bd-contract",
          title: "Contract guided task",
          status: "open",
          labels: ["ready-for-agent"],
          metadata: {},
        },
      ]);

      const invocations: HubImplementTaskInput[] = [];
      const result = await runHubFlow({
        flowId: "no-review",
        cwd: repoDir,
        hubProjectDir,
        env,
        implementer: async (input) => {
          invocations.push(input);
          return {
            outcome: "success",
            commits: [{ sha: "abc123" }],
            completionSignal: "<promise>COMPLETE</promise>",
          };
        },
        runMergePhase: false,
      });

      expect(result.projectDevelopmentContractCreatedGenericFallback).toBe(
        expectedFallback,
      );
      expect(invocations).toHaveLength(1);
      expect(
        invocations[0]?.projectDevelopmentContract.contract.projectProfile,
      ).toBe(expectedProfile);
      expect(
        invocations[0]?.projectDevelopmentContract.contract.verify.join("\n"),
      ).toContain(expectedVerifySnippet);
      expect(
        invocations[0]?.projectDevelopmentContract.contract.setup.join("\n"),
      ).toContain(
        expectedProfile === "generic"
          ? "no-op baseline"
          : "Node bootstrap guidance",
      );
      expect(
        invocations[0]?.projectDevelopmentContract.contract.context.join("\n"),
      ).toContain(
        expectedProfile === "generic"
          ? "Generic profile selected"
          : "Selected project profile remains authoritative",
      );
      if (expectedFallback) {
        expect(formatHubFlowResultLines(result).join("\n")).toContain(
          "created generic fallback",
        );
        expect(formatHubFlowResultLines(result).join("\n")).toContain(
          "archloop project configure --project-profile <generic|node|python|cpp>",
        );
      }
    },
  );

  it("treats completion with existing unmerged branch work as implemented even when the rerun creates no new commits", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-rerun-work-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-rerun",
        title: "Rerun existing work",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "rerun-work",
    );
    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async () => ({
        outcome: "success",
        commits: [],
        completionSignal: "<promise>COMPLETE</promise>",
        branchHasUnmergedWork: true,
      }),
      runMergePhase: false,
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.labels).toContain("waiting-for-merge");
    expect(finalState[0]?.metadata.hubStatus).toBe("waiting_for_merge");
    expect(result.results[0]).toMatchObject({
      taskId: "bd-rerun",
      outcome: "implemented",
      hubStatus: "waiting_for_merge",
      commitCount: 0,
      implementationWork: "existing_unmerged_work",
    });

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents).toContainEqual(
      expect.objectContaining({
        type: "task_implementation_succeeded",
        taskId: "bd-rerun",
        status: "waiting_for_merge",
        commitCount: 0,
        branchHasUnmergedWork: true,
        implementationWork: "existing_unmerged_work",
      }),
    );
    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "bd-rerun: implemented -> waiting_for_merge (existing unmerged work)",
    );
  });

  it("treats a completion signal on an already-merged task as done instead of agent_failed (arch-d0c)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-already-merged-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-merged-rerun";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title: "Already merged rerun",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "already-merged",
    );

    // The implementer recognizes the already-merged re-run (a prior
    // merge_succeeded event plus a completion signal with no new branch work)
    // and reports success with alreadyMerged set. The per-task driver then
    // closes the task as done directly instead of advancing it to
    // waiting_for_merge (where the merge phase would strand a branch with no
    // unmerged work) or marking it agent_failed. The alreadyMerged detection
    // itself is exercised by the createHubFlowRunImplementer unit test below.
    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async () => ({
        outcome: "success",
        commits: [],
        completionSignal: "<promise>COMPLETE</promise>",
        branchHasUnmergedWork: false,
        alreadyMerged: true,
      }),
      runMergePhase: false,
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    // The task reaches done, not failed — the work was already merged.
    expect(finalState[0]?.labels).toContain("done");
    expect(finalState[0]?.metadata.hubStatus).toBe("done");
    expect(finalState[0]?.metadata.failureReason).toBeUndefined();
    expect(result.results[0]).toMatchObject({
      taskId,
      outcome: "implemented",
      hubStatus: "done",
      commitCount: 0,
    });

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    // The run records success/done, never an implementation failure.
    expect(taskEvents).not.toContainEqual(
      expect.objectContaining({
        type: "task_implementation_failed",
        taskId,
      }),
    );
    expect(taskEvents).toContainEqual(
      expect.objectContaining({ type: "task_closed", taskId, status: "done" }),
    );
  });

  it("marks agent failures as failed with agent_failed", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-agent-fail-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-fail",
        title: "Agent fail task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "agent-fail",
    );

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async () => ({
        outcome: "agent_failed",
        commits: [],
        message: "agent exited non-zero",
      }),
      runMergePhase: false,
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("open");
    expect(finalState[0]?.labels).toContain("failed");
    expect(finalState[0]?.metadata.failureReason).toBe("agent_failed");
    expect(result.results[0]).toMatchObject({
      outcome: "agent_failed",
      hubStatus: "failed",
      failureReason: "agent_failed",
      failureStage: "implementation",
      diagnosticSummary: "agent exited non-zero",
      logPath: join(result.runDir, "logs", "bd-fail.log"),
    });
  });

  it("marks sandbox failures as failed with sandbox_failed", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-sandbox-fail-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-sandbox",
        title: "Sandbox fail task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "sandbox-fail",
    );

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async () => {
        throw new Error("sandbox start failed");
      },
      runMergePhase: false,
    });

    expect(result.results[0]).toMatchObject({
      outcome: "sandbox_failed",
      hubStatus: "failed",
      failureReason: "sandbox_failed",
    });
  });
});

describe("with-review Hub flow execution", () => {
  it("reports a no-op when no ready tasks or resumable batches exist", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-noop-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-human",
        title: "Needs a human",
        status: "open",
        labels: ["ready-for-human"],
        metadata: { hubStatus: "ready_for_human" },
      },
    ]);
    const hubProjectDir = await mkdtemp(join(tmpdir(), "hub-flow-noop-data-"));
    let implementCalls = 0;
    let reviewCalls = 0;

    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async () => {
        implementCalls += 1;
        throw new Error("implementer should not run without ready tasks");
      },
      reviewer: async () => {
        reviewCalls += 1;
        throw new Error("reviewer should not run without ready tasks");
      },
      merger: async () => ({ outcome: "success" }),
      verifier: async () => ({ outcome: "success" }),
    });

    expect(result.mode).toBe("no_ready");
    expect(result.selectedTaskIds).toEqual([]);
    expect(result.resumedBatchId).toBeUndefined();
    expect(result.completedBatchCount).toBe(0);
    expect(result.completedTaskCount).toBe(0);
    expect(result.stopReason).toBe("no_ready_tasks");
    expect(result.batchResults).toEqual([]);
    expect(result.mergeResult).toBeUndefined();
    expect(implementCalls).toBe(0);
    expect(reviewCalls).toBe(0);

    const summary = formatHubFlowResultLines(result).join("\n");
    expect(summary).toContain("Completed batches: 0");
    expect(summary).toContain("Completed tasks: 0");
    expect(summary).toContain("Stop reason: no_ready_tasks");
    expect(summary).toContain("No ready tasks selected.");
    expect(summary).toContain(
      "No unfinished with-review batch found to resume.",
    );

    const runEvents = await readJsonl(
      join(result.runDir, "events", "run.jsonl"),
    );
    expect(runEvents).toContainEqual(
      expect.objectContaining({
        type: "run_completed",
        runId: result.runId,
        stopReason: "no_ready_tasks",
        completedBatchCount: 0,
        completedTaskCount: 0,
      }),
    );
  });

  it("warns when the host worktree is dirty at flow start", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-dirty-warning-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, ".beads", "issues.jsonl");
    const { env } = await writeMockBd(
      repoDir,
      stateFile,
      [
        {
          id: "bd-human",
          title: "Needs a human",
          status: "open",
          labels: ["ready-for-human"],
          metadata: { hubStatus: "ready_for_human" },
        },
      ],
      { argsFile: join(repoDir, ".beads", "bd-args.txt") },
    );
    await execAsync("git add bin .beads", { cwd: repoDir });
    await execAsync('git commit -m "add mock task store"', { cwd: repoDir });
    await writeFile(join(repoDir, "wip.txt"), "local notes\n");

    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
      hubProjectDir: await mkdtemp(join(tmpdir(), "hub-flow-dirty-data-")),
      env,
      implementer: async () => {
        throw new Error("implementer should not run without ready tasks");
      },
      reviewer: async () => {
        throw new Error("reviewer should not run without ready tasks");
      },
      merger: async () => ({ outcome: "success" }),
      verifier: async () => ({ outcome: "success" }),
    });

    expect(result.worktreeWarning).toMatchObject({
      dirtySourceFiles: ["wip.txt"],
    });
    const summary = formatHubFlowResultLines(result).join("\n");
    expect(summary).toContain(
      "Worktree warning: dirty source files detected before flow start: wip.txt",
    );
    expect(summary).toContain("commit, stash, or discard");
    expect(summary).toContain("rerun the same flow");
  });

  it("resumes an unfinished waiting_for_merge batch when no ready tasks are selected", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-resume-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const oldRunId = "run-old-resume";
    const oldBatchId = "batch-old-resume";
    const branch = "archloop/bd-resume-resume-old-work";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-resume",
        title: "Resume old work",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: oldRunId,
            batchId: oldBatchId,
            branch,
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);
    await execAsync("git add bin bd-state.json bd-args.txt", { cwd: repoDir });
    await execAsync('git commit -m "add mock task store"', { cwd: repoDir });

    const hubProjectDir = await mkdtemp(
      join(tmpdir(), "hub-flow-resume-data-"),
    );
    const oldContext = createHubRunContext({
      cwd: repoDir,
      hubProjectDir,
      branch: "flow/with-review",
      runId: oldRunId,
      batchId: oldBatchId,
    });
    appendHubBatchEvent(oldContext.runDir, {
      type: "batch_planned",
      runId: oldRunId,
      batchId: oldBatchId,
      flowId: "with-review",
      createdAt: "2026-06-12T10:00:00Z",
      taskIds: ["bd-resume"],
    });

    await execAsync(`git checkout -b ${branch}`, { cwd: repoDir });
    await commitFile(repoDir, "resume.txt", "resume", "resume old work");
    await execAsync("git checkout main", { cwd: repoDir });

    const mergedTaskIds: string[] = [];
    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async () => {
        throw new Error("implementer should not run during resume");
      },
      reviewer: async () => {
        throw new Error("reviewer should not run during resume");
      },
      merger: async (input) => {
        mergedTaskIds.push(input.taskId);
        return { outcome: "success" };
      },
      verifier: async () => ({ outcome: "success" }),
    });

    expect(result.selectedTaskIds).toEqual([]);
    expect(result.batchId).toBe(oldBatchId);
    expect(result.resumedBatchId).toBe(oldBatchId);
    expect(result.stopReason).toBe("no_ready_tasks");
    expect(result.completedBatchCount).toBe(1);
    expect(result.completedTaskCount).toBe(1);
    expect(result.batchResults).toHaveLength(1);
    expect(result.batchResults[0]).toMatchObject({
      batchId: oldBatchId,
      selectedTaskIds: ["bd-resume"],
      batchStatus: "completed",
    });
    expect(result.mergeResult).toMatchObject({
      selectedTaskIds: ["bd-resume"],
      batchStatus: "done",
    });
    expect(mergedTaskIds).toEqual(["bd-resume"]);
    expect(result.runDir).not.toBe(oldContext.runDir);

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const batchIds = new Set(
      batchEvents
        .map((event) => (event as { batchId?: string }).batchId)
        .filter((batchId): batchId is string => batchId !== undefined),
    );
    expect(batchIds).toContain(oldBatchId);
    expect(batchIds.size).toBe(2);
    expect(batchEvents).toContainEqual(
      expect.objectContaining({
        type: "batch_merge_selection",
        runId: result.runId,
        batchId: oldBatchId,
        selectedTaskIds: ["bd-resume"],
      }),
    );
    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      `Resumed batch id: ${oldBatchId}`,
    );

    const runEvents = await readJsonl(
      join(result.runDir, "events", "run.jsonl"),
    );
    expect(runEvents).toContainEqual(
      expect.objectContaining({
        type: "run_completed",
        runId: result.runId,
        stopReason: "no_ready_tasks",
        completedBatchCount: 1,
        completedTaskCount: 1,
      }),
    );
  });

  it("resumes merge-ready batch before claiming ready tasks when both exist", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-ready-conflict-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const oldRunId = "run-old-conflict";
    const oldBatchId = "batch-old-conflict";
    const oldBranch = "archloop/bd-old-conflict-old-ready-work";
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    const stateFile = join(repoDir, ".beads", "issues.jsonl");
    const { env } = await writeMockBd(
      repoDir,
      stateFile,
      [
        {
          id: "bd-ready",
          title: "Ready task",
          status: "open",
          labels: ["ready-for-agent"],
          metadata: {},
        },
        {
          id: "bd-old-conflict",
          title: "Old ready work",
          status: "in_progress",
          labels: ["waiting-for-merge"],
          metadata: {
            hubStatus: "waiting_for_merge",
            claim: {
              runId: oldRunId,
              batchId: oldBatchId,
              branch: oldBranch,
              claimedAt: "2026-06-12T10:00:00Z",
            },
          },
        },
      ],
      { argsFile: join(repoDir, ".beads", "bd-args.txt") },
    );
    await execAsync("git add bin .beads", { cwd: repoDir });
    await execAsync('git commit -m "add mock task store"', { cwd: repoDir });

    const hubProjectDir = await mkdtemp(
      join(tmpdir(), "hub-flow-conflict-data-"),
    );
    const oldContext = createHubRunContext({
      cwd: repoDir,
      hubProjectDir,
      branch: "flow/with-review",
      runId: oldRunId,
      batchId: oldBatchId,
    });
    appendHubBatchEvent(oldContext.runDir, {
      type: "batch_planned",
      runId: oldRunId,
      batchId: oldBatchId,
      flowId: "with-review",
      createdAt: "2026-06-12T10:00:00Z",
      taskIds: ["bd-old-conflict"],
    });

    await execAsync(`git checkout -b ${oldBranch}`, { cwd: repoDir });
    await commitFile(repoDir, "old-work.txt", "old", "old conflict work");
    await execAsync("git checkout main", { cwd: repoDir });

    let implementCalls = 0;
    let reviewCalls = 0;
    const mergedTaskIds: string[] = [];
    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async (input) => {
        implementCalls += 1;
        await execAsync(`git checkout -B "${input.branch}" main`, {
          cwd: repoDir,
        });
        await writeFile(join(repoDir, `${input.taskId}.txt`), input.taskId);
        await execAsync(`git add "${input.taskId}.txt"`, { cwd: repoDir });
        await execAsync(`git commit -m "implement ${input.taskId}"`, {
          cwd: repoDir,
        });
        await execAsync("git checkout main", { cwd: repoDir });
        return {
          outcome: "success",
          commits: [{ sha: `commit-${input.taskId}` }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      reviewer: async () => {
        reviewCalls += 1;
        return {
          outcome: "success",
          commits: [],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      merger: async (input) => {
        mergedTaskIds.push(input.taskId);
        return { outcome: "success" };
      },
      verifier: async () => ({ outcome: "success" }),
    });

    expect(result.mode).toBe("resumed_batch");
    expect(result.selectedTaskIds).toEqual(["bd-ready"]);
    expect(result.resumedBatchId).toBe(oldBatchId);
    expect(result.batchId).toBe(oldBatchId);
    expect(result.unfinishedBatchIds).toEqual([oldBatchId]);
    expect(result.batchResults).toHaveLength(2);
    expect(result.batchResults[1]).toMatchObject({
      selectedTaskIds: ["bd-ready"],
      batchStatus: "completed",
    });
    expect(result.mergeResult).toMatchObject({
      selectedTaskIds: ["bd-ready"],
      batchStatus: "done",
    });
    expect(result.completedBatchCount).toBe(2);
    expect(result.completedTaskCount).toBe(2);
    expect(mergedTaskIds).toEqual(["bd-old-conflict", "bd-ready"]);
    expect(implementCalls).toBe(1);
    expect(reviewCalls).toBe(1);

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(
      finalState.find((task) => task.id === "bd-old-conflict")?.status,
    ).toBe("closed");
    expect(finalState.find((task) => task.id === "bd-ready")?.status).toBe(
      "closed",
    );

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    const readyBatchId = result.batchResults[1]!.batchId;
    const readyReviewSucceededAt = taskEvents.find(
      (event) =>
        (event as { type?: string; taskId?: string }).type ===
          "task_review_succeeded" &&
        (event as { type?: string; taskId?: string }).taskId === "bd-ready",
    ) as { createdAt?: string } | undefined;
    const readyMergeSelectionAt = batchEvents.find(
      (event) =>
        (event as { type?: string; batchId?: string }).type ===
          "batch_merge_selection" &&
        (event as { type?: string; batchId?: string }).batchId === readyBatchId,
    ) as
      | { createdAt?: string; selectedTaskIds?: readonly string[] }
      | undefined;
    expect(readyMergeSelectionAt?.selectedTaskIds).toEqual(["bd-ready"]);
    expect(readyReviewSucceededAt?.createdAt).toBeDefined();
    expect(readyMergeSelectionAt?.createdAt).toBeDefined();
    expect(
      readyReviewSucceededAt!.createdAt! <= readyMergeSelectionAt!.createdAt!,
    ).toBe(true);

    const summary = formatHubFlowResultLines(result).join("\n");
    expect(summary).toContain(`Mode: resumed_batch`);
    expect(summary).toContain(`Resumed batch id: ${oldBatchId}`);
    expect(summary).not.toContain("Unfinished batches not resumed");
  });

  it("stops after a failed resumed merge-ready batch without claiming fresh ready work", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-resume-fail-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const oldRunId = "run-existing";
    const oldBatchId = "batch-existing";
    const oldBranch = "archloop/bd-old-conflict-other";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-old-conflict",
        title: "Old conflict task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          claim: {
            runId: oldRunId,
            batchId: oldBatchId,
            branch: oldBranch,
            claimedAt: "2026-06-22T09:00:00.000Z",
          },
          hubStatus: "waiting_for_merge",
        },
      },
      {
        id: "bd-fresh-ready",
        title: "Fresh ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const oldContext = createHubRunContext({
      cwd: repoDir,
      hubProjectDir: join(
        repoDir,
        "data",
        "archloop",
        "hub",
        "projects",
        "resume-fail",
      ),
      branch: "flow/no-review",
      runId: oldRunId,
      batchId: oldBatchId,
    });
    appendHubBatchEvent(oldContext.runDir, {
      type: "batch_planned",
      runId: oldRunId,
      batchId: oldBatchId,
      flowId: "no-review",
      createdAt: "2026-06-22T09:00:00Z",
      taskIds: ["bd-old-conflict"],
    });

    await execAsync(`git checkout -b ${oldBranch}`, { cwd: repoDir });
    await commitFile(repoDir, "old-work.txt", "old", "old conflict work");
    await execAsync("git checkout main", { cwd: repoDir });

    let implementCalled = false;
    let reviewCalled = false;
    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir: join(
        repoDir,
        "data",
        "archloop",
        "hub",
        "projects",
        "resume-fail",
      ),
      env,
      implementer: async () => {
        implementCalled = true;
        return {
          outcome: "success",
          commits: [{ sha: "abc123" }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      reviewer: async () => {
        reviewCalled = true;
        return {
          outcome: "success",
          commits: [{ sha: "def456" }],
          completionSignal: "<promise>COMPLETE</promise>",
        };
      },
      merger: async () => ({ outcome: "failed" }),
      verifier: async () => ({ outcome: "success" }),
    });

    expect(result.mode).toBe("resumed_batch");
    expect(result.resumedBatchId).toBe(oldBatchId);
    expect(result.unfinishedBatchIds).toEqual([oldBatchId]);
    expect(result.stopReason).toBe("batch_failed");
    expect(result.completedBatchCount).toBe(0);
    expect(result.completedTaskCount).toBe(0);
    expect(result.selectedTaskIds).toEqual([]);
    expect(result.results).toEqual([]);
    expect(result.batchResults).toHaveLength(1);
    expect(result.batchResults[0]).toMatchObject({
      batchId: oldBatchId,
      batchStatus: "failed",
    });
    expect(result.mergeResult).toMatchObject({
      selectedTaskIds: ["bd-old-conflict"],
      batchStatus: "partial_failed",
      results: [
        expect.objectContaining({
          taskId: "bd-old-conflict",
          outcome: "merge_failed",
        }),
      ],
    });
    expect(implementCalled).toBe(false);
    expect(reviewCalled).toBe(false);

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(
      finalState.find((task) => task.id === "bd-fresh-ready")?.status,
    ).toBe("open");
    expect(
      finalState.find((task) => task.id === "bd-fresh-ready")?.labels,
    ).toContain("ready-for-agent");

    const summary = formatHubFlowResultLines(result).join("\n");
    expect(summary).toContain("Stop reason: batch_failed");
    expect(summary).toContain(`Resumed batch id: ${oldBatchId}`);
  });

  it("advances successful work through reviewing to waiting_for_merge", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-review-run-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-71",
        title: "Review me",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const implementInvocations: HubImplementTaskInput[] = [];
    const reviewInvocations: HubReviewTaskInput[] = [];
    const implementer: HubFlowImplementer = async (input) => {
      implementInvocations.push(input);
      return {
        outcome: "success",
        commits: [{ sha: "abc123" }],
        completionSignal: "<promise>COMPLETE</promise>",
      };
    };
    const reviewer: HubFlowReviewer = async (input) => {
      reviewInvocations.push(input);
      return {
        outcome: "success",
        commits: [{ sha: "def456" }],
        completionSignal: "<promise>COMPLETE</promise>",
      };
    };
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "review-run",
    );
    const observedEventTypes: string[] = [];

    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer,
      reviewer,
      runMergePhase: false,
      onEvent: (event) => {
        observedEventTypes.push(event.type);
      },
    });

    expect(result.selectedTaskIds).toEqual(["bd-71"]);
    expect(implementInvocations).toHaveLength(1);
    expect(reviewInvocations).toHaveLength(1);
    expect(observedEventTypes).toEqual(
      expect.arrayContaining([
        "task_implementation_started",
        "task_review_started",
        "task_review_succeeded",
        "run_completed",
      ]),
    );
    expect(reviewInvocations[0]).toMatchObject({
      taskId: "bd-71",
      title: "Review me",
      branch: "archloop/bd-71-review-me",
      flowId: "with-review",
      implementCommitCount: 1,
    });
    expect(reviewInvocations[0]?.promptFile).toContain(
      "hub-flows/with-review/review-prompt.md",
    );

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("in_progress");
    expect(finalState[0]?.labels).toContain("waiting-for-merge");
    expect(finalState[0]?.labels).not.toContain("reviewing");
    expect(finalState[0]?.labels).not.toContain("ready-for-agent");
    expect(finalState[0]?.metadata.hubStatus).toBe("waiting_for_merge");
    expect(result.results[0]).toMatchObject({
      taskId: "bd-71",
      outcome: "reviewed",
      hubStatus: "waiting_for_merge",
      commitCount: 1,
    });

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      [
        "task_claimed",
        "task_implementation_started",
        "task_implementation_succeeded",
        "task_status_advanced",
        "task_review_started",
        "task_review_succeeded",
        "task_status_advanced",
      ],
    );
    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "bd-71: reviewed -> waiting_for_merge",
    );
  });

  it("clears stale lifecycle labels and metadata when review advances to waiting_for_merge", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-review-stale-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-stale-review",
        title: "Review with stale status",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const reviewer: HubFlowReviewer = async () => {
      const state = JSON.parse(
        await readFile(stateFile, "utf-8"),
      ) as MockBeadsTask[];
      const task = state.find((entry) => entry.id === "bd-stale-review")!;
      task.labels = [...task.labels, "failed", "implementing"];
      task.metadata = {
        ...task.metadata,
        failed: true,
        failureReason: "agent_failed",
        blocked_reason: "stale dependency note",
      };
      await writeFile(stateFile, JSON.stringify(state, null, 2));

      return {
        outcome: "success",
        commits: [],
        completionSignal: "<promise>COMPLETE</promise>",
      };
    };

    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
      hubProjectDir: join(
        repoDir,
        "data",
        "archloop",
        "hub",
        "projects",
        "review-stale",
      ),
      env,
      implementer: async () => ({
        outcome: "success",
        commits: [{ sha: "abc123" }],
        completionSignal: "<promise>COMPLETE</promise>",
      }),
      reviewer,
      runMergePhase: false,
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(result.results[0]).toMatchObject({
      taskId: "bd-stale-review",
      outcome: "reviewed",
      hubStatus: "waiting_for_merge",
    });
    expect(finalState[0]?.labels).toContain("waiting-for-merge");
    expect(finalState[0]?.labels).not.toContain("failed");
    expect(finalState[0]?.labels).not.toContain("implementing");
    expect(finalState[0]?.metadata.hubStatus).toBe("waiting_for_merge");
    expect(finalState[0]?.metadata.failed).toBeUndefined();
    expect(finalState[0]?.metadata.failureReason).toBeUndefined();
    expect(finalState[0]?.metadata.blocked_reason).toBeUndefined();
  });

  it("marks review failures as failed with agent_failed", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-review-fail-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-review-fail",
        title: "Review fail task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);
    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "review-fail",
    );

    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer: async () => ({
        outcome: "success",
        commits: [{ sha: "abc123" }],
        completionSignal: "<promise>COMPLETE</promise>",
      }),
      reviewer: async () => ({
        outcome: "agent_failed",
        commits: [],
        message: "reviewer exited non-zero",
      }),
      runMergePhase: false,
    });

    expect(result.results[0]).toMatchObject({
      outcome: "agent_failed",
      hubStatus: "failed",
      failureReason: "agent_failed",
      failureStage: "review",
      diagnosticSummary: "reviewer exited non-zero",
      logPath: join(result.runDir, "logs", "bd-review-fail-review.log"),
    });
    expect(result.stopReason).toBe("batch_failed");
    expect(result.completedBatchCount).toBe(0);
    expect(result.completedTaskCount).toBe(0);
    expect(result.batchResults).toHaveLength(1);
    expect(result.batchResults[0]).toMatchObject({
      batchId: result.batchId,
      batchStatus: "failed",
    });

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      [
        "task_claimed",
        "task_implementation_started",
        "task_implementation_succeeded",
        "task_status_advanced",
        "task_review_started",
        "task_review_failed",
        "task_status_advanced",
      ],
    );
  });

  it("createHubFlowRunImplementer uses the configured implementation role provider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-preflight-"));
    const implementer = createHubFlowRunImplementer({
      cwd,
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-06-27T10:00:00.000Z"),
      });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("XDG_DATA_HOME", join(cwd, "xdg-data"));
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch: "archloop/bd-1-test-task",
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir: cwd,
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.message).toContain("Codex agent credentials");
      expect(result.message).toContain("OPENAI_KEY");
      expect(result.message).not.toContain("Cursor agent credentials");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer forwards the supplied env and development contract to the run invocation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-implementer-run-"));
    await initRepo(cwd);
    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-06-27T10:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockResolvedValue({
      completionSignal: "<promise>COMPLETE</promise>",
      commits: [{ sha: "abc123" }],
      branch: "archloop/bd-1-test-task",
      iterations: [],
      stdout: "",
    });
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: { OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });
    const abortController = new AbortController();

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch: "archloop/bd-1-test-task",
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir: cwd,
        projectDevelopmentContract,
        signal: abortController.signal,
      });

      expect(result.outcome).toBe("success");
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy.mock.calls[0]?.[0].signal).toBe(abortController.signal);
      expect(runSpy.mock.calls[0]?.[0].promptArgs).toMatchObject({
        TASK_ID: "bd-1",
        PROJECT_PROFILE: "generic",
        PROJECT_DEVELOPMENT_CONTRACT_PATH:
          projectDevelopmentContract.contractPath,
      });
      expect(
        runSpy.mock.calls[0]?.[0].promptArgs
          ?.PROJECT_DEVELOPMENT_CONTRACT_SETUP,
      ).toContain("no-op baseline");
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer forwards idleTimeoutSeconds to run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-implementer-idle-"));
    await initRepo(cwd);
    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-06-27T10:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockResolvedValue({
      completionSignal: "<promise>COMPLETE</promise>",
      commits: [{ sha: "abc123" }],
      branch: "archloop/bd-1-test-task",
      iterations: [],
      stdout: "",
    });
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: { OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
      idleTimeoutSeconds: 1200,
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch: "archloop/bd-1-test-task",
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir: cwd,
        projectDevelopmentContract,
      });

      expect(runSpy.mock.calls[0]?.[0].idleTimeoutSeconds).toBe(1200);
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("parseHubFlowIdleTimeoutSeconds accepts positive integer seconds", () => {
    expect(parseHubFlowIdleTimeoutSeconds("600")).toBe(600);
    expect(parseHubFlowIdleTimeoutSeconds(" 1200 ")).toBe(1200);
  });

  it("parseHubFlowIdleTimeoutSeconds rejects non-positive and non-integer values", () => {
    expect(() => parseHubFlowIdleTimeoutSeconds("0")).toThrow(HubFlowError);
    expect(() => parseHubFlowIdleTimeoutSeconds("-1")).toThrow(HubFlowError);
    expect(() => parseHubFlowIdleTimeoutSeconds("1.5")).toThrow(HubFlowError);
    expect(() => parseHubFlowIdleTimeoutSeconds("abc")).toThrow(HubFlowError);
  });

  it("createHubFlowRunImplementer marks missing completion signal as agent_failed even with branch commits", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "hub-flow-implementer-no-complete-"),
    );
    await initRepo(cwd);
    await commitFile(cwd, "hello.txt", "hello", "initial commit");
    const branch = "archloop/bd-1-test-task";
    await execAsync(`git checkout -b "${branch}"`, { cwd });
    await commitFile(cwd, "work.txt", "work", "RALPH: partial");
    await execAsync("git checkout main", { cwd });

    const { stdout: commitList } = await execAsync(
      `git rev-list --reverse HEAD..${branch}`,
      { cwd },
    );
    const expectedShas = commitList
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    const runDir = join(cwd, "run");
    await mkdir(join(runDir, "logs"), { recursive: true });
    await writeFile(
      join(runDir, "logs", "bd-1.log"),
      "agent still working; no completion signal yet\n",
      "utf-8",
    );

    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-21T12:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockRejectedValue(
      new AgentError({
        message:
          "cursor exited with code 1:\nRetriableError: Connection stalled",
      }),
    );
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: {
        OPENAI_KEY: "test-openai-key",
        ARCHLOOP_PROVIDER_RETRY_ATTEMPTS: "1",
      },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch,
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir,
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.completionSignal).toBeUndefined();
      expect(result.commits.map((commit) => commit.sha)).toEqual(expectedShas);
      expect(result.message).toContain("cursor exited with code 1");
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer marks COMPLETE without commits or unmerged work as agent_failed", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "hub-flow-implementer-empty-complete-"),
    );
    await initRepo(cwd);
    await commitFile(cwd, "hello.txt", "hello", "initial commit");
    const branch = "archloop/bd-1-test-task";
    await execAsync(`git branch "${branch}"`, { cwd });

    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-21T12:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockResolvedValue({
      completionSignal: "<promise>COMPLETE</promise>",
      commits: [],
      branch,
      iterations: [],
      stdout: "<promise>COMPLETE</promise>",
    });
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: { OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
      resolvePriorMergedCompletion: async () => false,
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch,
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir: cwd,
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
      expect(result.commits).toEqual([]);
      expect(result.message).toBe("Implementer completed without commits");
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer treats COMPLETE without commits as alreadyMerged success when a prior merge event exists (arch-d0c)", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "hub-flow-implementer-already-merged-"),
    );
    await initRepo(cwd);
    await commitFile(cwd, "hello.txt", "hello", "initial commit");
    const branch = "archloop/bd-1-test-task";
    // The branch sits at HEAD with no new commits — the already-merged shape:
    // the implementation is already in HEAD, so a faithful re-run produces
    // zero new commits.
    await execAsync(`git branch "${branch}"`, { cwd });

    // Lay out a prior Hub run dir under a controlled XDG_DATA_HOME so the
    // default prior-merge resolver scans it. The project id is
    // sha256(repoRoot)[:12], matching resolveHubProjectDir.
    const { createHash } = await import("node:crypto");
    const projectId = createHash("sha256")
      .update(cwd)
      .digest("hex")
      .slice(0, 12);
    const priorRunDir = join(
      cwd,
      ".test-xdg-data",
      "archloop",
      "hub",
      "projects",
      projectId,
      "runs",
      "run-prior-merged",
    );
    await mkdir(join(priorRunDir, "events"), { recursive: true });
    const priorEvent = (type: string, status: string) =>
      JSON.stringify({
        type,
        runId: "run-prior-merged",
        batchId: "batch-prior",
        taskId: "bd-1",
        branch,
        createdAt: "2026-07-23T09:39:32.000Z",
        status,
        commitCount: 1,
      });
    await writeFile(
      join(priorRunDir, "events", "task.jsonl"),
      [
        priorEvent("task_implementation_succeeded", "waiting_for_merge"),
        priorEvent("merge_succeeded", "merging"),
        priorEvent("task_closed", "done"),
      ].join("\n") + "\n",
      "utf-8",
    );

    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-21T12:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockResolvedValue({
      completionSignal: "<promise>COMPLETE</promise>",
      commits: [],
      branch,
      iterations: [],
      stdout: "<promise>COMPLETE</promise>",
    });
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: { OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch,
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir: cwd,
        hubProjectDir: join(
          cwd,
          ".test-xdg-data",
          "archloop",
          "hub",
          "projects",
          projectId,
        ),
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("success");
      expect(result.alreadyMerged).toBe(true);
      expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
      expect(result.commits).toEqual([]);
      expect(result.branchHasUnmergedWork).toBe(false);
      expect(result.message).toContain("already merged");
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer treats COMPLETE + branch commits as success despite non-zero exit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-implementer-observe-"));
    await initRepo(cwd);
    await commitFile(cwd, "hello.txt", "hello", "initial commit");
    const branch = "archloop/bd-1-test-task";
    await execAsync(`git checkout -b "${branch}"`, { cwd });
    await commitFile(cwd, "work-a.txt", "a", "RALPH: first");
    await commitFile(cwd, "work-b.txt", "b", "RALPH: second");
    await execAsync("git checkout main", { cwd });

    const { stdout: commitList } = await execAsync(
      `git rev-list --reverse HEAD..${branch}`,
      { cwd },
    );
    const expectedShas = commitList
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    const runDir = join(cwd, "run");
    await mkdir(join(runDir, "logs"), { recursive: true });
    await writeFile(
      join(runDir, "logs", "bd-1.log"),
      "agent work...\n<promise>COMPLETE</promise>\n",
      "utf-8",
    );

    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-21T12:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockRejectedValue(
      new AgentError({
        message:
          "cursor exited with code 1:\nRetriableError: Connection stalled",
      }),
    );
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: { OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch,
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir,
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("success");
      expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
      expect(result.commits.map((commit) => commit.sha)).toEqual(expectedShas);
      expect(result.commits).toHaveLength(2);
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer retries on provider transient without completion signal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-implementer-retry-"));
    await initRepo(cwd);
    await commitFile(cwd, "hello.txt", "hello", "initial commit");
    const branch = "archloop/bd-1-test-task";
    await execAsync(`git checkout -b "${branch}"`, { cwd });
    await commitFile(cwd, "work.txt", "work", "RALPH: work");
    await execAsync("git checkout main", { cwd });

    const runDir = join(cwd, "run");
    await mkdir(join(runDir, "logs"), { recursive: true });
    await writeFile(
      join(runDir, "logs", "bd-1.log"),
      "agent still working; no completion signal yet\n",
      "utf-8",
    );

    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-22T00:00:00.000Z"),
      });
    const runSpy = vi
      .spyOn(runModule, "run")
      .mockRejectedValueOnce(
        new AgentError({
          message:
            "cursor exited with code 1:\nRetriableError: Connection stalled",
        }),
      )
      .mockResolvedValueOnce({
        completionSignal: "<promise>COMPLETE</promise>",
        commits: [{ sha: "abc123" }],
        branch,
        iterations: [],
        stdout: "<promise>COMPLETE</promise>",
      });
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: {
        OPENAI_KEY: "test-openai-key",
        ARCHLOOP_PROVIDER_RETRY_ATTEMPTS: "3",
        ARCHLOOP_PROVIDER_RETRY_BASE_MS: "0",
      },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch,
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir,
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("success");
      expect(runSpy).toHaveBeenCalledTimes(2);

      const taskEvents = (
        await readFile(join(runDir, "events", "task.jsonl"), "utf-8")
      )
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              diagnostics?: Record<string, unknown>;
              reason?: string;
            },
        );
      const retryEvents = taskEvents.filter(
        (event) => event.type === "task_provider_retry",
      );
      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0]?.reason).toContain("Connection stalled");
      expect(retryEvents[0]?.diagnostics).toMatchObject({
        attempt: 1,
        backoffSeconds: 0,
      });
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer does not retry non-transient provider exits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-implementer-no-retry-"));
    await initRepo(cwd);
    await commitFile(cwd, "hello.txt", "hello", "initial commit");
    const branch = "archloop/bd-1-test-task";
    await execAsync(`git branch "${branch}"`, { cwd });

    const runDir = join(cwd, "run");
    await mkdir(join(runDir, "logs"), { recursive: true });
    await writeFile(
      join(runDir, "logs", "bd-1.log"),
      "agent still working\n",
      "utf-8",
    );

    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-22T00:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockRejectedValue(
      new AgentError({
        message: "cursor exited with code 1:\nAuthentication failed",
      }),
    );
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: {
        OPENAI_KEY: "test-openai-key",
        ARCHLOOP_PROVIDER_RETRY_ATTEMPTS: "3",
        ARCHLOOP_PROVIDER_RETRY_BASE_MS: "0",
      },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch,
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir,
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.message).toContain("Authentication failed");
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(existsSync(join(runDir, "events", "task.jsonl"))).toBe(false);
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer skips retry when COMPLETE already emitted", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "hub-flow-implementer-retry-complete-"),
    );
    await initRepo(cwd);
    await commitFile(cwd, "hello.txt", "hello", "initial commit");
    const branch = "archloop/bd-1-test-task";
    await execAsync(`git checkout -b "${branch}"`, { cwd });
    await commitFile(cwd, "work.txt", "work", "RALPH: work");
    await execAsync("git checkout main", { cwd });

    const runDir = join(cwd, "run");
    await mkdir(join(runDir, "logs"), { recursive: true });
    await writeFile(
      join(runDir, "logs", "bd-1.log"),
      "agent work...\n<promise>COMPLETE</promise>\n",
      "utf-8",
    );

    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-22T00:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockRejectedValue(
      new AgentError({
        message:
          "cursor exited with code 1:\nRetriableError: [unavailable] PING timed out",
      }),
    );
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: {
        OPENAI_KEY: "test-openai-key",
        ARCHLOOP_PROVIDER_RETRY_ATTEMPTS: "3",
        ARCHLOOP_PROVIDER_RETRY_BASE_MS: "0",
      },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch,
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir,
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("success");
      expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(existsSync(join(runDir, "events", "task.jsonl"))).toBe(false);
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer surfaces the original transient after retries are exhausted", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "hub-flow-implementer-retry-exhaust-"),
    );
    await initRepo(cwd);
    await commitFile(cwd, "hello.txt", "hello", "initial commit");
    const branch = "archloop/bd-1-test-task";
    await execAsync(`git branch "${branch}"`, { cwd });

    const runDir = join(cwd, "run");
    await mkdir(join(runDir, "logs"), { recursive: true });
    await writeFile(
      join(runDir, "logs", "bd-1.log"),
      "still working\n",
      "utf-8",
    );

    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-22T00:00:00.000Z"),
      });
    const originalMessage =
      "claude-code exited with code 1:\nAPI Error: 400 Invalid request parameters (request id: abc)";
    const runSpy = vi
      .spyOn(runModule, "run")
      .mockRejectedValue(new AgentError({ message: originalMessage }));
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: {
        OPENAI_KEY: "test-openai-key",
        ARCHLOOP_PROVIDER_RETRY_ATTEMPTS: "3",
        ARCHLOOP_PROVIDER_RETRY_BASE_MS: "0",
      },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch,
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir,
        projectDevelopmentContract,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.message).toBe(originalMessage);
      expect(runSpy).toHaveBeenCalledTimes(3);

      const retryEvents = (
        await readFile(join(runDir, "events", "task.jsonl"), "utf-8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string })
        .filter((event) => event.type === "task_provider_retry");
      expect(retryEvents).toHaveLength(2);
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunImplementer propagates an aborted run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-implementer-abort-"));
    await initRepo(cwd);
    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-15T12:00:00.000Z"),
      });
    const controller = new AbortController();
    const reason = Object.assign(new Error("Run cancelled by SIGINT"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
    const runSpy = vi.spyOn(runModule, "run").mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: { OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      await expect(
        implementer({
          flowId: "no-review",
          batchId: "batch-test",
          taskId: "bd-1",
          title: "Test task",
          branch: "archloop/bd-1-test-task",
          promptFile: "/tmp/prompt.md",
          cwd,
          runDir: cwd,
          projectDevelopmentContract,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("configures task-board agent file logging without startup decoration for plain output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-plain-agents-"));
    await initRepo(cwd);
    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-07-15T10:00:00.000Z"),
      });
    const runSpy = vi.spyOn(runModule, "run").mockResolvedValue({
      completionSignal: "<promise>COMPLETE</promise>",
      commits: [{ sha: "abc123" }],
      branch: "archloop/bd-1-test-task",
      iterations: [],
      stdout: "raw agent text",
    });
    const options = {
      cwd,
      env: { OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex" as const, model: "gpt-5.4-mini" },
      showAgentStartup: false,
    };
    const implementer = createHubFlowRunImplementer(options);
    const reviewer = createHubFlowRunReviewer(options);

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      await implementer({
        flowId: "with-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch: "archloop/bd-1-test-task",
        promptFile: "/tmp/implement.md",
        cwd,
        runDir: cwd,
        projectDevelopmentContract,
      });
      await reviewer({
        flowId: "with-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch: "archloop/bd-1-test-task",
        promptFile: "/tmp/review.md",
        cwd,
        runDir: cwd,
        implementCommitCount: 1,
      });

      expect(runSpy).toHaveBeenCalledTimes(2);
      expect(runSpy.mock.calls.map((call) => call[0].logging)).toEqual([
        expect.objectContaining({ type: "file", showStartup: false }),
        expect.objectContaining({ type: "file", showStartup: false }),
      ]);
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunReviewer uses the configured review role provider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-review-preflight-"));
    const reviewer = createHubFlowRunReviewer({
      cwd,
      roleEntry: { provider: "codex", model: "gpt-5.4" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("XDG_DATA_HOME", join(cwd, "xdg-data"));
    try {
      const result = await reviewer({
        flowId: "with-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch: "archloop/bd-1-test-task",
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir: cwd,
        implementCommitCount: 1,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.message).toContain("Codex agent credentials");
      expect(result.message).toContain("OPENAI_KEY");
      expect(result.message).not.toContain("Cursor agent credentials");
      expect(result.message).toContain("archloop env init");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("createHubFlowRunReviewer forwards the supplied env to the run invocation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-review-run-"));
    await initRepo(cwd);
    const runSpy = vi.spyOn(runModule, "run").mockResolvedValue({
      completionSignal: "<promise>COMPLETE</promise>",
      commits: [{ sha: "abc123" }],
      branch: "archloop/bd-1-test-task",
      iterations: [],
      stdout: "",
    });
    const reviewer = createHubFlowRunReviewer({
      cwd,
      env: { OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex", model: "gpt-5.4" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await reviewer({
        flowId: "with-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Test task",
        branch: "archloop/bd-1-test-task",
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir: cwd,
        implementCommitCount: 1,
      });

      expect(result.outcome).toBe("success");
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy.mock.calls[0]?.[0].agent.name).toBe("codex");
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("reports active execution instead of starting a retry when a live worktree lease exists", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-retry-active-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-retry-active";
    const branch = resolveHubTaskBranch(taskId, "Retry active task");
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title: "Retry active task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    await runLeaseEffect(WorktreeManager.create(repoDir, { branch }));
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "hub",
        taskId,
        flowId: "no-review",
        batchId: "batch-live",
        branch,
        pid: process.pid,
        acquiredAt: "2026-06-22T10:00:00.000Z",
      }),
    );

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "retry-active",
    );
    const implementer = vi.fn<HubFlowImplementer>(async () => ({
      outcome: "success",
      commits: [{ sha: "abc" }],
      completionSignal: "<promise>COMPLETE</promise>",
    }));

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer,
      runMergePhase: false,
    });

    expect(implementer).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      taskId,
      outcome: "active_execution",
      hubStatus: "ready_for_agent",
      commitCount: 0,
    });

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents).toContainEqual(
      expect.objectContaining({
        type: "task_retry_blocked",
        taskId,
        reason: "active_worktree_lease",
      }),
    );
  });

  it("retries from a preserved dirty worktree after clearing a stale lease", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-flow-retry-preserved-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-retry-preserved";
    const title = "Retry preserved task";
    const branch = resolveHubTaskBranch(taskId, title);
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const worktree = await runLeaseEffect(
      WorktreeManager.create(repoDir, { branch }),
    );
    await writeFile(join(worktree.path, "partial.txt"), "wip\n");
    const deadPid = await spawnExitedPid();
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "hub",
        taskId,
        flowId: "no-review",
        batchId: "batch-dead",
        branch,
        pid: deadPid,
        acquiredAt: "2026-06-22T09:00:00.000Z",
      }),
    );

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "retry-preserved",
    );
    let capturedInput: HubImplementTaskInput | undefined;
    const implementer = vi.fn<HubFlowImplementer>(async (input) => {
      capturedInput = input;
      return {
        outcome: "success",
        commits: [],
        completionSignal: "<promise>COMPLETE</promise>",
        branchHasUnmergedWork: true,
      };
    });

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer,
      runMergePhase: false,
    });

    expect(implementer).toHaveBeenCalledTimes(1);
    expect(capturedInput?.branch).toBe(branch);
    expect(capturedInput?.preservedWorktreePath).toContain(
      "archloop-bd-retry-preserved",
    );
    expect(capturedInput?.retryContext?.toLowerCase()).toContain(
      "inspect existing work",
    );
    expect(capturedInput?.retryContext?.toLowerCase()).toContain(
      "uncommitted changes",
    );
    expect(result.results[0]).toMatchObject({
      taskId,
      outcome: "implemented",
      hubStatus: "waiting_for_merge",
      implementationWork: "existing_unmerged_work",
    });
  });
});
