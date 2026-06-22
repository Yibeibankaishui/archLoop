import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeLeaseError } from "./errors.js";
import * as WorktreeManager from "./WorktreeManager.js";
import {
  acquireWorktreeLease,
  buildWorktreeLeaseMetadata,
  leaseLockPath,
  leaseNameFromBranch,
  pruneOrphanWorktreeLeases,
  releaseWorktreeLease,
  serializeWorktreeLeaseMetadata,
  worktreePathForBranch,
} from "./WorktreeLease.js";

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
  const repoDir = await mkdtemp(join(tmpdir(), "wt-lease-repo-"));
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

const runFail = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.flip(effect).pipe(
      Effect.provide(NodeFileSystem.layer),
    ) as Effect.Effect<E, never>,
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

describe("WorktreeLease stale recovery", () => {
  it("removes a stale lease when the owner process is dead and reacquires atomically", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/feature-a";
    const worktree = await run(WorktreeManager.create(repoDir, { branch }));
    const deadPid = await spawnExitedPid();
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "direct",
        pid: deadPid,
        branch,
        acquiredAt: "2026-06-22T10:00:00.000Z",
      }),
    );

    const lease = await run(acquireWorktreeLease(repoDir, { branch }));
    expect(lease.branch).toBe(branch);
    expect(lease.pid).toBe(process.pid);

    const lockContent = await readFile(
      leaseLockPath(repoDir, leaseNameFromBranch(branch)),
      "utf-8",
    );
    const parsed = JSON.parse(lockContent) as {
      pid: number;
      owner: string;
      branch: string;
      acquiredAt: string;
    };
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.owner).toBe("direct");
    expect(parsed.branch).toBe(branch);
    expect(parsed.acquiredAt).toBeTruthy();
    expect(parsed).not.toHaveProperty("prompt");
    expect(parsed).not.toHaveProperty("env");

    await run(releaseWorktreeLease(repoDir, branch));
    expect(worktree.path).toContain(leaseNameFromBranch(branch));
  });

  it("preserves dirty worktree contents after stale lease cleanup", async () => {
    const repoDir = await setupRepo();
    const branch = "dirty-feature";
    await execAsync(`git checkout -b ${branch}`, { cwd: repoDir });
    await commitFile(repoDir, "base.txt", "base", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const worktree = await run(WorktreeManager.create(repoDir, { branch }));
    const dirtyFile = join(worktree.path, "dirty-change.txt");
    await writeFile(dirtyFile, "keep-me");

    const deadPid = await spawnExitedPid();
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "direct",
        pid: deadPid,
        branch,
        acquiredAt: "2026-06-22T10:00:00.000Z",
      }),
    );

    await run(acquireWorktreeLease(repoDir, { branch }));
    await run(releaseWorktreeLease(repoDir, branch));

    expect(await readFile(dirtyFile, "utf-8")).toBe("keep-me");
    expect(
      await run(WorktreeManager.hasUncommittedChanges(worktree.path)),
    ).toBe(true);

    await run(WorktreeManager.remove(worktree.path));
  });

  it("prunes lease files when the corresponding worktree directory is missing", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/missing-wt";
    const leaseName = leaseNameFromBranch(branch);
    const lockPath = leaseLockPath(repoDir, leaseName);
    await mkdir(join(repoDir, ".archloop", "locks"), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        owner: "direct",
        pid: process.pid,
        branch,
        acquiredAt: "2026-06-22T10:00:00.000Z",
      }),
      "utf-8",
    );

    await run(pruneOrphanWorktreeLeases(repoDir));

    await expect(readFile(lockPath, "utf-8")).rejects.toThrow();
  });

  it("fails with a recovery diagnostic when lease metadata is malformed", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/bad-meta";
    await run(WorktreeManager.create(repoDir, { branch }));
    await writeLeaseFile(repoDir, branch, "{ not valid json");

    const err = (await runFail(
      acquireWorktreeLease(repoDir, { branch }),
    )) as WorktreeLeaseError;
    expect(err).toBeInstanceOf(WorktreeLeaseError);
    expect(err.reason).toBe("malformed");
    expect(err.message).toContain("invalid");
    expect(err.message).toMatch(/recovery/i);
    expect(err.leasePath).toBe(
      leaseLockPath(repoDir, leaseNameFromBranch(branch)),
    );
    expect(err.worktreePath).toBe(worktreePathForBranch(repoDir, branch));
  });

  it("fails fast when an active lease owner process is still alive", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/active";
    await run(WorktreeManager.create(repoDir, { branch }));
    const acquiredAt = "2026-06-22T10:00:00.000Z";
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "direct",
        pid: process.pid,
        branch,
        acquiredAt,
      }),
    );

    const err = (await runFail(
      acquireWorktreeLease(repoDir, { branch }),
    )) as WorktreeLeaseError;
    expect(err).toBeInstanceOf(WorktreeLeaseError);
    expect(err.reason).toBe("active");
    expect(err.pid).toBe(process.pid);
    expect(err.acquiredAt).toBe(acquiredAt);
    expect(err.branch).toBe(branch);
    expect(err.worktreePath).toBe(worktreePathForBranch(repoDir, branch));
    expect(err.message).toContain("in use");
    expect(err.message).toMatch(/next action/i);
  });
});

