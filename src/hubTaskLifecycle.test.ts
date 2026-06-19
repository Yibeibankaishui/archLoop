import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import {
  claimHubTaskForImplementation,
  enterMergePhase,
  recordCloseFailure,
  recordImplementationFailure,
  recordImplementationSuccess,
  recordMergeFailure,
  recordTaskClosure,
  recordTaskMergeStarted,
  recordVerificationFailure,
  revertTaskToWaitingForMerge,
} from "./hubTaskLifecycle.js";
import type { HubTaskProjection } from "./taskBoard.js";

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
  options?: { readonly failCloseFor?: string },
) => {
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));

  const failCloseFor = options?.failCloseFor ?? "";
  const argsFile = join(repoDir, "bd-args.txt");
  await writeFile(argsFile, "");
  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const argsFile = process.env.BD_ARGS_FILE;
const failCloseFor = ${JSON.stringify(failCloseFor)};
const args = process.argv.slice(2);
const [command, id] = args;
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const findTask = (state, taskId) => state.find((task) => task.id === taskId);

if (command === "show" && id) {
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "update" && id) {
  if (failCloseFor && id === failCloseFor) {
    const statusIndex = args.indexOf("--status");
    if (statusIndex >= 0 && args[statusIndex + 1] === "closed") {
      process.exit(1);
    }
  }
  fs.writeFileSync(argsFile, args.join("\\n"));
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  const statusIndex = args.indexOf("--status");
  if (statusIndex >= 0) {
    task.status = args[statusIndex + 1];
  }
  for (let index = 0; index < args.length; index += 1) {
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
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SANDCASTLE_BD_PATH: bdPath,
      BD_STATE_FILE: stateFile,
      BD_ARGS_FILE: argsFile,
    },
  };
};

describe("Hub task lifecycle", () => {
  it("claims a ready task through the lifecycle interface", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-claim-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-claim",
        title: "Claim me",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const hubProjectDir = join(
      repoDir,
      "data",
      "sandcastle",
      "hub",
      "projects",
      "abc",
    );
    const result = claimHubTaskForImplementation({
      cwd: repoDir,
      taskId: "bd-claim",
      branch: "sandcastle/bd-claim-claim-me",
      hubProjectDir,
      env,
    });

    expect(result.outcome).toBe("claimed");
    expect(result.task.hubStatus).toBe("implementing");
    expect(result.claim).toMatchObject({
      runId: result.runId,
      batchId: result.batchId,
      branch: "sandcastle/bd-claim-claim-me",
    });

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents[0]).toMatchObject({
      type: "task_claimed",
      taskId: "bd-claim",
    });
  });

  it("records implementation success to waiting_for_merge without a reviewer", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-success-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-success",
        title: "Success task",
        status: "in_progress",
        labels: ["ready-for-agent", "implementing"],
        metadata: {
          claim: {
            runId: "run-1",
            batchId: "batch-1",
            branch: "sandcastle/bd-success-success-task",
            claimedAt: "2026-06-19T10:00:00Z",
          },
        },
      },
    ]);

    const hubProjectDir = join(
      repoDir,
      "data",
      "sandcastle",
      "hub",
      "projects",
      "abc",
    );
    const runDir = join(hubProjectDir, "runs", "run-1");

    const result = recordImplementationSuccess({
      cwd: repoDir,
      env,
      context: {
        runId: "run-1",
        batchId: "batch-1",
        runDir,
      },
      taskId: "bd-success",
      branch: "sandcastle/bd-success-success-task",
      metadata: {
        claim: {
          runId: "run-1",
          batchId: "batch-1",
          branch: "sandcastle/bd-success-success-task",
          claimedAt: "2026-06-19T10:00:00Z",
        },
      },
      claim: {
        runId: "run-1",
        batchId: "batch-1",
        branch: "sandcastle/bd-success-success-task",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      commitCount: 2,
      hasReviewer: false,
      createdAt: "2026-06-19T10:05:00Z",
    });

    expect(result.hubStatus).toBe("waiting_for_merge");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.labels).toContain("waiting-for-merge");
    expect(finalState[0]?.labels).not.toContain("implementing");

    const taskEvents = await readJsonl(join(runDir, "events", "task.jsonl"));
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      ["task_implementation_succeeded", "task_status_advanced"],
    );
  });

  it("records implementation success to reviewing when a reviewer follows", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-review-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-review",
        title: "Review task",
        status: "in_progress",
        labels: ["ready-for-agent", "implementing"],
        metadata: {},
      },
    ]);

    const result = recordImplementationSuccess({
      cwd: repoDir,
      env,
      context: {
        runId: "run-2",
        batchId: "batch-2",
        runDir: join(repoDir, "runs", "run-2"),
      },
      taskId: "bd-review",
      branch: "sandcastle/bd-review-review-task",
      metadata: {},
      claim: {
        runId: "run-2",
        batchId: "batch-2",
        branch: "sandcastle/bd-review-review-task",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      commitCount: 1,
      hasReviewer: true,
      createdAt: "2026-06-19T10:05:00Z",
    });

    expect(result.hubStatus).toBe("reviewing");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.labels).toContain("reviewing");
  });

  it("records agent implementation failure with agent_failed", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-agent-fail-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-agent-fail",
        title: "Agent fail",
        status: "in_progress",
        labels: ["ready-for-agent", "implementing"],
        metadata: {},
      },
    ]);

    const result = recordImplementationFailure({
      cwd: repoDir,
      env,
      context: {
        runId: "run-3",
        batchId: "batch-3",
        runDir: join(repoDir, "runs", "run-3"),
      },
      taskId: "bd-agent-fail",
      branch: "sandcastle/bd-agent-fail-agent-fail",
      metadata: {},
      claim: {
        runId: "run-3",
        batchId: "batch-3",
        branch: "sandcastle/bd-agent-fail-agent-fail",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      failureReason: "agent_failed",
      commitCount: 0,
      createdAt: "2026-06-19T10:05:00Z",
    });

    expect(result.hubStatus).toBe("failed");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("open");
    expect(finalState[0]?.labels).toContain("failed");
    expect(finalState[0]?.metadata.failureReason).toBe("agent_failed");
  });

  it("records sandbox implementation failure with sandbox_failed", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-sandbox-fail-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-sandbox-fail",
        title: "Sandbox fail",
        status: "in_progress",
        labels: ["ready-for-agent", "implementing"],
        metadata: {},
      },
    ]);

    const result = recordImplementationFailure({
      cwd: repoDir,
      env,
      context: {
        runId: "run-4",
        batchId: "batch-4",
        runDir: join(repoDir, "runs", "run-4"),
      },
      taskId: "bd-sandbox-fail",
      branch: "sandcastle/bd-sandbox-fail-sandbox-fail",
      metadata: {},
      claim: {
        runId: "run-4",
        batchId: "batch-4",
        branch: "sandcastle/bd-sandbox-fail-sandbox-fail",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      failureReason: "sandbox_failed",
      commitCount: 0,
      createdAt: "2026-06-19T10:05:00Z",
    });

    expect(result.hubStatus).toBe("failed");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.metadata.failureReason).toBe("sandbox_failed");
  });
});

