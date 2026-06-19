import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createHubRunContext,
  createHubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  claimHubTaskForImplementation,
  completeCloseFailedRecovery,
  recoverFailedHubTask,
  recordImplementationFailure,
  recordImplementationStarted,
  recordImplementationSuccess,
  recordHubTaskReviewFailure,
  recordHubTaskReviewSuccess,
  recordHubTaskSyncConflict,
  releaseStaleHubTaskClaim,
} from "./hubTaskLifecycle.js";
import { loadHubTask } from "./taskBoard.js";

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

  it("records implementation started with claim metadata", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-lifecycle-started-"));
    const runDir = join(repoDir, "runs", "run-started");
    await mkdir(join(runDir, "events"), { recursive: true });

    recordImplementationStarted({
      context: {
        runId: "run-started",
        batchId: "batch-started",
        runDir,
      },
      taskId: "bd-started",
      branch: "sandcastle/bd-started-started-task",
      hubStatus: "implementing",
      claim: {
        runId: "run-started",
        batchId: "batch-started",
        branch: "sandcastle/bd-started-started-task",
        claimedAt: "2026-06-19T10:00:00Z",
        raw: {},
      },
      createdAt: "2026-06-19T10:01:00Z",
    });

    const taskEvents = await readJsonl(join(runDir, "events", "task.jsonl"));
    expect(taskEvents).toEqual([
      {
        type: "task_implementation_started",
        runId: "run-started",
        batchId: "batch-started",
        taskId: "bd-started",
        branch: "sandcastle/bd-started-started-task",
        createdAt: "2026-06-19T10:01:00Z",
        status: "implementing",
        claim: {
          runId: "run-started",
          batchId: "batch-started",
          branch: "sandcastle/bd-started-started-task",
          claimedAt: "2026-06-19T10:00:00Z",
          raw: {},
        },
      },
    ]);
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

describe("Hub task lifecycle review outcomes", () => {
  it("records review success as waiting_for_merge with lifecycle events", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-review-success-"),
    );
    await initRepo(repoDir);

    const stateFile = join(repoDir, "bd-state.json");
    const claim = createHubTaskClaimMetadata({
      runId: "run-review-success",
      batchId: "batch-review-success",
      branch: "sandcastle/bd-1-review-task",
      claimedAt: "2026-06-19T10:00:00.000Z",
    });
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-1",
        title: "Review task",
        status: "in_progress",
        labels: ["implementing", "reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: claim.raw,
        },
      },
    ]);

    const context = createHubRunContext({
      cwd: repoDir,
      branch: "flow/with-review",
      runId: "run-review-success",
      batchId: "batch-review-success",
      env,
    });
    const createdAt = "2026-06-19T10:05:00.000Z";

    const result = recordHubTaskReviewSuccess({
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId: context.batchId,
      taskId: "bd-1",
      branch: claim.branch!,
      taskMetadata: { claim: claim.raw },
      claim,
      commitCount: 2,
      createdAt,
      env,
    });

    expect(result.hubStatus).toBe("waiting_for_merge");
    expect(result.outcome).toBe("reviewed");

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("in_progress");
    expect(finalState[0]?.labels).toContain("waiting-for-merge");
    expect(finalState[0]?.labels).not.toContain("reviewing");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      ["task_review_succeeded", "task_status_advanced"],
    );
    expect(taskEvents[0]).toMatchObject({
      status: "waiting_for_merge",
      commitCount: 2,
    });
  });

  it("records agent review failure as failed with agent_failed", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-review-agent-fail-"),
    );
    await initRepo(repoDir);

    const stateFile = join(repoDir, "bd-state.json");
    const claim = createHubTaskClaimMetadata({
      runId: "run-review-agent-fail",
      batchId: "batch-review-agent-fail",
      branch: "sandcastle/bd-2-review-task",
    });
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-2",
        title: "Review fail task",
        status: "in_progress",
        labels: ["implementing", "reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: claim.raw,
        },
      },
    ]);

    const context = createHubRunContext({
      cwd: repoDir,
      branch: "flow/with-review",
      runId: "run-review-agent-fail",
      batchId: "batch-review-agent-fail",
      env,
    });

    const result = recordHubTaskReviewFailure({
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId: context.batchId,
      taskId: "bd-2",
      branch: claim.branch!,
      taskMetadata: { claim: claim.raw },
      claim,
      failureReason: "agent_failed",
      commitCount: 0,
      createdAt: "2026-06-19T10:06:00.000Z",
      env,
    });

    expect(result).toMatchObject({
      hubStatus: "failed",
      failureReason: "agent_failed",
      outcome: "agent_failed",
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("open");
    expect(finalState[0]?.labels).toContain("failed");
    expect(finalState[0]?.metadata.failureReason).toBe("agent_failed");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      ["task_review_failed", "task_status_advanced"],
    );
    expect(taskEvents[0]).toMatchObject({
      status: "failed",
      failureReason: "agent_failed",
    });
  });

  it("records sandbox review failure as failed with sandbox_failed", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-review-sandbox-fail-"),
    );
    await initRepo(repoDir);

    const stateFile = join(repoDir, "bd-state.json");
    const claim = createHubTaskClaimMetadata({
      runId: "run-review-sandbox-fail",
      batchId: "batch-review-sandbox-fail",
      branch: "sandcastle/bd-3-review-task",
    });
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-3",
        title: "Sandbox review fail task",
        status: "in_progress",
        labels: ["implementing", "reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: claim.raw,
        },
      },
    ]);

    const context = createHubRunContext({
      cwd: repoDir,
      branch: "flow/with-review",
      runId: "run-review-sandbox-fail",
      batchId: "batch-review-sandbox-fail",
      env,
    });

    const result = recordHubTaskReviewFailure({
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId: context.batchId,
      taskId: "bd-3",
      branch: claim.branch!,
      taskMetadata: { claim: claim.raw },
      claim,
      failureReason: "sandbox_failed",
      commitCount: 0,
      createdAt: "2026-06-19T10:07:00.000Z",
      env,
    });

    expect(result).toMatchObject({
      hubStatus: "failed",
      failureReason: "sandbox_failed",
      outcome: "sandbox_failed",
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.metadata.failureReason).toBe("sandbox_failed");
  });
});