describe("WorktreeLease Hub owner metadata", () => {
  it("records task-first Hub owner metadata without sensitive execution content", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/arch-cml";
    await run(WorktreeManager.create(repoDir, { branch }));

    const lease = await run(
      acquireWorktreeLease(repoDir, {
        branch,
        owner: {
          kind: "hub",
          taskId: "arch-cml",
          flowId: "with-review",
          batchId: "batch-123",
        },
      }),
    );

    expect(lease.owner).toBe("hub");
    expect(lease.taskId).toBe("arch-cml");
    expect(lease.flowId).toBe("with-review");
    expect(lease.batchId).toBe("batch-123");

    const lockContent = await readFile(
      leaseLockPath(repoDir, leaseNameFromBranch(branch)),
      "utf-8",
    );
    const parsed = JSON.parse(lockContent) as Record<string, unknown>;
    expect(parsed).toEqual({
      owner: "hub",
      taskId: "arch-cml",
      flowId: "with-review",
      batchId: "batch-123",
      branch,
      pid: process.pid,
      acquiredAt: expect.any(String),
    });
    expect(parsed).not.toHaveProperty("prompt");
    expect(parsed).not.toHaveProperty("commandLine");
    expect(parsed).not.toHaveProperty("env");
    expect(parsed).not.toHaveProperty("taskContent");

    await run(releaseWorktreeLease(repoDir, branch));
  });

  it("keeps direct owner metadata without Hub fields", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/direct-only";
    await run(WorktreeManager.create(repoDir, { branch }));

    await run(acquireWorktreeLease(repoDir, { branch }));

    const lockContent = await readFile(
      leaseLockPath(repoDir, leaseNameFromBranch(branch)),
      "utf-8",
    );
    const parsed = JSON.parse(lockContent) as Record<string, unknown>;
    expect(parsed.owner).toBe("direct");
    expect(parsed).not.toHaveProperty("taskId");
    expect(parsed).not.toHaveProperty("flowId");
    expect(parsed).not.toHaveProperty("batchId");

    await run(releaseWorktreeLease(repoDir, branch));
  });

  it("drops sensitive fields when serializing lease metadata", () => {
    const metadata = buildWorktreeLeaseMetadata("archloop/task", {
      kind: "hub",
      taskId: "arch-cml",
      flowId: "with-review",
      batchId: "batch-123",
    });
    const polluted = Object.assign(metadata, {
      prompt: "secret prompt",
      commandLine: "archloop run --prompt-file task.md",
      env: { API_KEY: "secret" },
      taskContent: "user task body",
    });

    const serialized = serializeWorktreeLeaseMetadata(polluted);

    expect(serialized).not.toHaveProperty("prompt");
    expect(serialized).not.toHaveProperty("commandLine");
    expect(serialized).not.toHaveProperty("env");
    expect(serialized).not.toHaveProperty("taskContent");
    expect(serialized.taskId).toBe("arch-cml");
  });

  it("reports Hub active execution instead of a raw lock failure", async () => {
    const repoDir = await setupRepo();
    const branch = "archloop/hub-active";
    await run(WorktreeManager.create(repoDir, { branch }));
    await writeLeaseFile(
      repoDir,
      branch,
      JSON.stringify({
        owner: "hub",
        taskId: "arch-cml",
        flowId: "with-review",
        batchId: "batch-456",
        branch,
        pid: process.pid,
        acquiredAt: "2026-06-22T10:00:00.000Z",
      }),
    );

    const err = (await runFail(
      acquireWorktreeLease(repoDir, {
        branch,
        owner: {
          kind: "hub",
          taskId: "arch-cml-2",
          flowId: "with-review",
          batchId: "batch-789",
        },
      }),
    )) as WorktreeLeaseError;

    expect(err.reason).toBe("active");
    expect(err.taskId).toBe("arch-cml");
    expect(err.flowId).toBe("with-review");
    expect(err.batchId).toBe("batch-456");
    expect(err.message).toContain("already has active execution");
    expect(err.message).not.toContain("lock");
  });
});