const toHubTaskProjection = (task: MockBeadsTask): HubTaskProjection =>
  ({
    id: task.id,
    title: task.title,
    beadsStatus: task.status,
    hubStatus:
      (task.metadata.hubStatus as HubTaskProjection["hubStatus"]) ??
      "waiting_for_merge",
    claim: task.metadata.claim as HubTaskProjection["claim"],
    claimState: undefined,
    labels: task.labels,
    metadata: task.metadata,
    description: undefined,
    notes: undefined,
    comments: [],
    remoteRefs: [],
    runRefs: [],
  }) as HubTaskProjection;

const waitingForMergeTask = (
  id: string,
  title: string,
  batchId: string,
): MockBeadsTask => ({
  id,
  title,
  status: "in_progress",
  labels: ["waiting-for-merge"],
  metadata: {
    hubStatus: "waiting_for_merge",
    claim: {
      runId: "run-merge",
      batchId,
      branch: `sandcastle/${id}-${title.toLowerCase().replace(/\s+/g, "-")}`,
      claimedAt: "2026-06-19T10:00:00Z",
    },
  },
});

const mergeLifecycleContext = (repoDir: string) => {
  const runDir = join(repoDir, "runs", "run-merge");
  mkdirSync(join(runDir, "events"), { recursive: true });
  return {
    runId: "run-merge",
    batchId: "batch-merge",
    runDir,
  };
};

