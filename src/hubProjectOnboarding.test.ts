import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  recommendHubProjectProfile,
  resolveHubProjectRegistrationRepoRoot,
  suggestHubProjectName,
} from "./hubProjectOnboarding.js";

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

describe("hubProjectOnboarding", () => {
  it("suggests a friendly project name and a node profile from repo signals", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-onboarding-node-"));
    await initRepo(repoDir);
    await writeFile(join(repoDir, "pnpm-lock.yaml"), "lockfile\n");
    await commitFile(
      repoDir,
      "package.json",
      `${JSON.stringify({ name: "alpha-project" }, null, 2)}\n`,
      "initial commit",
    );

    expect(suggestHubProjectName(repoDir)).toBe("alpha-project");

    const recommendation = recommendHubProjectProfile(repoDir);
    expect(recommendation.projectProfileName).toBe("node");
    expect(recommendation.observedSignals).toContain("package.json");
    expect(recommendation.reason).toContain("package.json");
  });

  it("falls back to the generic profile when no stack signals are present", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-onboarding-generic-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const recommendation = recommendHubProjectProfile(repoDir);
    expect(recommendation.projectProfileName).toBe("generic");
    expect(recommendation.reason).toContain("No obvious stack signals");
    expect(suggestHubProjectName(repoDir)).toBe(basename(repoDir));
  });

  it("rejects repos without an initial commit", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-onboarding-empty-"));
    await initRepo(repoDir);

    expect(() => resolveHubProjectRegistrationRepoRoot(repoDir)).toThrow(
      /existing git repository with at least one commit/i,
    );
  });
});
