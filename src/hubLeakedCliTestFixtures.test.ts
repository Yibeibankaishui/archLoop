import { exec } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createHubRunContext } from "./hubExecution.js";
import {
  applyLeakedCliTestFixtures,
  diagnoseLeakedCliTestFixtures,
} from "./hubLeakedCliTestFixtures.js";
import {
  listHubProjects,
  registerHubProject,
  resolveSelectedHubProject,
} from "./hubProjectRegistry.js";
import { resolveGitRepoRoot } from "./projectStatus.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const createCommittedRepo = async (prefix: string): Promise<string> => {
  const repoDir = await mkdtemp(join(tmpdir(), prefix));
  await initRepo(repoDir);
  await writeFile(join(repoDir, "package.json"), "{}\n");
  await execAsync("git add package.json && git commit -m 'initial'", {
    cwd: repoDir,
  });
  return repoDir;
};

describe("leaked CLI-test Hub fixtures", () => {
  it("diagnoses cli-host/cli-resolve tmp registry entries and path-hash run dirs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "leaked-cli-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const leakedHost = await createCommittedRepo("cli-host-");
    const leakedResolve = await createCommittedRepo("cli-resolve-");
    const durableRepo = await createCommittedRepo("durable-app-");

    registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    registerHubProject({
      repoPath: leakedResolve,
      projectName: `cli-resolve-${leakedResolve.slice(-6)}`,
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const durable = registerHubProject({
      repoPath: durableRepo,
      projectName: "durable-app",
      env,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });

    const leakedPathHashDir = join(
      dataDir,
      "archloop",
      "hub",
      "projects",
      "aaaaaaaaaaaa",
    );
    createHubRunContext({
      cwd: leakedHost,
      env,
      hubProjectDir: leakedPathHashDir,
      branch: "main",
    });

    const durablePathHashDir = join(
      dataDir,
      "archloop",
      "hub",
      "projects",
      "bbbbbbbbbbbb",
    );
    mkdirSync(join(durablePathHashDir, "runs", "run-keep", "events"), {
      recursive: true,
    });
    writeFileSync(
      join(durablePathHashDir, "runs", "run-keep", "events", "run.jsonl"),
      `${JSON.stringify({
        type: "run_started",
        repoRoot: "/home/user/code/real-app",
        hubProjectDir: durablePathHashDir,
      })}\n`,
    );

    const undocumentedPathHashDir = join(
      dataDir,
      "archloop",
      "hub",
      "projects",
      "cccccccccccc",
    );
    mkdirSync(join(undocumentedPathHashDir, "runs", "run-empty", "events"), {
      recursive: true,
    });
    writeFileSync(
      join(undocumentedPathHashDir, "runs", "run-empty", "events", "run.jsonl"),
      `${JSON.stringify({ type: "run_completed" })}\n`,
    );

    const report = diagnoseLeakedCliTestFixtures({ env });

    expect(report.registryEntries.map((entry) => entry.name).sort()).toEqual([
      expect.stringMatching(/^cli-host-/),
      expect.stringMatching(/^cli-resolve-/),
    ]);
    expect(
      report.registryEntries.some((entry) => entry.id === durable.project.id),
    ).toBe(false);
    expect(report.pathHashProjectDirs).toEqual([leakedPathHashDir]);
    expect(report.selectedProjectId).toBe(durable.project.id);
    expect(report.selectionAction).toBe("keep");
  });

  it("dry-run leaves state unchanged and apply is idempotent after backup", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "leaked-cli-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const leakedHost = await createCommittedRepo("cli-host-");
    const durableRepo = await createCommittedRepo("durable-app-");

    const leaked = registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const durable = registerHubProject({
      repoPath: durableRepo,
      projectName: "durable-app",
      env,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });

    const leakedPathHashDir = join(
      dataDir,
      "archloop",
      "hub",
      "projects",
      "aaaaaaaaaaaa",
    );
    createHubRunContext({
      cwd: leakedHost,
      env,
      hubProjectDir: leakedPathHashDir,
      branch: "main",
    });

    const dryRun = applyLeakedCliTestFixtures({
      env,
      apply: false,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.backupDir).toBeUndefined();
    expect(
      listHubProjects({ env })
        .map((project) => project.name)
        .sort(),
    ).toEqual([durable.project.name, leaked.project.name].sort());
    expect(existsSync(leaked.project.hubProjectDir)).toBe(true);
    expect(existsSync(leakedPathHashDir)).toBe(true);
    expect(resolveSelectedHubProject({ env })?.id).toBe(durable.project.id);

    const applied = applyLeakedCliTestFixtures({
      env,
      apply: true,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(applied.applied).toBe(true);
    expect(applied.backupDir).toBeDefined();
    expect(existsSync(join(applied.backupDir!, "project-registry.json"))).toBe(
      true,
    );
    expect(existsSync(join(applied.backupDir!, "manifest.json"))).toBe(true);
    expect(listHubProjects({ env })).toEqual([
      expect.objectContaining({
        id: durable.project.id,
        name: "durable-app",
        selected: true,
      }),
    ]);
    expect(existsSync(leaked.project.hubProjectDir)).toBe(false);
    expect(existsSync(leakedPathHashDir)).toBe(false);
    expect(existsSync(durable.project.hubProjectDir)).toBe(true);
    expect(resolveSelectedHubProject({ env })?.id).toBe(durable.project.id);
    expect(resolveGitRepoRoot(durableRepo)).toBe(durable.project.repoRoot);

    const manifest = JSON.parse(
      readFileSync(join(applied.backupDir!, "manifest.json"), "utf8"),
    ) as { registryEntryIds: string[] };
    expect(manifest.registryEntryIds).toEqual([leaked.project.id]);

    const second = applyLeakedCliTestFixtures({
      env,
      apply: true,
      now: new Date("2026-08-19T00:01:00.000Z"),
    });
    expect(second.registryEntries).toEqual([]);
    expect(second.pathHashProjectDirs).toEqual([]);
    expect(second.applied).toBe(false);
    expect(second.backupDir).toBeUndefined();
    expect(listHubProjects({ env })).toHaveLength(1);
  });

  it("clears selection when the only remaining selected project is a leaked fixture", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "leaked-cli-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const leakedHost = await createCommittedRepo("cli-host-");
    const leaked = registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });

    const applied = applyLeakedCliTestFixtures({
      env,
      apply: true,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(applied.selectionAction).toBe("clear");
    expect(applied.removedSelectedProjectId).toBe(leaked.project.id);
    expect(resolveSelectedHubProject({ env })).toBeUndefined();
    expect(listHubProjects({ env })).toEqual([]);
  });

  it("selects a remaining durable project when the selected fixture is removed", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "leaked-cli-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const durableRepo = await createCommittedRepo("durable-app-");
    const leakedHost = await createCommittedRepo("cli-host-");
    const durable = registerHubProject({
      repoPath: durableRepo,
      projectName: "durable-app",
      env,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    const leaked = registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });

    const applied = applyLeakedCliTestFixtures({
      env,
      apply: true,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(applied.selectionAction).toBe("select");
    expect(applied.removedSelectedProjectId).toBe(leaked.project.id);
    expect(applied.nextSelectedProjectId).toBe(durable.project.id);
    expect(resolveSelectedHubProject({ env })?.id).toBe(durable.project.id);
  });
});

describe("archloop project prune-test-fixtures", () => {
  const cliPath = join(import.meta.dirname, "..", "dist", "main.js");
  const runCli = (args: string, cwd: string, env: NodeJS.ProcessEnv) =>
    execAsync(`"${process.execPath}" ${cliPath} ${args}`, { cwd, env });

  it("previews leaked fixtures without mutating, then applies with --yes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "leaked-cli-data-"));
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const leakedHost = await createCommittedRepo("cli-host-");
    const durableRepo = await createCommittedRepo("durable-app-");
    const leaked = registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const durable = registerHubProject({
      repoPath: durableRepo,
      projectName: "durable-app",
      env,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });

    const { stdout: dryRun } = await runCli(
      "project prune-test-fixtures",
      durableRepo,
      env,
    );
    expect(dryRun).toContain("dry run");
    expect(dryRun).toContain(leaked.project.name);
    expect(listHubProjects({ env })).toHaveLength(2);

    try {
      await runCli("project prune-test-fixtures --apply", durableRepo, env);
      expect.fail("Expected command to fail without --yes");
    } catch (error) {
      const failure = error as Partial<Record<"stdout" | "stderr", unknown>>;
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      expect(output).toMatch(/--yes/);
    }

    const { stdout: applied } = await runCli(
      "project prune-test-fixtures --apply --yes",
      durableRepo,
      env,
    );
    expect(applied).toContain("Removed leaked CLI-test Hub fixtures.");
    expect(listHubProjects({ env })).toEqual([
      expect.objectContaining({ id: durable.project.id, selected: true }),
    ]);
    expect(existsSync(leaked.project.hubProjectDir)).toBe(false);
  });
});