describe("Hub task lifecycle sync conflict outcomes", () => {
  it("records sync_conflict for collaboration tasks and clears remote labels", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-sync-conflict-"),
    );
    await initRepo(repoDir);

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-ready",
        title: "Ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          hubStatus: "ready_for_agent",
          sync_state: "synced",
        },
      },
    ]);

    const result = recordHubTaskSyncConflict({
      cwd: repoDir,
      taskId: "bd-ready",
      reason: "local ready_for_agent disagrees with remote needs_info",
      env,
    });

    expect(result).toMatchObject({
      hubStatus: "sync_conflict",
      preservedCompletion: false,
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]).toMatchObject({
      status: "blocked",
      labels: ["sync-conflict"],
      metadata: {
        hubStatus: "sync_conflict",
        sync_state: "conflict",
        sync_conflict_reason:
          "local ready_for_agent disagrees with remote needs_info",
      },
    });
    expect(finalState[0]?.labels).not.toContain("ready-for-agent");
  });

  it("preserves done and wontfix hub status while recording sync conflict metadata", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-sync-conflict-done-"),
    );
    await initRepo(repoDir);

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-done",
        title: "Done task",
        status: "closed",
        labels: ["done"],
        metadata: {
          hubStatus: "done",
          sync_state: "synced",
        },
      },
      {
        id: "bd-wontfix",
        title: "Wontfix task",
        status: "closed",
        labels: ["wontfix"],
        metadata: {
          hubStatus: "wontfix",
          wontfix: true,
          sync_state: "synced",
        },
      },
    ]);

    const doneResult = recordHubTaskSyncConflict({
      cwd: repoDir,
      taskId: "bd-done",
      reason: "local done disagrees with remote ready_for_agent",
      env,
    });
    const wontfixResult = recordHubTaskSyncConflict({
      cwd: repoDir,
      taskId: "bd-wontfix",
      reason: "local wontfix disagrees with remote inbox",
      env,
    });

    expect(doneResult).toMatchObject({
      hubStatus: "done",
      preservedCompletion: true,
    });
    expect(wontfixResult).toMatchObject({
      hubStatus: "wontfix",
      preservedCompletion: true,
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    const doneTask = finalState.find((task) => task.id === "bd-done");
    const wontfixTask = finalState.find((task) => task.id === "bd-wontfix");
    expect(doneTask).toMatchObject({
      status: "closed",
      labels: ["done"],
      metadata: {
        hubStatus: "done",
        sync_state: "conflict",
        sync_conflict_reason:
          "local done disagrees with remote ready_for_agent",
      },
    });
    expect(wontfixTask).toMatchObject({
      status: "closed",
      labels: ["wontfix"],
      metadata: {
        hubStatus: "wontfix",
        sync_state: "conflict",
        sync_conflict_reason: "local wontfix disagrees with remote inbox",
      },
    });
    expect(doneTask?.labels).not.toContain("sync-conflict");
    expect(wontfixTask?.labels).not.toContain("sync-conflict");
  });
});

