import { exec } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  listHubProjects,
  registerHubProject,
  resolveRegisteredHubProjectDir,
  resolveSelectedHubProject,
} from "./hubProjectRegistry.js";
import {
  resolveArchloopUserDataDir,
  resolveGitRepoRoot,
} from "./projectStatus.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

describe("hubProjectRegistry", () => {
  it("registers a project from an explicit path and persists the selected Hub project", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-project-registry-"));
    await initRepo(repoDir);
    await writeFile(join(repoDir, "package.json"), "{}\n");
    await execAsync("git add package.json && git commit -m 'initial'", {
      cwd: repoDir,
    });

    const nestedRepoPath = join(repoDir, "nested", "path");
    await mkdir(nestedRepoPath, { recursive: true });
    const originalCwd = process.cwd();
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "hub-project-registry-cwd-"));
    const registryDataDir = join(repoDir, "archloop-data");
    const env = { ...process.env, XDG_DATA_HOME: registryDataDir };
    const userDataDir = resolveArchloopUserDataDir(env, "/unused");

    try {
      process.chdir(unrelatedCwd);

      const registered = registerHubProject({
        repoPath: nestedRepoPath,
        projectName: "alpha",
        env,
        now: new Date("2026-07-04T15:00:00.000Z"),
      });

      const listed = listHubProjects({ env });
      const selected = resolveSelectedHubProject({ env });

      expect(registered.project.id).toBeTruthy();
      expect(registered.project.repoRoot).toBe(resolveGitRepoRoot(repoDir));
      expect(registered.project.hubProjectDir).toBe(
        resolveRegisteredHubProjectDir(userDataDir, registered.project.id),
      );
      expect(registered.project.projectProfile).toBe("generic");
      expect(registered.selectedProjectId).toBe(registered.project.id);
      expect(listed).toEqual([
        expect.objectContaining({
          id: registered.project.id,
          name: "alpha",
          repoRoot: resolveGitRepoRoot(repoDir),
          selected: true,
        }),
      ]);
      expect(selected).toEqual(
        expect.objectContaining({
          id: registered.project.id,
          name: "alpha",
        }),
      );
      expect(selected?.hubProjectDir).toBe(registered.project.hubProjectDir);
      expect(process.cwd()).not.toBe(originalCwd);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects duplicate project names and duplicate repo paths", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hub-project-registry-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const repoA = await mkdtemp(join(tmpdir(), "hub-project-registry-a-"));
    await initRepo(repoA);
    await writeFile(join(repoA, "package.json"), "{}\n");
    await execAsync("git add package.json && git commit -m 'initial'", {
      cwd: repoA,
    });

    const repoB = await mkdtemp(join(tmpdir(), "hub-project-registry-b-"));
    await initRepo(repoB);
    await writeFile(join(repoB, "package.json"), "{}\n");
    await execAsync("git add package.json && git commit -m 'initial'", {
      cwd: repoB,
    });

    registerHubProject({
      repoPath: repoA,
      projectName: "alpha",
      env,
      now: new Date("2026-07-04T15:00:00.000Z"),
    });

    expect(() =>
      registerHubProject({
        repoPath: repoB,
        projectName: "alpha",
        env,
        now: new Date("2026-07-04T15:01:00.000Z"),
      }),
    ).toThrow(/already registered/i);

    expect(() =>
      registerHubProject({
        repoPath: repoA,
        projectName: "beta",
        env,
        now: new Date("2026-07-04T15:02:00.000Z"),
      }),
    ).toThrow(/already registered/i);
  });
});
