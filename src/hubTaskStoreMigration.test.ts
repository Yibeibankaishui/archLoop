import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  HUB_TASK_STORE_SPLIT_BRAIN_INCIDENT,
  HubTaskStoreMigrationCrash,
  ensureHubTaskStoreMigrated,
  inspectHubTaskStoreMigration,
  type HubTaskStoreMigrationSideEffect,
} from "./hubTaskStoreMigration.js";
import { formatHubFlowResultLines } from "./hubFlowExecution.js";
import {
  createHubRunDisplayState,
  formatPlainHubRunEvent,
} from "./hubRunDisplay.js";
import {
  doctorHubTaskState,
  formatHubTaskStateDoctorLines,
} from "./hubTaskStateDoctor.js";
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

describe("unsafe Hub Beads migration deferral and split brain", () => {
  it("defers migration when an active Beads writer is present and keeps the legacy store", async () => {
    const fixture = await createLegacyStoreFixture();
    const { repoDir, env, created, registered } = fixture;

    await writeFile(
      join(repoDir, ".beads", "dolt-server.pid"),
      `${process.pid}\n`,
    );

    const outcome = ensureHubTaskStoreMigrated({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    });

    expect(outcome.kind).toBe("deferred");
    if (outcome.kind !== "deferred") {
      return;
    }
    expect(outcome.reason).toBe("active_writer");
    expect(outcome.beadsDir).toBe(join(repoDir, ".beads"));
    expect(outcome.pendingUntil).toMatch(/^\d{4}-/);
    expect(formatHubTaskStoreMigrationMessage(outcome)).toMatch(
      /migration is pending|active Beads writer/i,
    );
    expect(formatHubTaskStoreMigrationMessage(outcome)).not.toMatch(
      /tasks recover/i,
    );

    const resolution = resolveHubTaskStore({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
    });
    expect(resolution.kind).toBe("legacy");
    expect(existsSync(join(repoDir, ".beads", "embeddeddolt"))).toBe(true);
    expect(existsSync(join(repoDir, ".beads", "redirect"))).toBe(false);

    const inspection = inspectHubTaskStoreMigration({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    });
    expect(inspection.pendingReason).toBe("active_writer");
    expect(inspection.phase).toBe("legacy_active");
    expect(inspection.integrityIncident).toBeUndefined();

    const continued = createHubTask(
      registered.project.repoRoot,
      { title: "Created while migration is pending" },
      env,
    );
    const board = loadHubTaskBoard(registered.project.repoRoot, env);
    expect(board.tasks.map((task) => task.id)).toContain(created.id);
    expect(board.tasks.map((task) => task.id)).toContain(continued.id);
  }, 90_000);

  it("defers migration when another live migration owner holds the lease", async () => {
    const fixture = await createLegacyStoreFixture();
    const { repoDir, env, created, registered } = fixture;
    const ownerPid = process.ppid;
    expect(ownerPid).toBeGreaterThan(0);

    await mkdir(join(registered.project.hubProjectDir, "task-store-migration"), {
      recursive: true,
    });
    await writeFile(
      join(
        registered.project.hubProjectDir,
        "task-store-migration",
        "lease.json",
      ),
      `${JSON.stringify({ pid: ownerPid, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
    );

    const outcome = ensureHubTaskStoreMigrated({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    });

    expect(outcome.kind).toBe("deferred");
    if (outcome.kind !== "deferred") {
      return;
    }
    expect(outcome.reason).toBe("migration_contention");
    expect(resolveHubTaskStore({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
    }).kind).toBe("legacy");
    expect(existsSync(join(repoDir, ".beads", "embeddeddolt"))).toBe(true);
    expect(
      loadHubTaskBoard(registered.project.repoRoot, env).tasks.map(
        (task) => task.id,
      ),
    ).toContain(created.id);
    expect(formatHubTaskStoreMigrationMessage(outcome)).not.toMatch(
      /tasks recover/i,
    );
  }, 90_000);

  it("defers migration when the source fingerprint changes before quarantine", async () => {
    const fixture = await createLegacyStoreFixture();
    const { env, created, registered } = fixture;
    const input = {
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    };

    expect(() =>
      ensureHubTaskStoreMigrated({
        ...input,
        faultInjection: { crashAfter: "prepare_snapshot" },
      }),
    ).toThrow(HubTaskStoreMigrationCrash);

    const mutated = createHubTask(
      registered.project.repoRoot,
      { title: "Source generation changed before quarantine" },
      env,
    );

    const outcome = ensureHubTaskStoreMigrated(input);
    expect(outcome.kind).toBe("deferred");
    if (outcome.kind !== "deferred") {
      return;
    }
    expect(outcome.reason).toBe("source_fingerprint_changed");
    expect(
      resolveHubTaskStore({
        repoRoot: registered.project.repoRoot,
        hubProjectDir: registered.project.hubProjectDir,
      }).kind,
    ).toBe("legacy");
    const board = loadHubTaskBoard(registered.project.repoRoot, env);
    expect(board.tasks.map((task) => task.id)).toContain(created.id);
    expect(board.tasks.map((task) => task.id)).toContain(mutated.id);
  }, 90_000);

  it("defers migration when the prepared snapshot cannot be recaptured safely", async () => {
    const fixture = await createLegacyStoreFixture();
    const { repoDir, env, created, registered } = fixture;
    const input = {
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    };

    expect(() =>
      ensureHubTaskStoreMigrated({
        ...input,
        faultInjection: { crashAfter: "prepare_snapshot" },
      }),
    ).toThrow(HubTaskStoreMigrationCrash);

    const doltDir = join(repoDir, ".beads", "embeddeddolt");
    await chmod(doltDir, 0o000);
    try {
      const outcome = ensureHubTaskStoreMigrated(input);
      expect(outcome.kind).toBe("deferred");
      if (outcome.kind !== "deferred") {
        return;
      }
      expect(outcome.reason).toBe("unsafe_snapshot");
      expect(existsSync(join(repoDir, ".beads", "redirect"))).toBe(false);
      expect(inspectHubTaskStoreMigration(input).pendingReason).toBe(
        "unsafe_snapshot",
      );
      expect(created.id.length).toBeGreaterThan(0);
    } finally {
      await chmod(doltDir, 0o700);
    }
  }, 90_000);

  it("retries deferred migration after backoff once the writer is gone", async () => {
    const fixture = await createLegacyStoreFixture();
    const { repoDir, env, created, registered } = fixture;
    const input = {
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    };

    await writeFile(
      join(repoDir, ".beads", "dolt-server.pid"),
      `${process.pid}\n`,
    );
    const deferred = ensureHubTaskStoreMigrated(input);
    expect(deferred.kind).toBe("deferred");
    if (deferred.kind !== "deferred") {
      return;
    }

    await rm(join(repoDir, ".beads", "dolt-server.pid"), { force: true });

    const stillPending = ensureHubTaskStoreMigrated({
      ...input,
      now: () => new Date(Date.parse(deferred.pendingUntil) - 1_000),
    });
    expect(stillPending.kind).toBe("deferred");

    const resumed = ensureHubTaskStoreMigrated({
      ...input,
      now: () => new Date(Date.parse(deferred.pendingUntil) + 1_000),
    });
    expect(resumed.kind).toBe("migrated");
    if (resumed.kind !== "migrated") {
      return;
    }
    expect(
      resolveHubTaskStore({
        repoRoot: registered.project.repoRoot,
        hubProjectDir: registered.project.hubProjectDir,
      }).kind,
    ).toBe("redirect");
    expect(
      loadHubTaskBoard(registered.project.repoRoot, env).tasks.map(
        (task) => task.id,
      ),
    ).toContain(created.id);
  }, 90_000);

  it("copies only the quarantined cold database and keeps the backup", async () => {
    const fixture = await createLegacyStoreFixture();
    const { repoDir, env, created, registered, managedBeadsDir } = fixture;
    const input = {
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    };

    expect(() =>
      ensureHubTaskStoreMigrated({
        ...input,
        faultInjection: { crashAfter: "quarantine_legacy" },
      }),
    ).toThrow(HubTaskStoreMigrationCrash);

    await mkdir(join(repoDir, ".beads", "embeddeddolt"), { recursive: true });
    await writeFile(
      join(repoDir, ".beads", "embeddeddolt", "HOT-WRITE"),
      "do-not-copy-from-live-store\n",
    );

    const resumed = ensureHubTaskStoreMigrated(input);
    expect(resumed.kind).toBe("migrated");
    if (resumed.kind !== "migrated") {
      return;
    }
    expect(existsSync(join(managedBeadsDir, "embeddeddolt", "HOT-WRITE"))).toBe(
      false,
    );
    expect(existsSync(join(resumed.backupDir, "embeddeddolt"))).toBe(true);
    expect(
      loadHubTaskBoard(registered.project.repoRoot, env).tasks.map(
        (task) => task.id,
      ),
    ).toContain(created.id);
  }, 90_000);

  it("does not treat a partial managed destination as authoritative after a copy crash", async () => {
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
        faultInjection: { crashAfter: "copy_managed" },
      }),
    ).toThrow(HubTaskStoreMigrationCrash);

    await writeFile(
      join(managedBeadsDir, "metadata.json"),
      `${JSON.stringify({ project_id: "partial-dest", database: "dolt" })}\n`,
    );

    const resumed = ensureHubTaskStoreMigrated(input);
    expect(resumed.kind).toBe("migrated");
    if (resumed.kind !== "migrated") {
      return;
    }
    const metadata = JSON.parse(
      await readFile(join(managedBeadsDir, "metadata.json"), "utf8"),
    ) as { project_id?: string };
    expect(metadata.project_id).not.toBe("partial-dest");
    expect(
      loadHubTaskBoard(registered.project.repoRoot, env).tasks.map(
        (task) => task.id,
      ),
    ).toContain(created.id);
  }, 90_000);

  it("stops automatic writes when legacy and managed stores diverge after redirect", async () => {
    const fixture = await createLegacyStoreFixture();
    const { repoDir, env, created, registered, managedBeadsDir, bundledBd } =
      fixture;
    const input = {
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    };

    const migrated = ensureHubTaskStoreMigrated(input);
    expect(migrated.kind).toBe("migrated");

    const forkDir = await mkdtemp(join(tmpdir(), "hub-split-brain-fork-"));
    const forkBeadsDir = join(forkDir, ".beads");
    await cp(managedBeadsDir, forkBeadsDir, { recursive: true });
    await execFileAsync(
      bundledBd,
      ["create", "Independent legacy history", "-t", "task"],
      { cwd: forkDir, env: { ...env, BEADS_DIR: forkBeadsDir } },
    );
    await cp(
      join(forkBeadsDir, "embeddeddolt"),
      join(repoDir, ".beads", "embeddeddolt"),
      { recursive: true },
    );

    const outcome = ensureHubTaskStoreMigrated(input);
    expect(outcome.kind).toBe("split_brain");
    if (outcome.kind !== "split_brain") {
      return;
    }
    expect(formatHubTaskStoreMigrationMessage(outcome)).toMatch(/split brain/i);
    expect(formatHubTaskStoreMigrationMessage(outcome)).not.toMatch(
      /tasks recover/i,
    );

    const inspection = inspectHubTaskStoreMigration(input);
    expect(inspection.integrityIncident).toBe(
      HUB_TASK_STORE_SPLIT_BRAIN_INCIDENT,
    );
    expect(existsSync(join(repoDir, ".beads", "embeddeddolt"))).toBe(true);
    expect(existsSync(join(managedBeadsDir, "embeddeddolt"))).toBe(true);

    expect(() =>
      createHubTask(
        registered.project.repoRoot,
        { title: "Must not write during split brain" },
        env,
      ),
    ).toThrow(TaskBoardError);

    const shown = runBdTextForHubTaskStore(
      registered.project.repoRoot,
      ["show", created.id, "--json"],
      "tasks show",
      env,
    );
    expect(shown).toContain("Keep this task through migration");

    const status = resolveHubProjectStatus({
      cwd: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      archloopUserDataDir: resolveArchloopUserDataDir(env),
      detectBeadsAvailable: () => true,
      ensureHubProjectDir: () => true,
    });
    expect(status.taskStoreIntegrityIncident).toBe(
      HUB_TASK_STORE_SPLIT_BRAIN_INCIDENT,
    );
    expect(formatHubProjectStatusLines(status).join("\n")).toMatch(
      /split brain/i,
    );
    expect(formatHubProjectStatusLines(status).join("\n")).not.toMatch(
      /tasks recover/i,
    );

    const doctor = await doctorHubTaskState({
      cwd: registered.project.repoRoot,
      env,
    });
    expect(formatHubTaskStateDoctorLines(doctor).join("\n")).toMatch(
      /split brain/i,
    );
    expect(existsSync(join(repoDir, ".beads", "embeddeddolt"))).toBe(true);
    expect(existsSync(join(managedBeadsDir, "embeddeddolt"))).toBe(true);

    const flowLines = formatHubFlowResultLines({
      flowId: "no-review",
      runId: "run-1",
      batchId: "batch-1",
      runDir: "/tmp/run",
      mode: "no_ready",
      completedBatchCount: 0,
      completedTaskCount: 0,
      stopReason: "no_ready_tasks",
      batchResults: [],
      selectedTaskIds: [],
      results: [],
      unfinishedBatchIds: [],
      projectDevelopmentContractPath: "/tmp/contract.json",
      projectDevelopmentContractCreatedGenericFallback: false,
      taskStoreMigration: outcome,
    }).join("\n");
    expect(flowLines).toMatch(/split brain/i);
    expect(flowLines).not.toMatch(/tasks recover/i);

    const plain = formatPlainHubRunEvent(
      {
        type: "task_store_migration",
        eventId: "run-1:2",
        sequence: 2,
        runId: "run-1",
        createdAt: "2026-08-13T12:00:00.000Z",
        kind: "split_brain",
        reason: "task_store_split_brain",
        beadsDir: managedBeadsDir,
        message: formatHubTaskStoreMigrationMessage(outcome),
      },
      createHubRunDisplayState({
        hubProjectName: "legacy-alpha",
        flowId: "no-review",
      }),
    );
    expect(plain).toContain("kind=\"split_brain\"");
    expect(plain).toContain("reason=\"task_store_split_brain\"");
  }, 90_000);

  it("lets status and doctor observe pending migration without mutating the legacy store", async () => {
    const fixture = await createLegacyStoreFixture();
    const { repoDir, env, registered } = fixture;
    await writeFile(
      join(repoDir, ".beads", "dolt-server.pid"),
      `${process.pid}\n`,
    );
    const deferred = ensureHubTaskStoreMigrated({
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    });
    expect(deferred.kind).toBe("deferred");

    const status = resolveHubProjectStatus({
      cwd: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      archloopUserDataDir: resolveArchloopUserDataDir(env),
      detectBeadsAvailable: () => true,
      ensureHubProjectDir: () => true,
    });
    expect(status.taskStoreMigrationPendingReason).toBe("active_writer");
    expect(formatHubProjectStatusLines(status).join("\n")).toMatch(
      /migration is pending/i,
    );

    const doctor = await doctorHubTaskState({
      cwd: registered.project.repoRoot,
      env,
    });
    expect(formatHubTaskStateDoctorLines(doctor).join("\n")).toMatch(
      /migration is pending/i,
    );
    expect(existsSync(join(repoDir, ".beads", "embeddeddolt"))).toBe(true);
    expect(existsSync(join(repoDir, ".beads", "redirect"))).toBe(false);

    const flowLines = formatHubFlowResultLines({
      flowId: "no-review",
      runId: "run-1",
      batchId: "batch-1",
      runDir: "/tmp/run",
      mode: "no_ready",
      completedBatchCount: 0,
      completedTaskCount: 0,
      stopReason: "no_ready_tasks",
      batchResults: [],
      selectedTaskIds: [],
      results: [],
      unfinishedBatchIds: [],
      projectDevelopmentContractPath: "/tmp/contract.json",
      projectDevelopmentContractCreatedGenericFallback: false,
      taskStoreMigration: deferred,
    }).join("\n");
    expect(flowLines).toMatch(/migration is pending/i);
    expect(flowLines).not.toMatch(/split brain/i);
  }, 90_000);

  it("retains the quarantined backup when the managed destination is not writable", async () => {
    const fixture = await createLegacyStoreFixture();
    const { env, created, registered } = fixture;
    const input = {
      repoRoot: registered.project.repoRoot,
      hubProjectDir: registered.project.hubProjectDir,
      env,
    };

    expect(() =>
      ensureHubTaskStoreMigrated({
        ...input,
        faultInjection: { crashAfter: "quarantine_legacy" },
      }),
    ).toThrow(HubTaskStoreMigrationCrash);

    await chmod(registered.project.hubProjectDir, 0o500);
    try {
      expect(() => ensureHubTaskStoreMigrated(input)).toThrow();
      expect(
        existsSync(
          join(registered.project.repoRoot, ".beads", ".hub-quarantine", "embeddeddolt"),
        ),
      ).toBe(true);
      expect(
        existsSync(join(registered.project.repoRoot, ".beads", "redirect")),
      ).toBe(false);
    } finally {
      await chmod(registered.project.hubProjectDir, 0o700);
    }

    const resumed = ensureHubTaskStoreMigrated(input);
    expect(resumed.kind).toBe("migrated");
    expect(
      loadHubTaskBoard(registered.project.repoRoot, env).tasks.map(
        (task) => task.id,
      ),
    ).toContain(created.id);
  }, 90_000);
});
