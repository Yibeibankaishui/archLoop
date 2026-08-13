import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { TaskBoardError } from "./errors.js";
import { registerHubProject } from "./hubProjectRegistry.js";
import {
  formatHubTaskStoreMigrationMessage,
  HUB_TASK_STORE_MIGRATION_PHASES,
  HUB_TASK_STORE_MIGRATION_SIDE_EFFECTS,
  HubTaskStoreMigrationCrash,
  ensureHubTaskStoreMigrated,
  inspectHubTaskStoreMigration,
  type HubTaskStoreMigrationSideEffect,
} from "./hubTaskStoreMigration.js";
import { createHubTask, loadHubTaskBoard } from "./taskBoard.js";
import { initHubTaskStore, runBdTextForHubTaskStore } from "./hubTaskStore.js";
import {
  resolveHubTaskStore,
  resolveManagedHubTaskStoreDir,
} from "./hubTaskStoreResolver.js";
import { resolveBundledBdExecutable } from "./resolveBdExecutable.js";
import {
  formatHubProjectStatusLines,
  resolveArchloopUserDataDir,
  resolveHubProjectStatus,
} from "./projectStatus.js";

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

const createLegacyStoreFixture = async () => {
  const bundledBd = resolveBundledBdExecutable();
  expect(bundledBd).toBeDefined();

  const root = await mkdtemp(join(tmpdir(), "hub-legacy-migrate-"));
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

  initHubTaskStore(repoDir, env);
  const beadsConfigFiles = [
    ".beads/metadata.json",
    ".beads/config.yaml",
    ".beads/README.md",
    ".beads/.gitignore",
  ];
  for (const file of beadsConfigFiles) {
    if (existsSync(join(repoDir, file))) {
      await execFileAsync("git", ["add", file], { cwd: repoDir });
    }
  }
  try {
    await execFileAsync(
      "git",
      ["commit", "--no-verify", "-m", "legacy beads config"],
      { cwd: repoDir },
    );
  } catch {
    // Empty commit is fine when bd init did not write tracked config files.
  }
  const created = createHubTask(
    repoDir,
    {
      title: "Keep this task through migration",
      description: "Legacy store fixture",
    },
    env,
  );
  await execFileAsync(
    bundledBd!,
    ["comment", created.id, "Preserve this note"],
    { cwd: repoDir, env },
  );

  const registered = registerHubProject({
    repoPath: repoDir,
    projectName: "legacy-alpha",
    env,
    initializeTaskStore: false,
  });

  return {
    bundledBd: bundledBd!,
    repoDir,
    env,
    created,
    registered,
    managedBeadsDir: resolveManagedHubTaskStoreDir(
      registered.project.hubProjectDir,
    ),
  };
};