describe("WorktreeLease reuse without active lease", () => {
  it("allows clean worktree reuse after the previous lease is released", async () => {
    const repoDir = await setupRepo();
    const branch = "feature/clean-reuse";
    await execAsync(`git checkout -b ${branch}`, { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(WorktreeManager.create(repoDir, { branch }));
    await run(releaseWorktreeLease(repoDir, branch));

    await run(acquireWorktreeLease(repoDir, { branch }));
    const second = await run(WorktreeManager.create(repoDir, { branch }));
    await run(releaseWorktreeLease(repoDir, branch));

    expect(second.path).toBe(first.path);

    await run(WorktreeManager.remove(first.path));
  });

  it("allows dirty worktree reuse after the previous lease is released", async () => {
    const repoDir = await setupRepo();
    const branch = "feature/dirty-reuse";
    await execAsync(`git checkout -b ${branch}`, { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const worktree = await run(WorktreeManager.create(repoDir, { branch }));
    await writeFile(join(worktree.path, "dirty.txt"), "dirty");
    await run(releaseWorktreeLease(repoDir, branch));

    await run(acquireWorktreeLease(repoDir, { branch }));
    const reused = await run(WorktreeManager.create(repoDir, { branch }));
    await run(releaseWorktreeLease(repoDir, branch));

    expect(reused.path).toBe(worktree.path);
    expect(await readFile(join(worktree.path, "dirty.txt"), "utf-8")).toBe(
      "dirty",
    );

    await run(WorktreeManager.remove(worktree.path));
  });

  it("blocks reuse when an active lease exists even for a dirty worktree", async () => {
    const repoDir = await setupRepo();
    const branch = "feature/active-dirty";
    await execAsync(`git checkout -b ${branch}`, { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const worktree = await run(WorktreeManager.create(repoDir, { branch }));
    await writeFile(join(worktree.path, "dirty.txt"), "dirty");

    const holder = await run(acquireWorktreeLease(repoDir, { branch }));

    const err = (await runFail(
      acquireWorktreeLease(repoDir, { branch }),
    )) as WorktreeLeaseError;
    expect(err.reason).toBe("active");
    expect(err.worktreePath).toBe(holder.worktreePath);

    await run(releaseWorktreeLease(repoDir, branch));
    await run(WorktreeManager.remove(worktree.path));
  });
});
