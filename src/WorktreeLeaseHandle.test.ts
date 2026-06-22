import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createWorktree } from "./createWorktree.js";
import { createSandbox } from "./createSandbox.js";
import {
  leaseLockPath,
  leaseNameFromBranch,
} from "./WorktreeLease.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";
import {
  createBindMountSandboxProvider,
} from "./SandboxProvider.js";

const execAsync = promisify(exec);

const testSandbox = createBindMountSandboxProvider({
  name: "test",
  create: async () => ({
    worktreePath: "/home/agent/workspace",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    copyFileIn: async () => {},
    copyFileOut: async () => {},
    close: async () => {},
  }),
});

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

const lockExists = async (repoDir: string, branch: string): Promise<boolean> => {
  try {
    await access(leaseLockPath(repoDir, leaseNameFromBranch(branch)));
    return true;
  } catch {
    return false;
  }
};

describe("long-lived handle worktree leases", () => {
  const tempDirs: string[] = [];

  const trackDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-lease-handle-"));
    tempDirs.push(dir);
    return dir;
  };

  const cleanup = async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  };

  it("createWorktree() holds a lease until close()", async () => {
    const hostDir = await trackDir();
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "lease-hold" },
      cwd: hostDir,
    });

    try {
      expect(await lockExists(hostDir, "lease-hold")).toBe(true);
      await ws.close();
      expect(await lockExists(hostDir, "lease-hold")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("createWorktree() keeps the lease across multiple handle operations", async () => {
    const hostDir = await trackDir();
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorktree({
      branchStrategy: { type: "branch", branch: "lease-multi-op" },
      cwd: hostDir,
    });

    try {
      expect(await lockExists(hostDir, "lease-multi-op")).toBe(true);
      // Simulate a second operation while the handle stays open.
      expect(ws.branch).toBe("lease-multi-op");
      expect(await lockExists(hostDir, "lease-multi-op")).toBe(true);
    } finally {
      await ws.close();
      await cleanup();
    }
  });

  it("createWorktree() rejects a second open handle for the same branch", async () => {
    const hostDir = await trackDir();
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws1 = await createWorktree({
      branchStrategy: { type: "branch", branch: "lease-conflict" },
      cwd: hostDir,
    });

    try {
      await expect(
        createWorktree({
          branchStrategy: { type: "branch", branch: "lease-conflict" },
          cwd: hostDir,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("in use"),
      });
    } finally {
      await ws1.close();
      await cleanup();
    }
  });

  it("createWorktree() releases the lease via await using", async () => {
    const hostDir = await trackDir();
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    {
      await using ws = await createWorktree({
        branchStrategy: { type: "branch", branch: "lease-dispose" },
        cwd: hostDir,
      });
      expect(await lockExists(hostDir, "lease-dispose")).toBe(true);
    }

    expect(await lockExists(hostDir, "lease-dispose")).toBe(false);
    await cleanup();
  });

  it("createWorktree() allows reuse after close when no active lease", async () => {
    const hostDir = await trackDir();
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws1 = await createWorktree({
      branchStrategy: { type: "branch", branch: "lease-reuse" },
      cwd: hostDir,
    });
    const path1 = ws1.worktreePath;
    await ws1.close();

    const ws2 = await createWorktree({
      branchStrategy: { type: "branch", branch: "lease-reuse" },
      cwd: hostDir,
    });

    try {
      expect(ws2.worktreePath).toBe(path1);
      expect(await lockExists(hostDir, "lease-reuse")).toBe(true);
    } finally {
      await ws2.close();
      await cleanup();
    }
  });

  it("createSandbox() holds a lease until close()", async () => {
    const hostDir = await trackDir();
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "sandbox-lease",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      expect(await lockExists(hostDir, "sandbox-lease")).toBe(true);
      await sandbox.close();
      expect(await lockExists(hostDir, "sandbox-lease")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("createSandbox() rejects a second open handle for the same branch", async () => {
    const hostDir = await trackDir();
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox1 = await createSandbox({
      branch: "sandbox-conflict",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      await expect(
        createSandbox({
          branch: "sandbox-conflict",
          sandbox: testSandbox,
          cwd: hostDir,
          _test: {
            buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
          },
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("in use"),
      });
    } finally {
      await sandbox1.close();
      await cleanup();
    }
  });

  it("createSandbox() allows dirty reuse after the first handle closes", async () => {
    const hostDir = await trackDir();
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox1 = await createSandbox({
      branch: "sandbox-dirty-reuse",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    await writeFile(
      join(sandbox1.worktreePath, "dirty.txt"),
      "uncommitted",
    );
    const path1 = sandbox1.worktreePath;
    await sandbox1.close();

    const sandbox2 = await createSandbox({
      branch: "sandbox-dirty-reuse",
      sandbox: testSandbox,
      cwd: hostDir,
      _test: {
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      expect(sandbox2.worktreePath).toBe(path1);
    } finally {
      await sandbox2.close();
      await rm(sandbox2.worktreePath, { recursive: true, force: true });
      await execAsync("git worktree prune", { cwd: hostDir });
      await cleanup();
    }
  });
});
