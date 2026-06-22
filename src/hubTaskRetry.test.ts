import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { exec, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeLeaseError } from "./errors.js";
import {
  buildHubRetryPromptContext,
  detectPreservedHubTaskWorktree,
  prepareHubTaskRetry,
} from "./hubTaskRetry.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { leaseLockPath, leaseNameFromBranch } from "./WorktreeLease.js";

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

const setupRepo = async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "hub-retry-repo-"));
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello", "initial commit");
  return repoDir;
};

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
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

describe("hub task retry preparation", () => {
  it("detects a preserved managed worktree for a task branch", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/bd-retry-preserved-task";
    const worktree = await run(WorktreeManager.create(repoDir, { branch }));

    const preserved = await detectPreservedHubTaskWorktree(repoDir, branch);
    expect(preserved).toEqual({
      isRetry: true,
      preservedWorktreePath: worktree.path,
      hasDirtyWork: false,
    });
  });

  it("reports no preserved worktree for a fresh task branch", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/bd-retry-fresh-task";

    const preserved = await detectPreservedHubTaskWorktree(repoDir, branch);
    expect(preserved).toEqual({
      isRetry: false,
      preservedWorktreePath: undefined,
      hasDirtyWork: false,
    });
  });

  it("builds retry prompt context that tells the agent to inspect preserved work", () => {
    const context = buildHubRetryPromptContext({
      branch: "archloop/bd-retry-preserved-task",
      preservedWorktreePath: "/tmp/worktree",
      hasDirtyWork: true,
    });

    expect(context).toContain("# RETRY");
    expect(context.toLowerCase()).toContain("inspect existing work");
    expect(context).toContain("archloop/bd-retry-preserved-task");
    expect(context).toContain("/tmp/worktree");
    expect(context).toContain("uncommitted changes");
    expect(context).not.toContain("starting from scratch without inspection");
  });

  it("returns empty retry prompt context for first-time implementation", () => {
    expect(
      buildHubRetryPromptContext({
        branch: "archloop/bd-retry-fresh-task",
        preservedWorktreePath: undefined,
        hasDirtyWork: false,
      }),
    ).toBe("");
  });

  it("reports active execution when a live worktree lease exists", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/bd-retry-active";
    await run(WorktreeManager.create(repoDir, { branch }));
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "hub",
        taskId: "bd-retry",
        flowId: "no-review",
        batchId: "batch-live",
        branch,
        pid: process.pid,
        acquiredAt: "2026-06-22T10:00:00.000Z",
      }),
    );

    const result = await prepareHubTaskRetry({
      repoDir,
      branch,
      taskId: "bd-retry",
    });

    expect(result.status).toBe("active_execution");
    if (result.status === "active_execution") {
      expect(result.message).toContain("already has active execution");
      expect(result.message).toContain("bd-retry");
      expect(result.lease.reason).toBe("active");
    }
  });

  it("clears a stale lease and allows retry from a preserved dirty worktree", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/bd-retry-stale-dirty";
    const worktree = await run(WorktreeManager.create(repoDir, { branch }));
    await writeFile(join(worktree.path, "partial.txt"), "wip\n");
    const deadPid = await spawnExitedPid();
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "hub",
        taskId: "bd-retry",
        flowId: "no-review",
        batchId: "batch-dead",
        branch,
        pid: deadPid,
        acquiredAt: "2026-06-22T09:00:00.000Z",
      }),
    );

    const result = await prepareHubTaskRetry({
      repoDir,
      branch,
      taskId: "bd-retry",
    });

    expect(result).toEqual({
      status: "ready",
      isRetry: true,
      preservedWorktreePath: worktree.path,
      hasDirtyWork: true,
      staleLeaseCleared: true,
    });
    expect(
      existsSync(leaseLockPath(repoDir, leaseNameFromBranch(branch))),
    ).toBe(false);
    expect(await readFile(join(worktree.path, "partial.txt"), "utf-8")).toBe(
      "wip\n",
    );
  });

  it("fails with a recovery diagnostic when lease metadata is malformed", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/bd-retry-malformed";
    await run(WorktreeManager.create(repoDir, { branch }));
    await writeLeaseFile(repoDir, branch, "{not-json");

    const result = await prepareHubTaskRetry({
      repoDir,
      branch,
      taskId: "bd-retry",
    });

    expect(result.status).toBe("lease_malformed");
    if (result.status === "lease_malformed") {
      expect(result.message).toContain("invalid metadata");
      expect(result.lease.reason).toBe("malformed");
    }
  });

  it("keeps the preserved worktree path stable across retry preparation", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/bd-retry-stable-path";
    const worktree = await run(WorktreeManager.create(repoDir, { branch }));

    const result = await prepareHubTaskRetry({
      repoDir,
      branch,
      taskId: "bd-retry",
    });

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.preservedWorktreePath).toBe(worktree.path);
    }
  });
});

describe("hub task retry lease errors", () => {
  it("preserves WorktreeLeaseError semantics for active execution", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/bd-retry-active-error";
    await run(WorktreeManager.create(repoDir, { branch }));
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "hub",
        taskId: "bd-retry",
        flowId: "no-review",
        batchId: "batch-live",
        branch,
        pid: process.pid,
        acquiredAt: "2026-06-22T10:00:00.000Z",
      }),
    );

    const result = await prepareHubTaskRetry({
      repoDir,
      branch,
      taskId: "bd-retry",
    });

    expect(result.status).toBe("active_execution");
    if (result.status === "active_execution") {
      expect(result.lease).toBeInstanceOf(WorktreeLeaseError);
    }
  });
});
