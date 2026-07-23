import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { HubFlowMerger, HubFlowVerifier } from "./hubBatchMerge.js";
import { claimHubTaskForImplementation } from "./hubTaskLifecycle.js";
import type { HubTaskEvent } from "./hubExecution.js";
import {
  buildWorktreeLeaseMetadata,
  leaseLockPath,
  leaseNameFromBranch,
  serializeWorktreeLeaseMetadata,
} from "./WorktreeLease.js";
import {
  formatHubRecoveryComment,
  formatStaleHubTaskRecoveryLines,
  isHubRecoveryComment,
  planStaleExecutionRecovery,
  recoverHubTask,
  recoverStaleHubTasks,
} from "./hubTaskRecover.js";
import { loadHubTask, type HubTaskProjection, type HubTaskBoard } from "./taskBoard.js";
import type { WorktreeLeaseRecord } from "./worktreeLeaseStore.js";

const execAsync = promisify(exec);

const seedHubTaskStore = (repoDir: string): void => {
  const beadsDir = join(repoDir, ".beads");
  mkdirSync(beadsDir, { recursive: true });
  const metadataPath = join(beadsDir, "metadata.json");
  if (!existsSync(metadataPath)) {
    writeFileSync(metadataPath, JSON.stringify({ backend: "dolt" }));
  }
  // Mirror bd init: a fully-initialized store also has the embeddeddolt dir.
  mkdirSync(join(beadsDir, "embeddeddolt"), { recursive: true });
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

interface MockBeadsTask {
  id: string;
  title: string;
  status: string;
  labels: string[];
  metadata: Record<string, unknown>;
  comments?: { author?: string; body?: string; createdAt?: string }[];
}

const writeMockBd = async (
  repoDir: string,
  stateFile: string,
  initialTasks: MockBeadsTask[],
) => {
  seedHubTaskStore(repoDir);
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));

  const commentArgsFile = join(repoDir, "bd-comment-args.txt");
  await writeFile(commentArgsFile, "");
  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const commentArgsFile = process.env.BD_COMMENT_ARGS_FILE;
const args = process.argv.slice(2);
const command = args[0];
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const findTask = (state, taskId) => state.find((task) => task.id === taskId);

if (command === "list" && args.includes("--json")) {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}

if (command === "show" && args[1]) {
  const state = readState();
  const task = findTask(state, args[1]);
  if (!task) process.exit(1);
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "update" && args[1]) {
  const state = readState();
  const task = findTask(state, args[1]);
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

if (command === "comments" && args[1] === "add") {
  const taskId = args[2];
  const body = args.slice(3).join(" ");
  fs.appendFileSync(commentArgsFile, body + "\\n");
  const state = readState();
  const task = findTask(state, taskId);
  if (!task) process.exit(1);
  task.comments = task.comments ?? [];
  task.comments.push({ body });
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
      ARCHLOOP_BD_PATH: bdPath,
      BD_STATE_FILE: stateFile,
      BD_COMMENT_ARGS_FILE: commentArgsFile,
    },
    commentArgsFile,
  };
};

const updateMockTask = async (
  stateFile: string,
  taskId: string,
  update: (task: MockBeadsTask) => void,
) => {
  const state = JSON.parse(
    await readFile(stateFile, "utf-8"),
  ) as MockBeadsTask[];
  const task = state.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`missing task ${taskId}`);
  }
  update(task);
  await writeFile(stateFile, JSON.stringify(state, null, 2));
};

describe("hub task recovery comments", () => {
  it("formats recovery comments with the archLoop prefix", () => {
    expect(formatHubRecoveryComment("Released stale claim metadata.")).toBe(
      "> *This was generated by archLoop during task recovery.*\n\nReleased stale claim metadata.",
    );
    expect(
      isHubRecoveryComment(
        formatHubRecoveryComment("Moved failed task back to ready_for_agent."),
      ),
    ).toBe(true);
  });
});

