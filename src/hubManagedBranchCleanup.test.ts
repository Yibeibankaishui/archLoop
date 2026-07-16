import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { claimHubTaskForImplementation } from "./hubTaskLifecycle.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";
import { evaluateHubManagedBranchCleanup } from "./hubManagedBranchCleanup.js";
import {
  buildWorktreeLeaseMetadata,
  leaseLockPath,
  leaseNameFromBranch,
  serializeWorktreeLeaseMetadata,
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

const writeMockBd = async (repoDir: string, tasks: unknown[]) => {
  seedHubTaskStoreMetadata(repoDir);
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  const stateFile = join(repoDir, "bd-state.json");
  await writeFile(stateFile, JSON.stringify(tasks, null, 2));

  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const args = process.argv.slice(2);
const [command, id] = args;
const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (value) => fs.writeFileSync(stateFile, JSON.stringify(value, null, 2));
if (command === "show" && id) {
  const task = state().find((entry) => entry.id === id);
  if (!task) process.exit(1);
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}
if (command === "update" && id) {
  const current = state();
  const task = current.find((entry) => entry.id === id);
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
  writeState(current);
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
    },
  };
};

describe("Hub managed branch cleanup", () => {
  it("classifies safe managed, blocked managed, and unowned candidates", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-cleanup-eval-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const hubProjectDir = join(repoDir, "hub-project");

    const safeState = await writeMockBd(repoDir, [
      {
        id: "bd-safe",
        title: "Safe branch",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-legacy",
        title: "Legacy branch",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const safeClaim = await claimHubTaskForImplementation({
      cwd: repoDir,
      taskId: "bd-safe",
      branch: "archloop/bd-safe-safe-branch",
      hubProjectDir,
      env: safeState.env,
    });
    await execAsync("git branch archloop/bd-safe-safe-branch", {
      cwd: repoDir,
    });

    await execAsync("git branch archloop/bd-legacy-legacy-branch", {
      cwd: repoDir,
    });
    const legacyClaim = await claimHubTaskForImplementation({
      cwd: repoDir,
      taskId: "bd-legacy",
      branch: "archloop/bd-legacy-legacy-branch",
      hubProjectDir,
      env: safeState.env,
    });

    await execAsync("git branch archloop/unowned-history", { cwd: repoDir });

    const result = await evaluateHubManagedBranchCleanup({
      cwd: repoDir,
      hubProjectDir,
      env: safeState.env,
    });

    expect(result.targetBranch).toBe("main");
    expect(
      result.managedSafeCandidates.map((candidate) => candidate.branch),
    ).toEqual(["archloop/bd-safe-safe-branch"]);
    expect(
      result.managedBlockedBranches.map((candidate) => candidate.branch),
    ).toEqual(["archloop/bd-legacy-legacy-branch"]);
    expect(result.managedBlockedBranches[0]?.skipReasons).toEqual([
      expect.objectContaining({
        reason: "branch_existed_before_claim",
      }),
    ]);
    expect(
      result.unownedCandidates.map((candidate) => candidate.branch),
    ).toEqual(["archloop/unowned-history"]);
    expect(result.unownedCandidates[0]?.skipReasons).toEqual([
      expect.objectContaining({
        reason: "missing_ownership",
      }),
    ]);
    expect(safeClaim.task.claim).toMatchObject({
      branchExistedBeforeClaim: false,
    });
    expect(legacyClaim.task.claim).toMatchObject({
      branchExistedBeforeClaim: true,
    });
  });

  it("reports missing branches and active worktree leases", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-cleanup-missing-lease-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const hubProjectDir = join(repoDir, "hub-project");

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-missing",
        title: "Missing branch",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
      {
        id: "bd-lease",
        title: "Active lease",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    await claimHubTaskForImplementation({
      cwd: repoDir,
      taskId: "bd-missing",
      branch: "archloop/bd-missing-missing-branch",
      hubProjectDir,
      env,
    });

    const leaseBranch = "archloop/bd-lease-active-lease";
    await claimHubTaskForImplementation({
      cwd: repoDir,
      taskId: "bd-lease",
      branch: leaseBranch,
      hubProjectDir,
      env,
    });
    await execAsync(`git branch ${leaseBranch}`, { cwd: repoDir });
    mkdirSync(join(repoDir, ".archloop", "locks"), { recursive: true });
    const lockPath = leaseLockPath(repoDir, leaseNameFromBranch(leaseBranch));
    writeFileSync(
      lockPath,
      JSON.stringify(
        serializeWorktreeLeaseMetadata(
          buildWorktreeLeaseMetadata(leaseBranch, {
            kind: "hub",
            taskId: "bd-lease",
            flowId: "no-review",
            batchId: "batch-lease",
          }),
        ),
      ),
    );

    const result = await evaluateHubManagedBranchCleanup({
      cwd: repoDir,
      hubProjectDir,
      env,
    });

    expect(result.managedBlockedBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: "archloop/bd-missing-missing-branch",
          skipReasons: expect.arrayContaining([
            expect.objectContaining({ reason: "missing_branch" }),
          ]),
        }),
        expect.objectContaining({
          branch: leaseBranch,
          skipReasons: expect.arrayContaining([
            expect.objectContaining({ reason: "active_worktree_lease" }),
          ]),
        }),
      ]),
    );
  });

  it("reports checked-out and dirty preserved worktree branches", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-cleanup-worktree-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const hubProjectDir = join(repoDir, "hub-project");

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-worktree",
        title: "Worktree branch",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
      },
    ]);

    const claim = await claimHubTaskForImplementation({
      cwd: repoDir,
      taskId: "bd-worktree",
      branch: "archloop/bd-worktree-cleanup-branch",
      hubProjectDir,
      env,
    });

    await execAsync(`git branch ${claim.task.claim?.branch}`, { cwd: repoDir });
    const worktreePath = join(repoDir, ".archloop", "worktrees", "bd-worktree");
    await execAsync(
      `git worktree add "${worktreePath}" "${claim.task.claim?.branch}"`,
      { cwd: repoDir },
    );
    await writeFile(join(worktreePath, "hello.txt"), "dirty change");

    const result = await evaluateHubManagedBranchCleanup({
      cwd: repoDir,
      hubProjectDir,
      env,
    });

    expect(result.managedBlockedBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: "archloop/bd-worktree-cleanup-branch",
          skipReasons: expect.arrayContaining([
            expect.objectContaining({ reason: "checked_out_worktree" }),
            expect.objectContaining({ reason: "dirty_preserved_worktree" }),
          ]),
        }),
      ]),
    );
  });
});
