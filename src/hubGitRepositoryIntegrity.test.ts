import { exec } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  extractHubGitCommandDiagnostic,
  formatHubGitRepositoryIntegrityMessage,
  HUB_REPOSITORY_INTEGRITY_RECOVERY_GUIDANCE,
  inspectHubGitBranch,
} from "./hubGitRepositoryIntegrity.js";

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

const corruptBranchTip = async (repoDir: string, branch: string) => {
  const { stdout } = await execAsync(`git rev-parse ${branch}`, {
    cwd: repoDir,
  });
  const oid = stdout.trim();
  const objectPath = `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
  await execAsync(`chmod u+w ${objectPath}`, { cwd: repoDir });
  await execAsync(`truncate -s 0 ${objectPath}`, { cwd: repoDir });
};

describe("inspectHubGitBranch", () => {
  it("reports a missing branch without an integrity failure", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-git-missing-branch-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "initial");

    const result = await inspectHubGitBranch(
      repoDir,
      "archloop/bd-missing-task",
    );

    expect(result).toEqual({
      exists: false,
      hasUnmergedWork: false,
    });
    expect(result.integrityFailure).toBeUndefined();
  });

  it("reports corrupt branch tips as repository integrity failures", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-git-corrupt-branch-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "initial");
    const branch = "archloop/bd-corrupt-task";
    await execAsync(`git checkout -b ${branch}`, { cwd: repoDir });
    await commitFile(repoDir, "work.txt", "work\n", "task work");
    await execAsync("git checkout main", { cwd: repoDir });
    await corruptBranchTip(repoDir, branch);

    const result = await inspectHubGitBranch(repoDir, branch);

    expect(result.exists).toBe(true);
    expect(result.hasUnmergedWork).toBe(false);
    expect(result.integrityFailure).toMatchObject({
      command: `git rev-parse --verify ${branch}^{commit}`,
      repositoryPath: repoDir,
      ref: `refs/heads/${branch}`,
      exitCode: 128,
    });
    expect(result.integrityFailure?.stderr).toMatch(/corrupt|empty/i);
    expect(formatHubGitRepositoryIntegrityMessage({
      branch,
      diagnostic: result.integrityFailure!,
    })).toMatch(/Repository integrity failure for branch/);
    expect(HUB_REPOSITORY_INTEGRITY_RECOVERY_GUIDANCE).toMatch(/git fsck --full/);
  });

  it("keeps ordinary ahead-of-head branches merge-ready", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-git-ready-branch-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello\n", "initial");
    const branch = "archloop/bd-ready-task";
    await execAsync(`git checkout -b ${branch}`, { cwd: repoDir });
    await commitFile(repoDir, "work.txt", "work\n", "task work");
    await execAsync("git checkout main", { cwd: repoDir });

    const result = await inspectHubGitBranch(repoDir, branch);

    expect(result).toMatchObject({
      exists: true,
      hasUnmergedWork: true,
    });
    expect(result.changedFiles).toContain("work.txt");
    expect(result.integrityFailure).toBeUndefined();
  });

  it("extracts git command diagnostics from execFile failures", () => {
    const object = "0123456789abcdef0123456789abcdef01234567";
    const diagnostic = extractHubGitCommandDiagnostic({
      repositoryPath: "/repo",
      args: ["rev-parse", "--verify", "main^{commit}"],
      ref: "refs/heads/main",
      error: {
        code: 128,
        stderr: `error: object file .git/objects/${object.slice(0, 2)}/${object.slice(2)} is empty\nfatal: loose object ${object} is corrupt`,
      },
    });

    expect(diagnostic).toMatchObject({
      command: "git rev-parse --verify main^{commit}",
      exitCode: 128,
      repositoryPath: "/repo",
      ref: "refs/heads/main",
      object,
    });
  });
});