describe("recoverHubTask", () => {
  it("releases stale claim metadata without changing collaboration status", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-claim-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
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
            branch: "archloop/bd-stale-ready",
            claimedAt: "2026-06-11T10:00:00Z",
          },
        },
      },
    ]);

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId: "bd-stale",
      env,
    });

    const task = loadHubTask(repoDir, "bd-stale", env);
    expect(result.outcome).toBe("released_claim");
    expect(result.priorStatus).toBe("ready_for_agent");
    expect(task.hubStatus).toBe("ready_for_agent");
    expect(task.claim).toBeUndefined();
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "This was generated by archLoop during task recovery",
    );
    expect(await readFile(commentArgsFile, "utf-8")).toContain("stale claim");
  });

  it("moves a generic failed task back to ready_for_agent", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-failed-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
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
            branch: "archloop/bd-failed-agent-failed-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId: "bd-failed",
      env,
    });

    const task = loadHubTask(repoDir, "bd-failed", env);
    expect(result.outcome).toBe("recovered_failed");
    expect(result.priorStatus).toBe("failed");
    expect(task.hubStatus).toBe("ready_for_agent");
    expect(task.labels).toContain("ready-for-agent");
    expect(task.labels).not.toContain("failed");
    expect(task.claim).toBeUndefined();
    expect(task.metadata.failed).toBeUndefined();
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "ready_for_agent",
    );
  });

  it("moves a failed task with existing unmerged branch work back to waiting_for_merge", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-unmerged-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-unmerged",
        title: "Failed with branch work",
        status: "open",
        labels: ["failed", "implementing"],
        metadata: {
          hubStatus: "failed",
          failed: true,
          failureReason: "agent_failed",
          claim: {
            runId: "run-unmerged",
            batchId: "batch-unmerged",
            branch: "archloop/bd-unmerged-failed-with-branch-work",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);
    const branch = "archloop/bd-unmerged-failed-with-branch-work";
    await execAsync(`git branch "${branch}"`, { cwd: repoDir });

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId: "bd-unmerged",
      env,
      branchHasUnmergedWork: async () => true,
    });

    const task = loadHubTask(repoDir, "bd-unmerged", env);
    expect(result.outcome).toBe("recovered_failed");
    expect(result.priorStatus).toBe("failed");
    expect(task.hubStatus).toBe("waiting_for_merge");
    expect(task.labels).toContain("waiting-for-merge");
    expect(task.labels).not.toContain("failed");
    expect(task.labels).not.toContain("implementing");
    expect(task.claim).toBeDefined();
    expect(task.metadata.failed).toBeUndefined();
    expect(task.metadata.failureReason).toBeUndefined();
    expect(
      await execAsync(`git branch --list "${branch}"`, { cwd: repoDir }),
    ).toMatchObject({
      stdout: expect.stringContaining(branch),
    });
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "waiting_for_merge",
    );
  });

  it("deletes a safe managed branch during recovery when no branch work remains", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-cleanup-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "main.txt", "main", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-cleanup",
        title: "Cleanup candidate",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          hubStatus: "ready_for_agent",
        },
      },
    ]);

    const branch = "archloop/bd-cleanup-cleanup-candidate";
    const claimResult = await claimHubTaskForImplementation({
      cwd: repoDir,
      taskId: "bd-cleanup",
      branch,
      env,
    });
    await execAsync(`git branch "${branch}"`, { cwd: repoDir });

    await updateMockTask(stateFile, "bd-cleanup", (task) => {
      task.status = "open";
      task.labels = ["failed"];
      task.metadata = {
        ...task.metadata,
        hubStatus: "failed",
        failed: true,
        failureReason: "agent_failed",
        claim: claimResult.task.claim?.raw,
      };
    });

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId: "bd-cleanup",
      env,
    });

    const task = loadHubTask(repoDir, "bd-cleanup", env);
    expect(result.outcome).toBe("recovered_failed");
    expect(task.hubStatus).toBe("ready_for_agent");
    expect(task.claim).toBeUndefined();
    expect(
      await execAsync(`git branch --list "${branch}"`, { cwd: repoDir }),
    ).toMatchObject({
      stdout: "",
    });
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "Deleted safe managed branch",
    );
  });

  it("keeps a safe managed branch when recovery cleanup is blocked", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-blocked-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "main.txt", "main", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-blocked",
        title: "Blocked cleanup",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          hubStatus: "ready_for_agent",
        },
      },
    ]);

    const branch = "archloop/bd-blocked-blocked-cleanup";
    const claimResult = await claimHubTaskForImplementation({
      cwd: repoDir,
      taskId: "bd-blocked",
      branch,
      env,
    });
    await execAsync(`git branch "${branch}"`, { cwd: repoDir });
    mkdirSync(join(repoDir, ".archloop", "locks"), { recursive: true });
    const lockPath = leaseLockPath(repoDir, leaseNameFromBranch(branch));
    writeFileSync(
      lockPath,
      JSON.stringify(
        serializeWorktreeLeaseMetadata(
          buildWorktreeLeaseMetadata(branch, {
            kind: "hub",
            taskId: "bd-blocked",
            flowId: "no-review",
            batchId: "batch-blocked",
          }),
        ),
      ),
    );

    await updateMockTask(stateFile, "bd-blocked", (task) => {
      task.status = "open";
      task.labels = ["failed"];
      task.metadata = {
        ...task.metadata,
        hubStatus: "failed",
        failed: true,
        failureReason: "agent_failed",
        claim: claimResult.task.claim?.raw,
      };
    });

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId: "bd-blocked",
      env,
    });

    const task = loadHubTask(repoDir, "bd-blocked", env);
    expect(result.outcome).toBe("recovered_failed");
    expect(task.hubStatus).toBe("ready_for_agent");
    expect(task.claim).toBeUndefined();
    expect(
      await execAsync(`git branch --list "${branch}"`, { cwd: repoDir }),
    ).toMatchObject({
      stdout: expect.stringContaining(branch),
    });
    expect(result.summary).toContain("active worktree lease");
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "Cleanup skipped for",
    );
  });

  it("recovers close_failed tasks when the branch is already merged", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-close-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "main.txt", "main", "initial commit");

    const branch = "archloop/bd-close-close-failed-task";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });
    await execAsync(`git merge --no-ff "${branch}" -m "merge feature"`, {
      cwd: repoDir,
    });

    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
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
            branch,
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const merger = vi.fn<HubFlowMerger>(async () => ({ outcome: "success" }));
    const verifier = vi.fn<HubFlowVerifier>(async () => ({
      outcome: "success",
    }));

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId: "bd-close",
      env,
      verifier,
      merger,
    });

    const task = loadHubTask(repoDir, "bd-close", env);
    expect(result.outcome).toBe("recovered_close_failed");
    expect(task.hubStatus).toBe("done");
    expect(task.labels).toContain("done");
    expect(task.claim).toBeUndefined();
    expect(task.metadata.failureReason).toBeUndefined();
    expect(merger).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(await readFile(commentArgsFile, "utf-8")).toContain("close_failed");
    expect(await readFile(commentArgsFile, "utf-8")).toContain("merged");
  });
});

