import { exec } from "node:child_process";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { HubProjectRegistryError } from "./errors.js";
import { registerHubProject } from "./hubProjectRegistry.js";
import { resolveHubProjectTarget } from "./hubProjectTargetResolver.js";

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

describe("hubProjectTargetResolver", () => {
  it("resolves explicit project names to registered Hub project ids", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hub-target-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const repoA = await mkdtemp(join(tmpdir(), "hub-target-a-"));
    await initRepo(repoA);
    await commitFile(repoA, "hello.txt", "alpha", "initial");

    const repoB = await mkdtemp(join(tmpdir(), "hub-target-b-"));
    await initRepo(repoB);
    await commitFile(repoB, "hello.txt", "beta", "initial");

    const alpha = registerHubProject({
      repoPath: repoA,
      projectName: "alpha",
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    registerHubProject({
      repoPath: repoB,
      projectName: "beta",
      env,
      now: new Date("2026-07-04T12:01:00.000Z"),
    });

    const resolved = await resolveHubProjectTarget({
      env,
      projectSelector: "alpha",
    });

    expect(resolved.source).toBe("explicit");
    expect(resolved.project.id).toBe(alpha.project.id);
    expect(resolved.project.repoRoot).toBe(alpha.project.repoRoot);
  });

  it("uses the selected Hub project when no explicit target is provided", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hub-target-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const repoA = await mkdtemp(join(tmpdir(), "hub-target-a-"));
    await initRepo(repoA);
    await commitFile(repoA, "hello.txt", "alpha", "initial");

    const repoB = await mkdtemp(join(tmpdir(), "hub-target-b-"));
    await initRepo(repoB);
    await commitFile(repoB, "hello.txt", "beta", "initial");

    registerHubProject({
      repoPath: repoA,
      projectName: "alpha",
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const beta = registerHubProject({
      repoPath: repoB,
      projectName: "beta",
      env,
      now: new Date("2026-07-04T12:01:00.000Z"),
    });

    const resolved = await resolveHubProjectTarget({ env });

    expect(resolved.source).toBe("selected");
    expect(resolved.project.id).toBe(beta.project.id);
    expect(resolved.project.repoRoot).toBe(beta.project.repoRoot);
  });

  it("opens the project picker in TTYs when no project is selected", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hub-target-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const repo = await mkdtemp(join(tmpdir(), "hub-target-prompt-"));
    await initRepo(repo);
    await commitFile(repo, "hello.txt", "hello", "initial");

    const project = registerHubProject({
      repoPath: repo,
      projectName: "alpha",
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    await unlink(join(dataDir, "archloop", "hub", "selected-project.json"));

    const promptedProjects: string[] = [];
    const resolved = await resolveHubProjectTarget({
      env,
      isTTY: true,
      selectProject: async (projects) => {
        promptedProjects.push(...projects.map((entry) => entry.name));
        return "alpha";
      },
    });

    expect(promptedProjects).toEqual(["alpha"]);
    expect(resolved.source).toBe("interactive");
    expect(resolved.project.id).toBe(project.project.id);
  });

  it("fails in non-interactive mode when no project is selected", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hub-target-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const repo = await mkdtemp(join(tmpdir(), "hub-target-prompt-"));
    await initRepo(repo);
    await commitFile(repo, "hello.txt", "hello", "initial");

    registerHubProject({
      repoPath: repo,
      projectName: "alpha",
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    await unlink(join(dataDir, "archloop", "hub", "selected-project.json"));

    await expect(
      resolveHubProjectTarget({
        env,
        isTTY: false,
      }),
    ).rejects.toMatchObject({
      message:
        "No selected Hub project exists. Run `archloop project add` to register one, `archloop project select <name>` to choose one, or pass `--project <name>`.",
    });
  });

  it("rejects unknown explicit project names with selection guidance", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hub-target-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const repo = await mkdtemp(join(tmpdir(), "hub-target-prompt-"));
    await initRepo(repo);
    await commitFile(repo, "hello.txt", "hello", "initial");

    registerHubProject({
      repoPath: repo,
      projectName: "alpha",
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });

    await expect(
      resolveHubProjectTarget({
        env,
        projectSelector: "beta",
      }),
    ).rejects.toBeInstanceOf(HubProjectRegistryError);
    await expect(
      resolveHubProjectTarget({
        env,
        projectSelector: "beta",
      }),
    ).rejects.toMatchObject({
      message:
        'No Hub project named "beta". Run `archloop project list` to see registered projects.',
    });
  });
});