describe("Hub task lifecycle recovery", () => {
  it("releases stale claim metadata while preserving collaboration status", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-release-claim-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-stale",
        title: "Ready with orphan claim",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          hubStatus: "ready_for_agent",
          claim: {
            runId: "run-old",
            batchId: "batch-old",
            branch: "sandcastle/bd-stale-ready",
            claimedAt: "2026-06-11T10:00:00Z",
          },
        },
      },
    ]);

    const result = releaseStaleHubTaskClaim({
      cwd: repoDir,
      taskId: "bd-stale",
      hubStatus: "ready_for_agent",
      metadata: {
        hubStatus: "ready_for_agent",
        claim: {
          runId: "run-old",
          batchId: "batch-old",
          branch: "sandcastle/bd-stale-ready",
          claimedAt: "2026-06-11T10:00:00Z",
        },
      },
      env,
    });

    const task = loadHubTask(repoDir, "bd-stale", env);
    expect(result.hubStatus).toBe("ready_for_agent");
    expect(task.hubStatus).toBe("ready_for_agent");
    expect(task.claim).toBeUndefined();
    expect(task.metadata.claim).toBeUndefined();
  });

  it("recovers a generic failed task to ready_for_agent and clears failure metadata", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-recover-failed-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-failed",
        title: "Agent failed task",
        status: "open",
        labels: ["failed"],
        metadata: {
          hubStatus: "failed",
          failed: true,
          failureReason: "agent_failed",
          claim: {
            runId: "run-failed",
            batchId: "batch-failed",
            branch: "sandcastle/bd-failed-agent-failed-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const result = recoverFailedHubTask({
      cwd: repoDir,
      taskId: "bd-failed",
      targetStatus: "ready_for_agent",
      metadata: {
        hubStatus: "failed",
        failed: true,
        failureReason: "agent_failed",
        claim: {
          runId: "run-failed",
          batchId: "batch-failed",
          branch: "sandcastle/bd-failed-agent-failed-task",
          claimedAt: "2026-06-12T10:00:00Z",
        },
      },
      env,
    });

    const task = loadHubTask(repoDir, "bd-failed", env);
    expect(result.hubStatus).toBe("ready_for_agent");
    expect(task.hubStatus).toBe("ready_for_agent");
    expect(task.labels).toContain("ready-for-agent");
    expect(task.labels).not.toContain("failed");
    expect(task.claim).toBeUndefined();
    expect(task.metadata.failed).toBeUndefined();
    expect(task.metadata.failureReason).toBeUndefined();
  });

  it("completes close-failed recovery by closing the task and clearing claim metadata", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-lifecycle-close-failed-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-close",
        title: "Close failed task",
        status: "open",
        labels: ["failed"],
        metadata: {
          hubStatus: "failed",
          failed: true,
          failureReason: "close_failed",
          claim: {
            runId: "run-close",
            batchId: "batch-close",
            branch: "sandcastle/bd-close-close-failed-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const result = await completeCloseFailedRecovery({
      cwd: repoDir,
      taskId: "bd-close",
      metadata: {
        hubStatus: "failed",
        failed: true,
        failureReason: "close_failed",
        claim: {
          runId: "run-close",
          batchId: "batch-close",
          branch: "sandcastle/bd-close-close-failed-task",
          claimedAt: "2026-06-12T10:00:00Z",
        },
      },
      env,
    });

    const task = loadHubTask(repoDir, "bd-close", env);
    expect(result.hubStatus).toBe("done");
    expect(task.hubStatus).toBe("done");
    expect(task.labels).toContain("done");
    expect(task.claim).toBeUndefined();
    expect(task.metadata.failed).toBeUndefined();
    expect(task.metadata.failureReason).toBeUndefined();
  });
});