const phaseCompletionEvent = (
  overrides: Partial<HubTaskEvent>,
): HubTaskEvent => ({
  type: "task_review_succeeded",
  runId: "run-stale",
  batchId: "batch-stale",
  taskId: "bd-stale-exec",
  branch: "archloop/bd-stale-exec-stale-execution-task",
  createdAt: "2026-07-23T00:00:00.000Z",
  status: "waiting_for_merge",
  ...overrides,
});

describe("recoverHubTask event-aware stale execution", () => {
  it("routes a reviewing task whose review succeeded back to waiting_for_merge and preserves the claim", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-review-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const taskId = "bd-stale-review";
    const title = "Stale execution task";
    const branch = `archloop/${taskId}-stale-execution-task`;
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: {
            runId: "run-stale",
            batchId: "batch-stale",
            branch,
            claimedAt: "2026-07-23T00:00:00Z",
          },
        },
      },
    ]);

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId,
      env,
      resolveLatestPhaseCompletionEvent: async () =>
        phaseCompletionEvent({
          type: "task_review_succeeded",
          status: "waiting_for_merge",
          taskId,
          branch,
        }),
      branchHasUnmergedWork: async () => true,
    });

    const task = loadHubTask(repoDir, taskId, env);
    expect(result.outcome).toBe("recovered_failed");
    expect(result.priorStatus).toBe("reviewing");
    expect(task.hubStatus).toBe("waiting_for_merge");
    expect(task.claim).toBeDefined();
    expect(task.claim?.runId).toBe("run-stale");
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "task_review_succeeded",
    );
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "waiting_for_merge",
    );
  });

  it("routes an implementing task whose implementation succeeded (reviewer flow) to reviewing and preserves the claim", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-impl-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-stale-impl";
    const title = "Stale execution task";
    const branch = `archloop/${taskId}-stale-execution-task`;
    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["implementing"],
        metadata: {
          hubStatus: "implementing",
          claim: {
            runId: "run-stale",
            batchId: "batch-stale",
            branch,
            claimedAt: "2026-07-23T00:00:00Z",
          },
        },
      },
    ]);

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId,
      env,
      resolveLatestPhaseCompletionEvent: async () =>
        phaseCompletionEvent({
          type: "task_implementation_succeeded",
          status: "reviewing",
          taskId,
          branch,
        }),
      branchHasUnmergedWork: async () => true,
    });

    const task = loadHubTask(repoDir, taskId, env);
    expect(result.outcome).toBe("recovered_failed");
    expect(task.hubStatus).toBe("reviewing");
    expect(task.claim).toBeDefined();
    expect(task.claim?.runId).toBe("run-stale");
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "task_implementation_succeeded",
    );
  });

  it("routes an interrupted implementing task with no success event and branch commits to ready_for_agent and drops the claim (reuses preserved worktree)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-retry-work-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-stale-retry-work";
    const title = "Stale execution task";
    const branch = `archloop/${taskId}-stale-execution-task`;
    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["implementing"],
        metadata: {
          hubStatus: "implementing",
          claim: {
            runId: "run-stale",
            batchId: "batch-stale",
            branch,
            claimedAt: "2026-07-23T00:00:00Z",
          },
        },
      },
    ]);

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId,
      env,
      resolveLatestPhaseCompletionEvent: async () => undefined,
      branchHasUnmergedWork: async () => true,
    });

    const task = loadHubTask(repoDir, taskId, env);
    expect(result.outcome).toBe("recovered_failed");
    expect(task.hubStatus).toBe("ready_for_agent");
    expect(task.claim).toBeUndefined();
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "reuses the preserved worktree",
    );
  });

  it("routes an interrupted implementing task with no success event and no branch commits to ready_for_agent for a fresh implement", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-fresh-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-stale-fresh";
    const title = "Stale execution task";
    const branch = `archloop/${taskId}-stale-execution-task`;
    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["implementing"],
        metadata: {
          hubStatus: "implementing",
          claim: {
            runId: "run-stale",
            batchId: "batch-stale",
            branch,
            claimedAt: "2026-07-23T00:00:00Z",
          },
        },
      },
    ]);

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId,
      env,
      resolveLatestPhaseCompletionEvent: async () => undefined,
      branchHasUnmergedWork: async () => false,
    });

    const task = loadHubTask(repoDir, taskId, env);
    expect(result.outcome).toBe("recovered_failed");
    expect(task.hubStatus).toBe("ready_for_agent");
    expect(task.claim).toBeUndefined();
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "fresh implement",
    );
  });

  it("routes a reviewing task flagged with a human failure reason to ready_for_human (story 17 — override not bypassed for stale execution)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-human-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-stale-human";
    const title = "Stale execution task";
    const branch = `archloop/${taskId}-stale-execution-task`;
    const stateFile = join(repoDir, "bd-state.json");
    // A reviewing task flagged with a human-failure reason projects as
    // `failed` (truthy failureReason metadata drives the projection), so
    // recovery runs the failed path. With no unmerged branch work, the
    // human-failure override must route it to ready_for_human rather than
    // ready_for_agent — the existing failure-reason routing is not bypassed
    // for tasks originating from a stale execution. (The same override is
    // wired into recoverStaleExecutionStatus's ready_for_agent branch too, so
    // a future stale-execution task that carries a human reason would also
    // route to ready_for_human.)
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          failed: true,
          failureReason: "merge_conflict",
          claim: {
            runId: "run-stale",
            batchId: "batch-stale",
            branch,
            claimedAt: "2026-07-23T00:00:00Z",
          },
        },
      },
    ]);

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId,
      env,
      resolveLatestPhaseCompletionEvent: async () => undefined,
      branchHasUnmergedWork: async () => false,
    });

    const task = loadHubTask(repoDir, taskId, env);
    expect(result.outcome).toBe("recovered_failed");
    expect(task.hubStatus).toBe("ready_for_human");
    expect(task.claim).toBeUndefined();
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "ready_for_human",
    );
  });

  it("routes a reviewing HITL-slice task with no success event to ready_for_human and does not claim a human-failure reason", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-hitl-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-stale-hitl";
    const title = "Stale execution task";
    const branch = `archloop/${taskId}-stale-execution-task`;
    const stateFile = join(repoDir, "bd-state.json");
    // A reviewing task with no failure metadata projects as `reviewing` (it
    // takes the stale-execution path, not the failed path). Its HITL slice
    // type makes resolveFailedRecoveryTarget diverge from the router's base
    // ready_for_agent destination to ready_for_human. The override summary
    // must not claim the divergence came from a human-failure reason.
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          slice_type: "HITL",
          claim: {
            runId: "run-stale",
            batchId: "batch-stale",
            branch,
            claimedAt: "2026-07-23T00:00:00Z",
          },
        },
      },
    ]);

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId,
      env,
      resolveLatestPhaseCompletionEvent: async () => undefined,
      branchHasUnmergedWork: async () => false,
    });

    const task = loadHubTask(repoDir, taskId, env);
    expect(result.outcome).toBe("recovered_failed");
    expect(task.hubStatus).toBe("ready_for_human");
    expect(task.claim).toBeUndefined();
    const comment = await readFile(commentArgsFile, "utf-8");
    expect(comment).toContain("ready_for_human");
    expect(comment).toContain("overrides the default ready_for_agent");
    expect(comment).not.toContain("human-failure reason");
  });

  it("reads the phase-completion event from the run event log by default (no injected resolver)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-rundir-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-stale-rundir";
    const title = "Stale execution task";
    const branch = `archloop/${taskId}-stale-execution-task`;
    const stateFile = join(repoDir, "bd-state.json");
    const { env, commentArgsFile } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["merging"],
        metadata: {
          hubStatus: "merging",
          claim: {
            runId: "run-stale",
            batchId: "batch-stale",
            branch,
            claimedAt: "2026-07-23T00:00:00Z",
          },
        },
      },
    ]);

    // Lay out a real Hub run dir under a controlled XDG_DATA_HOME so the
    // default event reader scans it. The project id is sha256(repoRoot)[:12],
    // matching resolveHubProjectDir.
    const { createHash } = await import("node:crypto");
    const projectId = createHash("sha256")
      .update(repoDir)
      .digest("hex")
      .slice(0, 12);
    const runDir = join(
      repoDir,
      ".test-xdg-data",
      "archloop",
      "hub",
      "projects",
      projectId,
      "runs",
      "run-stale",
    );
    mkdirSync(join(runDir, "events"), { recursive: true });
    writeFileSync(
      join(runDir, "events", "task.jsonl"),
      `${JSON.stringify(
        phaseCompletionEvent({
          type: "task_review_succeeded",
          status: "waiting_for_merge",
          taskId,
          branch,
        }),
      )}\n`,
    );

    const result = await recoverHubTask({
      cwd: repoDir,
      taskId,
      env: { ...env, XDG_DATA_HOME: join(repoDir, ".test-xdg-data") },
      branchHasUnmergedWork: async () => true,
    });

    const task = loadHubTask(repoDir, taskId, env);
    expect(result.outcome).toBe("recovered_failed");
    expect(task.hubStatus).toBe("waiting_for_merge");
    expect(task.claim).toBeDefined();
    expect(task.claim?.runId).toBe("run-stale");
    expect(await readFile(commentArgsFile, "utf-8")).toContain(
      "task_review_succeeded",
    );
  });
});

