import { exec } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  resolveGitRepoRoot,
  resolveHubProjectStatus,
  resolveSandcastleUserDataDir,
} from "./projectStatus.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

describe("resolveSandcastleUserDataDir", () => {
  it("prefers XDG_DATA_HOME and falls back to ~/.local/share", () => {
    expect(
      resolveSandcastleUserDataDir(
        { XDG_DATA_HOME: "/tmp/xdg-data" } as NodeJS.ProcessEnv,
        "/home/tester",
      ),
    ).toBe("/tmp/xdg-data/sandcastle");
    expect(
      resolveSandcastleUserDataDir({} as NodeJS.ProcessEnv, "/home/tester"),
    ).toBe("/home/tester/.local/share/sandcastle");
  });
});

describe("resolveGitRepoRoot", () => {
  it("resolves the canonical repo root from a subdirectory", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-status-"));
    await initRepo(repoDir);
    await writeFile(join(repoDir, "hello.txt"), "hello");
    await execAsync("git add hello.txt && git commit -m 'initial'", {
      cwd: repoDir,
    });

    const nestedDir = join(repoDir, "nested", "path");
    await mkdir(nestedDir, { recursive: true });
    expect(resolveGitRepoRoot(nestedDir)).toBe(repoDir);
  });
});

describe("resolveHubProjectStatus", () => {
  it("creates a hub project dir under the user data directory and reports zero counts when Beads is unavailable", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-status-"));
    await initRepo(repoDir);
    await writeFile(join(repoDir, "hello.txt"), "hello");
    await execAsync("git add hello.txt && git commit -m 'initial'", {
      cwd: repoDir,
    });

    const sandcastleUserDataDir = join(repoDir, "data", "sandcastle");
    const status = resolveHubProjectStatus({
      cwd: repoDir,
      sandcastleUserDataDir,
      detectBeadsAvailable: () => false,
    });

    expect(status.repoRoot).toBe(repoDir);
    expect(status.sandcastleUserDataDir).toBe(sandcastleUserDataDir);
    expect(status.projectRegistered).toBe(false);
    expect(status.beadsAvailable).toBe(false);
    expect(status.taskCounts).toEqual({ ready: 0, total: 0 });
    expect(status.hubProjectDir).toContain(
      join("data", "sandcastle", "hub", "projects"),
    );
    expect(status.hubProjectDir).toContain(join(repoDir, "data", "sandcastle"));

    const secondStatus = resolveHubProjectStatus({
      cwd: repoDir,
      sandcastleUserDataDir,
      detectBeadsAvailable: () => false,
    });
    expect(secondStatus.projectRegistered).toBe(true);
  });

  it("reports Beads counts when available", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-status-"));
    await initRepo(repoDir);
    await writeFile(join(repoDir, "hello.txt"), "hello");
    await execAsync("git add hello.txt && git commit -m 'initial'", {
      cwd: repoDir,
    });

    const status = resolveHubProjectStatus({
      cwd: repoDir,
      sandcastleUserDataDir: join(repoDir, "data", "sandcastle"),
      detectBeadsAvailable: () => true,
      countReadyTasks: () => 2,
      countTotalTasks: () => 7,
    });

    expect(status.beadsAvailable).toBe(true);
    expect(status.taskCounts).toEqual({ ready: 2, total: 7 });
  });
});
