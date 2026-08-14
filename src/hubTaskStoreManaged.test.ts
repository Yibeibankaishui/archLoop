import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  initHubTaskStore,
  isHubTaskStoreFullyInitialized,
  runBdTextForHubTaskStore,
} from "./hubTaskStore.js";
import {
  resolveHubTaskStore,
  resolveManagedHubTaskStoreDir,
} from "./hubTaskStoreResolver.js";
import { registerHubProject, relinkHubProject } from "./hubProjectRegistry.js";
import { createHubTask, loadHubTaskBoard } from "./taskBoard.js";
import { resolveBundledBdExecutable } from "./resolveBdExecutable.js";
import {
  formatHubProjectStatusLines,
  resolveArchloopUserDataDir,
  resolveHubProjectStatus,
} from "./projectStatus.js";
import { collectHubProjectReadinessCheck } from "./hubProjectReadinessCheck.js";

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

const gitStatus = async (cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd,
  });
  return stdout;
};

describe("managed Hub Beads task store", () => {
  it("initializes a Hub-owned store with a Git-ignored redirect and keeps the repo clean", async () => {
    const bundledBd = resolveBundledBdExecutable();
    expect(bundledBd).toBeDefined();

    const root = await mkdtemp(join(tmpdir(), "hub-managed-store-"));
    const repoDir = join(root, "repo");
    await mkdir(repoDir);
    await initRepo(repoDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_DATA_HOME: join(root, "xdg-data"),
      ARCHLOOP_BD_PATH: bundledBd!,
      BEADS_ACTOR: "archloop-test",
    };
    delete env.BEADS_DIR;

    const registered = registerHubProject({
      repoPath: repoDir,
      projectName: "alpha",
      env,
      initializeTaskStore: true,
    });

    const managedBeadsDir = resolveManagedHubTaskStoreDir(
      registered.project.hubProjectDir,
    );
    const resolution = resolveHubTaskStore({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
    });

    expect(registered.taskStoreInitialized).toBe(true);
    expect(
      isHubTaskStoreFullyInitialized(registered.project.repoRoot, {
        hubProjectDir: registered.project.hubProjectDir,
      }),
    ).toBe(true);
    expect(resolution.kind).toBe("redirect");
    expect(resolution.beadsDir).toBe(managedBeadsDir);
    expect(existsSync(join(managedBeadsDir, "embeddeddolt"))).toBe(true);
    expect(existsSync(join(repoDir, ".beads", "metadata.json"))).toBe(false);
    expect(existsSync(join(repoDir, ".beads", "issues.jsonl"))).toBe(false);
    expect(
      (await readFile(join(repoDir, ".beads", "redirect"), "utf8")).trim(),
    ).toBe(managedBeadsDir);
    expect(await gitStatus(repoDir)).toBe("");

    const created = createHubTask(
      registered.project.repoRoot,
      { title: "Ship managed store" },
      env,
    );
    const board = loadHubTaskBoard(registered.project.repoRoot, env);
    expect(board.tasks.map((task) => task.id)).toContain(created.id);
    expect(existsSync(join(repoDir, ".beads", "issues.jsonl"))).toBe(false);
    expect(existsSync(join(managedBeadsDir, "issues.jsonl"))).toBe(true);
    expect(await gitStatus(repoDir)).toBe("");

    const { stdout: whereJson } = await execFileAsync(
      bundledBd!,
      ["where", "--json"],
      { cwd: repoDir, env },
    );
    const where = JSON.parse(whereJson) as {
      path?: string;
      redirected_from?: string;
    };
    expect(where.path).toBe(managedBeadsDir);

    const ready = runBdTextForHubTaskStore(
      registered.project.repoRoot,
      ["ready", "--json"],
      "tasks list",
      env,
    );
    expect(ready).toContain(created.id);

    const shown = runBdTextForHubTaskStore(
      registered.project.repoRoot,
      ["show", created.id, "--json"],
      "tasks show",
      env,
    );
    expect(shown).toContain("Ship managed store");

    const { stdout: hostReady } = await execFileAsync(
      bundledBd!,
      ["ready", "--json"],
      { cwd: repoDir, env },
    );
    expect(hostReady).toContain(created.id);

    const { stdout: hostShow } = await execFileAsync(
      bundledBd!,
      ["show", created.id, "--json"],
      { cwd: repoDir, env },
    );
    expect(hostShow).toContain("Ship managed store");

    const status = resolveHubProjectStatus({
      cwd: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      archloopUserDataDir: resolveArchloopUserDataDir(env),
      detectBeadsAvailable: () => true,
      ensureHubProjectDir: () => true,
    });
    expect(status.taskStoreKind).toBe("redirect");
    expect(status.taskStoreDir).toBe(managedBeadsDir);
    expect(status.taskStoreInitialized).toBe(true);
    expect(status.taskStoreMigrationPhase).not.toBe("redirect_installed");
  }, 60_000);

  it("relinks a registered project onto the same managed store", async () => {
    const bundledBd = resolveBundledBdExecutable();
    expect(bundledBd).toBeDefined();

    const root = await mkdtemp(join(tmpdir(), "hub-managed-relink-"));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await mkdir(repoA);
    await mkdir(repoB);
    await initRepo(repoA);
    await initRepo(repoB);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_DATA_HOME: join(root, "xdg-data"),
      ARCHLOOP_BD_PATH: bundledBd!,
      BEADS_ACTOR: "archloop-test",
    };
    delete env.BEADS_DIR;

    const registered = registerHubProject({
      repoPath: repoA,
      projectName: "alpha",
      env,
      initializeTaskStore: true,
    });
    const created = createHubTask(
      registered.project.repoRoot,
      { title: "Keep the same store" },
      env,
    );
    const managedBeadsDir = resolveManagedHubTaskStoreDir(
      registered.project.hubProjectDir,
    );

    const relinked = relinkHubProject({
      projectSelector: "alpha",
      repoPath: repoB,
      env,
    });

    expect(relinked.project.id).toBe(registered.project.id);
    expect(relinked.project.hubProjectDir).toBe(
      registered.project.hubProjectDir,
    );
    expect(existsSync(join(repoB, ".beads", "redirect"))).toBe(true);
    expect(
      (await readFile(join(repoB, ".beads", "redirect"), "utf8")).trim(),
    ).toBe(managedBeadsDir);
    expect(existsSync(join(repoB, ".beads", "embeddeddolt"))).toBe(false);

    const board = loadHubTaskBoard(relinked.project.repoRoot, env);
    expect(board.tasks.map((task) => task.id)).toContain(created.id);
    expect(await gitStatus(repoB)).toBe("");
  }, 60_000);

  it("is a no-op when the managed store already exists", async () => {
    const bundledBd = resolveBundledBdExecutable();
    expect(bundledBd).toBeDefined();

    const root = await mkdtemp(join(tmpdir(), "hub-managed-idempotent-"));
    const repoDir = join(root, "repo");
    await mkdir(repoDir);
    await initRepo(repoDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_DATA_HOME: join(root, "xdg-data"),
      ARCHLOOP_BD_PATH: bundledBd!,
    };
    delete env.BEADS_DIR;
    const registered = registerHubProject({
      repoPath: repoDir,
      projectName: "alpha",
      env,
    });

    const first = initHubTaskStore(registered.project.repoRoot, env, {
      hubProjectDir: registered.project.hubProjectDir,
      projectName: registered.project.name,
    });
    const second = initHubTaskStore(registered.project.repoRoot, env, {
      hubProjectDir: registered.project.hubProjectDir,
      projectName: registered.project.name,
    });

    expect(first.alreadyInitialized).toBe(false);
    expect(second.alreadyInitialized).toBe(true);
  }, 60_000);

  it("surfaces an invalid redirect in project status and readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-managed-invalid-"));
    const repoDir = join(root, "repo");
    await mkdir(repoDir);
    await initRepo(repoDir);
    const env = {
      ...process.env,
      XDG_DATA_HOME: join(root, "xdg-data"),
    };
    const registered = registerHubProject({
      repoPath: repoDir,
      projectName: "alpha",
      env,
    });
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(
      join(repoDir, ".beads", "redirect"),
      `${join(root, "missing", ".beads")}\n`,
    );

    const status = resolveHubProjectStatus({
      cwd: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      archloopUserDataDir: resolveArchloopUserDataDir(env),
      detectBeadsAvailable: () => true,
      ensureHubProjectDir: () => true,
    });

    expect(status.taskStoreInitialized).toBe(false);
    expect(status.taskStoreKind).toBe("redirect");
    expect(status.taskStoreRedirectError).toMatch(/invalid or inaccessible/i);
    expect(formatHubProjectStatusLines(status).join("\n")).toMatch(
      /invalid or inaccessible/i,
    );

    const report = await collectHubProjectReadinessCheck(registered.project, {
      env,
      resolveProjectStatus: () => status,
    });
    expect(report.hasErrors).toBe(true);
    expect(
      report.sections
        .flatMap((section) => section.findings)
        .map((finding) => finding.message)
        .join("\n"),
    ).toMatch(/invalid or inaccessible/i);
  });
});