// ---------------------------------------------------------------------------
// recoverStaleHubTasks — the `tasks recover --stale` batch path (arch-6y9).
// Loads the board + worktree leases + run events, detects interrupted
// executions via the shared detector, and routes each through the event-aware
// router. Dry-runs by default; applies only with `yes`. Tests inject the board,
// leases, event resolver, and a capturing recoverTask fake so the orchestration
// is exercised without a real Beads store (matching the PRD testing guidance).
// ---------------------------------------------------------------------------

const projection = (
  overrides: Partial<HubTaskProjection> & { id: string; title: string },
): HubTaskProjection => ({
  beadsStatus: "open",
  hubStatus: "ready_for_agent",
  claim: undefined,
  claimState: undefined,
  labels: [],
  metadata: {},
  description: undefined,
  notes: undefined,
  comments: [],
  remoteRefs: [],
  runRefs: [],
  ...overrides,
});

const claim = (taskId: string, branch: string) => ({
  runId: "run-stale",
  batchId: "batch-stale",
  taskId,
  branch,
  claimedAt: "2026-07-23T00:00:00Z",
  raw: {
    runId: "run-stale",
    batchId: "batch-stale",
    taskId,
    branch,
    claimedAt: "2026-07-23T00:00:00Z",
  },
});

const activeLease = (taskId: string, branch: string): WorktreeLeaseRecord => ({
  lockFileName: `${branch.replace(/\//g, "-")}.lock`,
  worktreeName: branch.replace(/\//g, "-"),
  branch,
  pid: 999_999,
  acquiredAt: "2026-07-23T00:00:00Z",
  owner: { kind: "hub", taskId, runId: "run-stale", batchId: "batch-stale" },
  state: "active",
  malformed: false,
});

describe("recoverStaleHubTasks", () => {
  it("dry-run previews the planned routing per interrupted task without mutating (story 10)", async () => {
    const reviewing = projection({
      id: "bd-review",
      title: "Review interrupted",
      hubStatus: "reviewing",
      claim: claim("bd-review", "archloop/bd-review-review-interrupted"),
      labels: ["reviewing"],
    });
    const implementing = projection({
      id: "bd-impl",
      title: "Implement interrupted",
      hubStatus: "implementing",
      claim: claim("bd-impl", "archloop/bd-impl-implement-interrupted"),
      labels: ["implementing"],
    });
    const live = projection({
      id: "bd-live",
      title: "Still running",
      hubStatus: "implementing",
      claim: claim("bd-live", "archloop/bd-live-still-running"),
      labels: ["implementing"],
    });
    const ready = projection({
      id: "bd-ready",
      title: "Ready task",
      hubStatus: "ready_for_agent",
      labels: ["ready-for-agent"],
    });

    const applied: string[] = [];
    const result = await recoverStaleHubTasks({
      cwd: "/repo",
      loadBoard: () => ({
        tasks: [reviewing, implementing, live, ready],
        groups: [],
      }),
      listLeases: () => [activeLease("bd-live", "archloop/bd-live-still-running")],
      resolveLatestPhaseCompletionEvent: async ({ taskId }) =>
        taskId === "bd-review"
          ? phaseCompletionEvent({
              type: "task_review_succeeded",
              status: "waiting_for_merge",
              taskId: "bd-review",
              branch: "archloop/bd-review-review-interrupted",
            })
          : undefined,
      recoverTask: async () => {
        applied.push("called");
        return {} as never;
      },
    });

    expect(result.applied).toBe(false);
    expect(applied).toEqual([]); // dry run never mutates
    const byId = new Map(result.entries.map((entry) => [entry.taskId, entry]));
    expect([...byId.keys()].sort()).toEqual(["bd-impl", "bd-review"]);

    const reviewEntry = byId.get("bd-review");
    expect(reviewEntry?.phase).toBe("reviewing");
    expect(reviewEntry?.priorStatus).toBe("reviewing");
    expect(reviewEntry?.targetStatus).toBe("waiting_for_merge");
    expect(reviewEntry?.preserveClaim).toBe(true);
    expect(reviewEntry?.reason).toContain("task_review_succeeded");
    expect(reviewEntry?.outcome).toBeUndefined();

    const implEntry = byId.get("bd-impl");
    expect(implEntry?.phase).toBe("implementing");
    expect(implEntry?.targetStatus).toBe("ready_for_agent");
    expect(implEntry?.preserveClaim).toBe(false);
  });

  it("applies the recovery per task only when yes is passed and records outcomes (story 9, 11)", async () => {
    const merging = projection({
      id: "bd-merge",
      title: "Merge interrupted",
      hubStatus: "merging",
      claim: claim("bd-merge", "archloop/bd-merge-merge-interrupted"),
      labels: ["merging"],
    });

    const calls: string[] = [];
    const result = await recoverStaleHubTasks({
      cwd: "/repo",
      yes: true,
      loadBoard: () => ({ tasks: [merging], groups: [] }),
      listLeases: () => [],
      resolveLatestPhaseCompletionEvent: async () =>
        phaseCompletionEvent({
          type: "task_review_succeeded",
          status: "waiting_for_merge",
          taskId: "bd-merge",
          branch: "archloop/bd-merge-merge-interrupted",
        }),
      recoverTask: async (input) => {
        calls.push(input.taskId);
        return {
          outcome: "recovered_failed",
          priorStatus: "merging",
          hubStatus: "waiting_for_merge",
          summary: "recovered",
          task: merging,
        };
      },
    });

    expect(result.applied).toBe(true);
    expect(calls).toEqual(["bd-merge"]);
    expect(result.entries[0]?.outcome).toBe("recovered_failed");
  });

  it("reports no interrupted tasks as an empty plan without applying", async () => {
    const result = await recoverStaleHubTasks({
      cwd: "/repo",
      yes: true,
      loadBoard: () => ({
        tasks: [
          projection({
            id: "bd-ready",
            title: "Ready",
            hubStatus: "ready_for_agent",
          }),
        ],
        groups: [],
      }),
      listLeases: () => [],
      recoverTask: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.applied).toBe(false);
    expect(result.entries).toEqual([]);
  });

  it("uses the default board and lease loaders against a real repo (no lease => interrupted)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-recover-stale-default-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const taskId = "bd-stale-batch";
    const title = "Stale batch task";
    const branch = `archloop/${taskId}-stale-batch-task`;
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: taskId,
        title,
        status: "open",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: claim(taskId, branch),
        },
      },
    ]);

    // No worktree lease exists, so the task is interrupted. Seed a run event log
    // showing review already succeeded so the route preserves the claim and
    // advances to waiting_for_merge rather than re-implementing.
    const { createHash } = await import("node:crypto");
    const projectId = createHash("sha256")
      .update(repoDir)
      .digest("hex")
      .slice(0, 12);
    const runDir = join(
      repoDir,
      ".test-xdg-data",
      "archloop",
      "hub",
      "projects",
      projectId,
      "runs",
      "run-stale",
    );
    mkdirSync(join(runDir, "events"), { recursive: true });
    writeFileSync(
      join(runDir, "events", "task.jsonl"),
      `${JSON.stringify(
        phaseCompletionEvent({
          type: "task_review_succeeded",
          status: "waiting_for_merge",
          taskId,
          branch,
        }),
      )}\n`,
    );

    const plan = await recoverStaleHubTasks({
      cwd: repoDir,
      env: { ...env, XDG_DATA_HOME: join(repoDir, ".test-xdg-data") },
      branchHasUnmergedWork: async () => true,
    });

    expect(plan.applied).toBe(false);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.taskId).toBe(taskId);
    expect(plan.entries[0]?.targetStatus).toBe("waiting_for_merge");
    expect(plan.entries[0]?.preserveClaim).toBe(true);

    // Dry run did not mutate the task store.
    const task = loadHubTask(repoDir, taskId, env);
    expect(task.hubStatus).toBe("reviewing");
  });
});

