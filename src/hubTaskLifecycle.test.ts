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
  recordHubTaskReviewFailure,
  recordHubTaskReviewSuccess,
  recordHubTaskSyncConflict,
} from "./hubTaskLifecycle.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
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

  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
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
    },
  };
};

const readJsonl = async (path: string): Promise<unknown[]> => {
  const content = await readFile(path, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
};

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