describe("Hub task lifecycle merge outcomes", () => {
  it("enters merge phase and records merge start", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-merge-start-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      waitingForMergeTask("bd-merge", "Merge task", "batch-merge"),
    ]);
    const context = mergeLifecycleContext(repoDir);
    const task = waitingForMergeTask("bd-merge", "Merge task", "batch-merge");

    enterMergePhase({
      cwd: repoDir,
      env,
      tasks: [toHubTaskProjection(task)],
    });

    recordTaskMergeStarted({
      context,
      taskId: "bd-merge",
      branch: "sandcastle/bd-merge-merge-task",
      claim: {
        runId: "run-merge",
        batchId: "batch-merge",
        branch: "sandcastle/bd-merge-merge-task",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      createdAt: "2026-06-19T10:01:00Z",
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.labels).toContain("merging");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents[0]).toMatchObject({
      type: "merge_started",
      status: "merging",
    });
  });

  it("records merge conflict failure", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-merge-conflict-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      waitingForMergeTask("bd-conflict", "Conflict task", "batch-merge"),
    ]);
    const context = mergeLifecycleContext(repoDir);

    const result = recordMergeFailure({
      cwd: repoDir,
      env,
      context,
      taskId: "bd-conflict",
      branch: "sandcastle/bd-conflict-conflict-task",
      metadata: waitingForMergeTask(
        "bd-conflict",
        "Conflict task",
        "batch-merge",
      ).metadata,
      claim: {
        runId: "run-merge",
        batchId: "batch-merge",
        branch: "sandcastle/bd-conflict-conflict-task",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      failureReason: "merge_conflict",
      createdAt: "2026-06-19T10:02:00Z",
    });

    expect(result.hubStatus).toBe("failed");
    expect(result.failureReason).toBe("merge_conflict");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.labels).toContain("failed");
    expect(finalState[0]?.metadata.failureReason).toBe("merge_conflict");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      ["merge_failed", "task_status_advanced"],
    );
  });

  it("records verification failure", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-verify-fail-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      waitingForMergeTask("bd-verify", "Verify task", "batch-merge"),
    ]);
    const context = mergeLifecycleContext(repoDir);

    const result = recordVerificationFailure({
      cwd: repoDir,
      env,
      context,
      taskId: "bd-verify",
      branch: "sandcastle/bd-verify-verify-task",
      metadata: waitingForMergeTask("bd-verify", "Verify task", "batch-merge")
        .metadata,
      claim: {
        runId: "run-merge",
        batchId: "batch-merge",
        branch: "sandcastle/bd-verify-verify-task",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      createdAt: "2026-06-19T10:03:00Z",
    });

    expect(result.hubStatus).toBe("failed");
    expect(result.failureReason).toBe("verification_failure");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.metadata.failureReason).toBe("verification_failure");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      ["verification_failed", "task_status_advanced"],
    );
  });

  it("records close failure", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-close-fail-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      waitingForMergeTask("bd-close", "Close task", "batch-merge"),
    ]);
    const context = mergeLifecycleContext(repoDir);

    const result = recordCloseFailure({
      cwd: repoDir,
      env,
      context,
      taskId: "bd-close",
      branch: "sandcastle/bd-close-close-task",
      metadata: waitingForMergeTask("bd-close", "Close task", "batch-merge")
        .metadata,
      claim: {
        runId: "run-merge",
        batchId: "batch-merge",
        branch: "sandcastle/bd-close-close-task",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      createdAt: "2026-06-19T10:04:00Z",
    });

    expect(result.hubStatus).toBe("failed");
    expect(result.failureReason).toBe("close_failed");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.metadata.failureReason).toBe("close_failed");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      ["task_close_failed", "task_status_advanced"],
    );
  });

  it("records successful task closure", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-close-success-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      waitingForMergeTask("bd-done", "Done task", "batch-merge"),
    ]);
    const context = mergeLifecycleContext(repoDir);

    const result = await recordTaskClosure({
      cwd: repoDir,
      env,
      context,
      taskId: "bd-done",
      branch: "sandcastle/bd-done-done-task",
      metadata: waitingForMergeTask("bd-done", "Done task", "batch-merge")
        .metadata,
      claim: {
        runId: "run-merge",
        batchId: "batch-merge",
        branch: "sandcastle/bd-done-done-task",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      createdAt: "2026-06-19T10:05:00Z",
    });

    expect(result.hubStatus).toBe("done");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("closed");
    expect(finalState[0]?.labels).toContain("done");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      ["task_closed", "task_status_advanced"],
    );
  });

  it("reverts a task to waiting_for_merge", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-revert-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        ...waitingForMergeTask("bd-revert", "Revert task", "batch-merge"),
        labels: ["merging"],
        metadata: {
          hubStatus: "merging",
          claim: {
            runId: "run-merge",
            batchId: "batch-merge",
            branch: "sandcastle/bd-revert-revert-task",
            claimedAt: "2026-06-19T10:00:00Z",
          },
        },
      },
    ]);

    const task = revertTaskToWaitingForMerge({
      cwd: repoDir,
      env,
      task: toHubTaskProjection({
        ...waitingForMergeTask("bd-revert", "Revert task", "batch-merge"),
        labels: ["merging"],
        metadata: {
          hubStatus: "merging",
          claim: {
            runId: "run-merge",
            batchId: "batch-merge",
            branch: "sandcastle/bd-revert-revert-task",
            claimedAt: "2026-06-19T10:00:00Z",
          },
        },
      }),
    });

    expect(task.hubStatus).toBe("waiting_for_merge");
    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.labels).toContain("waiting-for-merge");
    expect(finalState[0]?.labels).not.toContain("merging");
  });
});
