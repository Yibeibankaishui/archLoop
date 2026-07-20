import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  HUB_TASK_STORE_INIT_COMMAND,
  formatHubTaskStoreCommandFailure,
  formatHubTaskStoreNotInitializedMessage,
  initHubTaskStore,
  isHubTaskStoreFullyInitialized,
  isHubTaskStoreInitialized,
  runBdTextForHubTaskStore,
} from "./hubTaskStore.js";
import { TaskBoardError } from "./errors.js";
import { resolveBundledBdExecutable } from "./resolveBdExecutable.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, "hello.txt"), "hello");
  await execAsync("git add hello.txt && git commit -m init", { cwd: dir });
};

describe("isHubTaskStoreInitialized", () => {
  it("returns false before archloop tasks init", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-"));
    await initRepo(repoDir);
    expect(isHubTaskStoreInitialized(repoDir)).toBe(false);
  });

  it("returns true after metadata.json exists", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-"));
    await initRepo(repoDir);
    const beadsDir = join(repoDir, ".beads");
    await mkdir(beadsDir, { recursive: true });
    await writeFile(
      join(beadsDir, "metadata.json"),
      JSON.stringify({ backend: "dolt" }),
    );
    expect(isHubTaskStoreInitialized(repoDir)).toBe(true);
  });
});

describe("isHubTaskStoreFullyInitialized", () => {
  it("returns false when only metadata.json exists without the embedded database", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-"));
    await initRepo(repoDir);
    const beadsDir = join(repoDir, ".beads");
    await mkdir(beadsDir, { recursive: true });
    await writeFile(
      join(beadsDir, "metadata.json"),
      JSON.stringify({ backend: "dolt" }),
    );
    // Marker present, but no embeddeddolt directory → orphaned marker.
    expect(isHubTaskStoreInitialized(repoDir)).toBe(true);
    expect(isHubTaskStoreFullyInitialized(repoDir)).toBe(false);
  });

  it("returns true when both metadata.json and embeddeddolt exist", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-"));
    await initRepo(repoDir);
    const beadsDir = join(repoDir, ".beads");
    await mkdir(join(beadsDir, "embeddeddolt"), { recursive: true });
    await writeFile(
      join(beadsDir, "metadata.json"),
      JSON.stringify({ backend: "dolt" }),
    );
    expect(isHubTaskStoreFullyInitialized(repoDir)).toBe(true);
  });
});

describe("formatHubTaskStoreNotInitializedMessage", () => {
  it("points users to archloop tasks init instead of bd init", () => {
    expect(formatHubTaskStoreNotInitializedMessage("tasks list")).toBe(
      `archloop tasks list requires a local task store. Run \`${HUB_TASK_STORE_INIT_COMMAND}\` in this repository first.`,
    );
    expect(formatHubTaskStoreNotInitializedMessage("tasks list")).not.toContain(
      "bd init",
    );
  });
});

describe("runBdTextForHubTaskStore", () => {
  it("fails with a archLoop-owned init message when the task store is missing", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-"));
    await initRepo(repoDir);

    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
process.stderr.write("Error: no beads database found\\nHint: run 'bd init'\\n");
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    expect(() =>
      runBdTextForHubTaskStore(repoDir, ["list", "--json"], "tasks list", {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: bdPath,
      }),
    ).toThrow(
      new TaskBoardError({
        message: formatHubTaskStoreNotInitializedMessage("tasks list"),
      }),
    );
  });
});

describe("initHubTaskStore", () => {
  it("initializes a fresh git repo with the bundled Beads runtime", async () => {
    const bundledBd = resolveBundledBdExecutable();
    if (!bundledBd) {
      expect(bundledBd).toBeDefined();
      return;
    }

    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-init-"));
    await initRepo(repoDir);

    const result = initHubTaskStore(repoDir, {
      ...process.env,
      ARCHLOOP_BD_PATH: bundledBd,
    });

    expect(result.alreadyInitialized).toBe(false);
    expect(isHubTaskStoreInitialized(repoDir)).toBe(true);
  }, 60_000);

  it("is idempotent when the task store already exists", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-init-"));
    await initRepo(repoDir);

    const bundledBd = resolveBundledBdExecutable();
    if (!bundledBd) {
      expect(bundledBd).toBeDefined();
      return;
    }

    // First init builds the real store (metadata.json + embeddeddolt).
    const first = initHubTaskStore(repoDir, {
      ...process.env,
      ARCHLOOP_BD_PATH: bundledBd,
    });
    expect(first.alreadyInitialized).toBe(false);
    expect(isHubTaskStoreFullyInitialized(repoDir)).toBe(true);

    // A second init must no-op, not re-run bd init.
    const second = initHubTaskStore(repoDir, {
      ...process.env,
      ARCHLOOP_BD_PATH: bundledBd,
    });
    expect(second.alreadyInitialized).toBe(true);
    expect(second.output).toBe("");
  });

  it("re-runs bd init when an orphaned metadata.json has no embedded database", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-init-"));
    await initRepo(repoDir);

    const bundledBd = resolveBundledBdExecutable();
    if (!bundledBd) {
      expect(bundledBd).toBeDefined();
      return;
    }

    // Simulate a stale marker left behind by a deleted database: metadata.json
    // present, but no embeddeddolt directory. The marker-only check used to
    // treat this as "already initialized" and skip bd init, leaving every
    // task command to fail with "no beads database found".
    const beadsDir = join(repoDir, ".beads");
    await mkdir(beadsDir, { recursive: true });
    await writeFile(
      join(beadsDir, "metadata.json"),
      JSON.stringify({ backend: "dolt" }),
    );

    const result = initHubTaskStore(repoDir, {
      ...process.env,
      ARCHLOOP_BD_PATH: bundledBd,
    });

    expect(result.alreadyInitialized).toBe(false);
    expect(isHubTaskStoreFullyInitialized(repoDir)).toBe(true);
  }, 60_000);
});

describe("formatHubTaskStoreCommandFailure", () => {
  it("maps raw bd init hints to archloop tasks init", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-store-"));
    await initRepo(repoDir);

    expect(
      formatHubTaskStoreCommandFailure(
        "tasks create",
        new Error("Error: no beads database found\nHint: run 'bd init'"),
        repoDir,
      ),
    ).toBe(formatHubTaskStoreNotInitializedMessage("tasks create"));
  });
});
