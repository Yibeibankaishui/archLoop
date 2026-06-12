import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
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
} from "./taskBoard.js";

const execAsync = promisify(exec);

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
}

const writeMockBd = async (
  repoDir: string,
  stateFile: string,
  initialTasks: MockBeadsTask[],
) => {
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));

  const argsFile = join(repoDir, "bd-args.txt");
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
  const addLabelsIndex = args.indexOf("--add-labels");
  if (addLabelsIndex >= 0) {
    const labels = args[addLabelsIndex + 1].split(",");
    for (const label of labels) {
      if (!task.labels.includes(label)) task.labels.push(label);
    }
  }
  const removeLabelsIndex = args.indexOf("--remove-labels");
  if (removeLabelsIndex >= 0) {
    const labels = args[removeLabelsIndex + 1].split(",");
    task.labels = task.labels.filter((label) => !labels.includes(label));
  }
  const metadataIndex = args.indexOf("--set-metadata");
  if (metadataIndex >= 0) {
    task.metadata = JSON.parse(args[metadataIndex + 1]);
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
      BD_STATE_FILE: stateFile,
      BD_ARGS_FILE: argsFile,
    },
  };
};

describe("Hub flow registry", () => {
  it("ships bundled no-review prompts outside repo-local .sandcastle/", () => {
    validateHubFlowRegistries();
    const promptPath = resolveHubFlowPromptPath("no-review", "implement");
    expect(promptPath).toContain("hub-flows/no-review/implement-prompt.md");
    expect(promptPath).not.toContain(".sandcastle");
  });

  it("ships bundled with-review prompts outside repo-local .sandcastle/", () => {
    validateHubFlowRegistries();
    const implementPath = resolveHubFlowPromptPath("with-review", "implement");
    const reviewPath = resolveHubFlowPromptPath("with-review", "review");
    expect(implementPath).toContain(
      "hub-flows/with-review/implement-prompt.md",
    );
    expect(reviewPath).toContain("hub-flows/with-review/review-prompt.md");
    expect(reviewPath).not.toContain(".sandcastle");
  });
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
            branch: "sandcastle/bd-claimed-other",
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
      "sandcastle/bd-ready-ready-task",
    );
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
      "sandcastle",
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
      branch: "sandcastle/bd-70-implement-me",
      flowId: "no-review",
    });
    expect(invocations[0]?.promptFile).toContain(
      "hub-flows/no-review/implement-prompt.md",
    );
    expect(invocations[0]?.promptFile).not.toContain(".sandcastle");

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("in_progress");
    expect(finalState[0]?.labels).toContain("waiting-for-merge");
    expect(finalState[0]?.labels).not.toContain("implementing");
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

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
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

    const result = await runHubFlow({
      flowId: "no-review",
      cwd: repoDir,
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

    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
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
      branch: "sandcastle/bd-71-review-me",
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

    const result = await runHubFlow({
      flowId: "with-review",
      cwd: repoDir,
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
});
