import { exec, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it, vi } from "vitest";
import { appendHubBatchEvent, createHubRunContext } from "./hubExecution.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";
import {
  createHubFlowRunImplementer,
  createHubFlowRunReviewer,
  formatHubFlowResultLines,
  runHubFlow,
  type HubFlowImplementer,
  type HubFlowReviewer,
  type HubImplementTaskInput,
  type HubReviewTaskInput,
} from "./hubFlowExecution.js";
import {
  resolveHubFlowPromptPath,
  validateHubFlowRegistries,
} from "./hubFlows.js";
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

    expect(result.selectedTaskIds).toEqual(["bd-first"]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyUsed: "conservative",
      maxTasks: 3,
      deferredTasks: [{ taskId: "bd-second", reason: "over_max_tasks" }],
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.taskId).toBe("bd-first");

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const plannedEvent = batchEvents.find(
      (event) => (event as { type?: string }).type === "batch_planned",
    );
    expect(plannedEvent).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-first"],
      batchStrategyUsed: "conservative",
      maxTasks: 3,
      deferredTasks: [{ taskId: "bd-second", reason: "over_max_tasks" }],
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
    ).toContain("ready-for-agent");
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

    expect(result.selectedTaskIds).toEqual(["bd-first"]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyRequested: "planned",
      batchStrategyUsed: "conservative",
      maxTasks: 3,
      fallbackReason: "planner_unavailable",
      deferredTasks: [{ taskId: "bd-second", reason: "over_max_tasks" }],
    });
    expect(invocations).toHaveLength(1);

    const output = formatHubFlowResultLines(result).join("\n");
    expect(output).toContain("Batch strategy: conservative (max 3)");
    expect(output).toContain("Batch strategy requested: planned");
    expect(output).toContain("Batch fallback: planner_unavailable");
  });

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

    expect(result.selectedTaskIds).toEqual(["bd-first", "bd-second"]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyUsed: "planned",
      maxTasks: 2,
      deferredTasks: [{ taskId: "bd-third", reason: "same_core_module" }],
      rationale: "Two independent tasks can run in parallel.",
    });
    expect(invocations.map((input) => input.taskId)).toEqual([
      "bd-first",
      "bd-second",
    ]);

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const plannedEvent = batchEvents.find(
      (event) => (event as { type?: string }).type === "batch_planned",
    );
    expect(plannedEvent).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-first", "bd-second"],
      batchStrategyUsed: "planned",
      maxTasks: 2,
      deferredTasks: [{ taskId: "bd-third", reason: "same_core_module" }],
      rationale: "Two independent tasks can run in parallel.",
    });

    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "Batch strategy: planned (max 2)",
    );
  });

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
  });

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
        const timeout = setTimeout(() => resolve(false), 1000);
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
  });

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
    ]);
    expect(result.batchSelection).toMatchObject({
      batchStrategyUsed: "limited",
      maxTasks: 2,
      deferredTasks: [{ taskId: "bd-a-queue-third", reason: "over_max_tasks" }],
    });
    expect(invocations.map((input) => input.taskId)).toEqual([
      "bd-z-queue-first",
      "bd-m-queue-second",
    ]);

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    const plannedEvent = batchEvents.find(
      (event) => (event as { type?: string }).type === "batch_planned",
    );
    expect(plannedEvent).toMatchObject({
      type: "batch_planned",
      taskIds: ["bd-z-queue-first", "bd-m-queue-second"],
      batchStrategyUsed: "limited",
      maxTasks: 2,
    });

    expect(formatHubFlowResultLines(result).join("\n")).toContain(
      "Batch strategy: limited (max 2)",
    );

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(
      finalState.find((task) => task.id === "bd-a-queue-third")?.labels,
    ).toContain("ready-for-agent");
  });
});

describe("no-review Hub flow execution", () => {
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
    expect(result.mergeResult).toMatchObject({
      batchId: result.batchId,
      selectedTaskIds: [],
      batchStatus: "skipped",
    });
    expect(implementCalls).toBe(0);
    expect(reviewCalls).toBe(0);

    const summary = formatHubFlowResultLines(result).join("\n");
    expect(summary).toContain("No ready tasks selected.");
    expect(summary).toContain(
      "No unfinished with-review batch found to resume.",
    );
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
    expect(result.mergeResult).toMatchObject({
      batchId: oldBatchId,
      selectedTaskIds: ["bd-resume"],
      batchStatus: "done",
    });
    expect(mergedTaskIds).toEqual(["bd-resume"]);
    expect(result.runDir).not.toBe(oldContext.runDir);

    const batchEvents = await readJsonl(
      join(result.runDir, "events", "batch.jsonl"),
    );
    expect(
      new Set(
        batchEvents
          .map((event) => (event as { batchId?: string }).batchId)
          .filter((batchId): batchId is string => batchId !== undefined),
      ),
    ).toEqual(new Set([oldBatchId]));
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
      implementer: async () => {
        implementCalls += 1;
        throw new Error(
          "implementer should not run while resuming merge batch",
        );
      },
      reviewer: async () => {
        reviewCalls += 1;
        throw new Error("reviewer should not run while resuming merge batch");
      },
      merger: async (input) => {
        mergedTaskIds.push(input.taskId);
        return { outcome: "success" };
      },
      verifier: async () => ({ outcome: "success" }),
    });

    expect(result.mode).toBe("resumed_batch");
    expect(result.selectedTaskIds).toEqual([]);
    expect(result.resumedBatchId).toBe(oldBatchId);
    expect(result.batchId).toBe(oldBatchId);
    expect(result.unfinishedBatchIds).toEqual([oldBatchId]);
    expect(result.mergeResult).toMatchObject({
      batchId: oldBatchId,
      selectedTaskIds: ["bd-old-conflict"],
      batchStatus: "done",
    });
    expect(mergedTaskIds).toEqual(["bd-old-conflict"]);
    expect(implementCalls).toBe(0);
    expect(reviewCalls).toBe(0);

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState.find((task) => task.id === "bd-ready")?.status).toBe(
      "open",
    );
    expect(finalState.find((task) => task.id === "bd-ready")?.labels).toEqual([
      "ready-for-agent",
    ]);
    expect(
      finalState.find((task) => task.id === "bd-old-conflict")?.status,
    ).toBe("closed");

    const summary = formatHubFlowResultLines(result).join("\n");
    expect(summary).toContain(`Mode: resumed_batch`);
    expect(summary).toContain(`Resumed batch id: ${oldBatchId}`);
    expect(summary).not.toContain("Unfinished batches not resumed");
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

    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
      hubProjectDir,
      env,
      implementer,
      reviewer,
      runMergePhase: false,
    });

    expect(result.selectedTaskIds).toEqual(["bd-71"]);
    expect(implementInvocations).toHaveLength(1);
    expect(reviewInvocations).toHaveLength(1);
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
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.message).toContain("Codex agent credentials");
      expect(result.message).toContain("OPENAI_KEY");
      expect(result.message).not.toContain("Cursor agent credentials");
    } finally {
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