describe("legacy Hub Beads store migration", () => {
  it("migrates a writer-free legacy store on first mutating use and keeps host bd working", async () => {
    const fixture = await createLegacyStoreFixture();
    const { repoDir, env, created, registered, managedBeadsDir, bundledBd } =
      fixture;

    const outcome = ensureHubTaskStoreMigrated({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    });

    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") {
      return;
    }
    expect(outcome.phase).toBe("verified");
    expect(outcome.beadsDir).toBe(managedBeadsDir);
    expect(existsSync(outcome.backupDir)).toBe(true);
    expect(existsSync(join(outcome.backupDir, "embeddeddolt"))).toBe(true);
    expect(formatHubTaskStoreMigrationMessage(outcome)).toMatch(
      /migrated|Hub-owned/i,
    );

    const inspection = inspectHubTaskStoreMigration({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    });
    expect(inspection.phase).toBe("verified");
    expect(inspection.phases).toEqual([...HUB_TASK_STORE_MIGRATION_PHASES]);
    expect(inspection.backupPresent).toBe(true);
    expect(inspection.integrityError).toBeUndefined();

    const resolution = resolveHubTaskStore({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
    });
    expect(resolution.kind).toBe("redirect");
    expect(resolution.beadsDir).toBe(managedBeadsDir);
    expect(
      (await readFile(join(repoDir, ".beads", "redirect"), "utf8")).trim(),
    ).toBe(managedBeadsDir);
    expect(existsSync(join(repoDir, ".beads", "embeddeddolt"))).toBe(false);
    expect(existsSync(join(managedBeadsDir, "embeddeddolt"))).toBe(true);

    const board = loadHubTaskBoard(registered.project.repoRoot, env);
    expect(board.tasks.map((task) => task.id)).toContain(created.id);
    const migratedTask = board.tasks.find((task) => task.id === created.id);
    expect(migratedTask?.title).toBe("Keep this task through migration");

    const shown = runBdTextForHubTaskStore(
      registered.project.repoRoot,
      ["show", created.id, "--json"],
      "tasks show",
      env,
    );
    expect(shown).toContain("Keep this task through migration");
    expect(shown).toMatch(/Preserve this note/i);

    const { stdout: whereJson } = await execFileAsync(
      bundledBd,
      ["where", "--json"],
      { cwd: repoDir, env },
    );
    const where = JSON.parse(whereJson) as {
      path?: string;
      redirected_from?: string;
    };
    expect(where.path).toBe(managedBeadsDir);

    const { stdout: hostShow } = await execFileAsync(
      bundledBd,
      ["show", created.id, "--json"],
      { cwd: repoDir, env },
    );
    expect(hostShow).toContain("Keep this task through migration");

    const continued = createHubTask(
      registered.project.repoRoot,
      { title: "Created after migration" },
      env,
    );
    const afterBoard = loadHubTaskBoard(registered.project.repoRoot, env);
    expect(afterBoard.tasks.map((task) => task.id)).toContain(created.id);
    expect(afterBoard.tasks.map((task) => task.id)).toContain(continued.id);
    expect(existsSync(join(repoDir, ".beads", "issues.jsonl"))).toBe(false);

    const status = resolveHubProjectStatus({
      cwd: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      archloopUserDataDir: resolveArchloopUserDataDir(env),
      detectBeadsAvailable: () => true,
      ensureHubProjectDir: () => true,
    });
    expect(status.taskStoreKind).toBe("redirect");
    expect(status.taskStoreDir).toBe(managedBeadsDir);
    expect(status.taskStoreMigrationPhase).toBe("verified");
    expect(formatHubProjectStatusLines(status).join("\n")).toMatch(
      /migrated|Hub-owned|verified/i,
    );
    expect(formatHubProjectStatusLines(status).join("\n")).not.toMatch(
      /tasks recover/i,
    );

    const statusAfter = await gitStatus(repoDir);
    expect(statusAfter).not.toMatch(/embeddeddolt/);
    expect(statusAfter).not.toMatch(/metadata\.json/);
    expect(statusAfter).not.toMatch(/config\.yaml/);
    expect(existsSync(join(repoDir, ".beads", "metadata.json"))).toBe(true);
    expect(existsSync(join(repoDir, ".beads", "config.yaml"))).toBe(true);

    const second = ensureHubTaskStoreMigrated({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    });
    expect(second.kind).toBe("not_needed");
  }, 90_000);

  it.each(
    HUB_TASK_STORE_MIGRATION_SIDE_EFFECTS.flatMap(
      (
        sideEffect,
      ): {
        sideEffect: HubTaskStoreMigrationSideEffect;
        timing: "before" | "after";
      }[] => [
        { sideEffect, timing: "before" },
        { sideEffect, timing: "after" },
      ],
    ),
  )(
    "resumes after a crash $timing $sideEffect without task loss or tasks recover",
    async ({ sideEffect, timing }) => {
      const fixture = await createLegacyStoreFixture();
      const { env, created, registered, managedBeadsDir } = fixture;
      const input = {
        repoRoot: registered.project.repoRoot,
        hubProjectDir: registered.project.hubProjectDir,
        env,
      };

      expect(() =>
        ensureHubTaskStoreMigrated({
          ...input,
          faultInjection:
            timing === "before"
              ? { crashBefore: sideEffect }
              : { crashAfter: sideEffect },
        }),
      ).toThrow(HubTaskStoreMigrationCrash);

      const resumed = ensureHubTaskStoreMigrated(input);
      expect(resumed.kind).toBe("migrated");
      if (resumed.kind !== "migrated") {
        return;
      }
      expect(resumed.phase).toBe("verified");
      expect(resumed.beadsDir).toBe(managedBeadsDir);

      const inspection = inspectHubTaskStoreMigration(input);
      expect(inspection.phase).toBe("verified");
      expect(inspection.integrityError).toBeUndefined();

      const board = loadHubTaskBoard(registered.project.repoRoot, env);
      expect(board.tasks.map((task) => task.id)).toContain(created.id);
      expect(
        resolveHubTaskStore({
          repoRoot: registered.project.repoRoot,
          hubProjectDir: registered.project.hubProjectDir,
        }).kind,
      ).toBe("redirect");
      expect(() =>
        createHubTask(
          registered.project.repoRoot,
          { title: `Continue after ${timing} ${sideEffect}` },
          env,
        ),
      ).not.toThrow(TaskBoardError);
    },
    90_000,
  );
});
