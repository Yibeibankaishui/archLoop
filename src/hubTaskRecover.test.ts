import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { HubFlowMerger, HubFlowVerifier } from "./hubBatchMerge.js";
import { claimHubTaskForImplementation } from "./hubTaskLifecycle.js";
import {
  buildWorktreeLeaseMetadata,
  leaseLockPath,
  leaseNameFromBranch,
  serializeWorktreeLeaseMetadata,
} from "./WorktreeLease.js";
import {
  formatHubRecoveryComment,
  isHubRecoveryComment,
  recoverHubTask,
} from "./hubTaskRecover.js";
import { loadHubTask } from "./taskBoard.js";

const execAsync = promisify(exec);

const seedHubTaskStore = (repoDir: string): void => {
  const beadsDir = join(repoDir, ".beads");
  mkdirSync(beadsDir, { recursive: true });
  const metadataPath = join(beadsDir, "metadata.json");
  if (!existsSync(metadataPath)) {
    writeFileSync(metadataPath, JSON.stringify({ backend: "dolt" }));
  }
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
  const state = JSON.parse(await readFile(stateFile, "utf-8")) as MockBeadsTask[];
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
    expect(await execAsync(`git branch --list "${branch}"`, { cwd: repoDir }))
      .toMatchObject({
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
    expect(await execAsync(`git branch --list "${branch}"`, { cwd: repoDir }))
      .toMatchObject({
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
    expect(await execAsync(`git branch --list "${branch}"`, { cwd: repoDir }))
      .toMatchObject({
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
