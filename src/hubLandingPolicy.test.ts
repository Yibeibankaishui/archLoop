import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  configureHubLandingPolicy,
  ensureHubLandingPolicy,
  readHubLandingPolicy,
} from "./hubLandingPolicy.js";

const execFileAsync = promisify(execFile);

const initRepo = async (dir: string) => {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "hello.txt"), "hello\n");
  await execFileAsync("git", ["add", "hello.txt"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
};

const gitOid = async (cwd: string, rev: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", ["rev-parse", rev], { cwd });
  return stdout.trim();
};

describe("Hub landing policy", () => {
  it("pins the current host target branch on first ensure and defaults publication to off", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-policy-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "https://example.test/repo.git"],
      { cwd: repoDir },
    );
    const headOid = await gitOid(repoDir, "HEAD");

    const first = await ensureHubLandingPolicy({
      repoRoot: repoDir,
      hubProjectDir,
    });

    expect(first.created).toBe(true);
    expect(first.policy.hostTargetBranch).toBe("main");
    expect(first.policy.publishPolicy).toBe("off");
    expect(first.policy.remoteTarget).toBeUndefined();
    expect(first.policy.publishTargetRef).toMatch(/^refs\/archloop\/publish\//);
    expect(first.policy.fenceRef).toMatch(/^refs\/archloop\/fence\//);
    expect(first.policy.checkoutSyncPolicy).toBe("safe_fast_forward");
    expect(existsSync(join(hubProjectDir, "landing-policy.json"))).toBe(true);
    expect(await gitOid(repoDir, first.policy.publishTargetRef)).toBe(headOid);

    const second = await ensureHubLandingPolicy({
      repoRoot: repoDir,
      hubProjectDir,
    });
    expect(second.created).toBe(false);
    expect(second.policy).toEqual(first.policy);

    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    const third = await ensureHubLandingPolicy({
      repoRoot: repoDir,
      hubProjectDir,
    });
    expect(third.policy.hostTargetBranch).toBe("main");
  });

  it("lets project configure update publish policy without dirtying the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-landing-configure-"));
    const repoDir = join(root, "repo");
    const hubProjectDir = join(root, "hub-project");
    await mkdir(repoDir, { recursive: true });
    await initRepo(repoDir);
    await ensureHubLandingPolicy({ repoRoot: repoDir, hubProjectDir });

    const configured = await configureHubLandingPolicy({
      repoRoot: repoDir,
      hubProjectDir,
      publishPolicy: "best_effort",
      remoteTarget: "origin/main",
    });

    expect(configured.policy.publishPolicy).toBe("best_effort");
    expect(configured.policy.remoteTarget).toBe("origin/main");
    expect(configured.policy.hostTargetBranch).toBe("main");
    expect(readHubLandingPolicy(hubProjectDir)?.publishPolicy).toBe(
      "best_effort",
    );

    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repoDir,
    });
    expect(stdout).toBe("");
  });
});