describe("planStaleExecutionRecovery", () => {
  it("preserves the claim and advances to waiting_for_merge when review succeeded", () => {
    const task = projection({
      id: "bd-x",
      title: "T",
      hubStatus: "merging",
    });
    const plan = planStaleExecutionRecovery(
      task,
      phaseCompletionEvent({
        type: "task_review_succeeded",
        status: "waiting_for_merge",
        taskId: "bd-x",
      }),
      true,
    );
    expect(plan).toMatchObject({
      priorStatus: "merging",
      targetStatus: "waiting_for_merge",
      preserveClaim: true,
    });
  });

  it("routes an interrupted task with no event to ready_for_agent and drops the claim", () => {
    const plan = planStaleExecutionRecovery(
      projection({ id: "bd-y", title: "T", hubStatus: "implementing" }),
      undefined,
      false,
    );
    expect(plan.targetStatus).toBe("ready_for_agent");
    expect(plan.preserveClaim).toBe(false);
  });
});

describe("formatStaleHubTaskRecoveryLines", () => {
  it("reports no interrupted tasks for an empty plan", () => {
    const lines = formatStaleHubTaskRecoveryLines({ applied: false, entries: [] });
    expect(lines).toContain("Stale execution recovery");
    expect(lines).toContain("No interrupted tasks found on the board.");
  });

  it("labels a dry-run plan as planned and hints at --yes", () => {
    const lines = formatStaleHubTaskRecoveryLines({
      applied: false,
      entries: [
        {
          taskId: "bd-a",
          title: "T",
          phase: "reviewing",
          priorStatus: "reviewing",
          targetStatus: "waiting_for_merge",
          preserveClaim: true,
          reason: "review finished",
        },
      ],
    });
    expect(lines.some((l) => l.includes("Planned recovery for 1"))).toBe(true);
    expect(lines.some((l) => l.includes("bd-a: reviewing -> waiting_for_merge"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("preserve claim"))).toBe(true);
    expect(lines.some((l) => l.includes("Re-run with --yes"))).toBe(true);
  });

  it("labels an applied result as applied with the recorded outcome", () => {
    const lines = formatStaleHubTaskRecoveryLines({
      applied: true,
      entries: [
        {
          taskId: "bd-a",
          title: "T",
          phase: "implementing",
          priorStatus: "implementing",
          targetStatus: "ready_for_agent",
          preserveClaim: false,
          reason: "fresh retry",
          outcome: "recovered_failed",
        },
      ],
    });
    expect(lines.some((l) => l.includes("Applied recovery for 1"))).toBe(true);
    expect(lines.some((l) => l.includes("release claim"))).toBe(true);
    expect(lines.some((l) => l.includes("[recovered_failed]"))).toBe(true);
    expect(lines.some((l) => l.includes("Re-run with --yes"))).toBe(false);
  });
});
