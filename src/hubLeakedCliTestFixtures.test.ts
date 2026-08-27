import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createHubRunContext } from "./hubExecution.js";
import {
  applyLeakedCliTestFixtures,
  diagnoseLeakedCliTestFixtures,
} from "./hubLeakedCliTestFixtures.js";
import {
  listHubProjects,
  registerHubProject,
  resolveHubProjectRegistryPath,
  resolveSelectedHubProject,
} from "./hubProjectRegistry.js";
import { resolveGitRepoRoot } from "./projectStatus.js";

const execAsync = promisify(exec);
const ownedTempDirs = new Set<string>();

const createTestTempDir = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  ownedTempDirs.add(path);
  return path;
};

afterEach(() => {
  for (const path of ownedTempDirs) {
    rmSync(path, { recursive: true, force: true });
  }
  ownedTempDirs.clear();
});

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const createCommittedRepo = async (prefix: string): Promise<string> => {
  const repoDir = await createTestTempDir(prefix);
  await initRepo(repoDir);
  await writeFile(join(repoDir, "package.json"), "{}\n");
  await execAsync("git add package.json && git commit -m 'initial'", {
    cwd: repoDir,
  });
  return repoDir;
};

const legacyProjectId = (repoRoot: string): string =>
  createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);

const legacyProjectDir = (dataDir: string, repoRoot: string): string =>
  join(dataDir, "archloop", "hub", "projects", legacyProjectId(repoRoot));

const writeRunStarted = (
  projectDir: string,
  runId: string,
  repoRoot: string,
): void => {
  const eventsDir = join(projectDir, "runs", runId, "events");
  mkdirSync(eventsDir, { recursive: true });
  writeFileSync(
    join(eventsDir, "run.jsonl"),
    `${JSON.stringify({ type: "run_started", repoRoot, hubProjectDir: projectDir })}\n`,
  );
};

const rewriteRegistry = (
  env: NodeJS.ProcessEnv,
  update: (projects: Array<Record<string, unknown>>) => void,
): void => {
  const registryPath = resolveHubProjectRegistryPath({ env });
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    version: 1;
    projects: Array<Record<string, unknown>>;
  };
  update(registry.projects);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
};

describe("leaked CLI-test Hub fixtures", () => {
  it("diagnoses cli-host/cli-resolve tmp registry entries and path-hash run dirs", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
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

    const leakedPathHashDir = legacyProjectDir(dataDir, leakedHost);
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
    const dataDir = await createTestTempDir("leaked-cli-data-");
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

    const leakedPathHashDir = legacyProjectDir(dataDir, leakedHost);
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
    const dataDir = await createTestTempDir("leaked-cli-data-");
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
    const dataDir = await createTestTempDir("leaked-cli-data-");
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

  it.each(["hub-recover-cleanup-", "hub-recover-blocked-"])(
    "recognizes legacy %s path-hash fixtures with matching SHA-256 ids",
    async (prefix) => {
      const dataDir = await createTestTempDir("leaked-cli-data-");
      const env = { ...process.env, XDG_DATA_HOME: dataDir };
      const repoRoot = await createCommittedRepo(prefix);
      const projectDir = legacyProjectDir(dataDir, repoRoot);
      writeRunStarted(projectDir, "run-test", repoRoot);

      const report = diagnoseLeakedCliTestFixtures({ env });

      expect(report.pathHashProjectDirs).toEqual([projectDir]);
    },
  );

  it("preserves path-hash dirs with a hash mismatch or mixed run roots", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const firstRepo = await createCommittedRepo("hub-recover-cleanup-");
    const secondRepo = await createCommittedRepo("hub-recover-blocked-");

    const mismatchDir = join(
      dataDir,
      "archloop",
      "hub",
      "projects",
      "aaaaaaaaaaaa",
    );
    writeRunStarted(mismatchDir, "run-mismatch", firstRepo);

    const mixedDir = legacyProjectDir(dataDir, firstRepo);
    writeRunStarted(mixedDir, "run-first", firstRepo);
    writeRunStarted(mixedDir, "run-second", secondRepo);

    const unclassifiedRepo = await createCommittedRepo("cli-resolve-");
    const partiallyClassifiedDir = legacyProjectDir(dataDir, unclassifiedRepo);
    writeRunStarted(partiallyClassifiedDir, "run-classified", unclassifiedRepo);
    mkdirSync(
      join(partiallyClassifiedDir, "runs", "run-unclassified", "events"),
      { recursive: true },
    );
    writeFileSync(
      join(
        partiallyClassifiedDir,
        "runs",
        "run-unclassified",
        "events",
        "run.jsonl",
      ),
      `${JSON.stringify({ type: "run_completed" })}\n`,
    );

    const report = diagnoseLeakedCliTestFixtures({ env });

    expect(report.pathHashProjectDirs).toEqual([]);
    expect(existsSync(mismatchDir)).toBe(true);
    expect(existsSync(mixedDir)).toBe(true);
    expect(existsSync(partiallyClassifiedDir)).toBe(true);
  });

  it("does not select a blocked fixture when repairing selection", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const blockedRepo = await createCommittedRepo("cli-host-");
    const selectedRepo = await createCommittedRepo("cli-resolve-");
    const blocked = registerHubProject({
      repoPath: blockedRepo,
      projectName: `cli-host-${blockedRepo.slice(-6)}`,
      env,
    });
    const selected = registerHubProject({
      repoPath: selectedRepo,
      projectName: `cli-resolve-${selectedRepo.slice(-6)}`,
      env,
    });
    const outsideDir = await createTestTempDir("outside-hub-project-");
    rewriteRegistry(env, (projects) => {
      const entry = projects.find(
        (project) => project.id === blocked.project.id,
      );
      if (entry) {
        entry.hubProjectDir = outsideDir;
      }
    });

    const report = diagnoseLeakedCliTestFixtures({ env });

    expect(report.registryEntries.map((entry) => entry.id)).toEqual([
      selected.project.id,
    ]);
    expect(report.blockedRegistryEntries.map(({ entry }) => entry.id)).toEqual([
      blocked.project.id,
    ]);
    expect(report.selectionAction).toBe("clear");
    expect(report.nextSelectedProjectId).toBeUndefined();
  });

  it("preserves a classified path-hash directory referenced by a durable registry entry", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const durableRepo = await createCommittedRepo("durable-app-");
    const recoverRepo = await createCommittedRepo("hub-recover-cleanup-");
    const durable = registerHubProject({
      repoPath: durableRepo,
      projectName: "durable-app",
      env,
    });
    const collisionDir = legacyProjectDir(dataDir, recoverRepo);
    writeRunStarted(collisionDir, "run-test", recoverRepo);
    rewriteRegistry(env, (projects) => {
      const entry = projects.find(
        (project) => project.id === durable.project.id,
      );
      if (entry) {
        entry.hubProjectDir = collisionDir;
      }
    });

    const report = diagnoseLeakedCliTestFixtures({ env });

    expect(report.pathHashProjectDirs).toEqual([]);
    expect(existsSync(collisionDir)).toBe(true);
  });

  it("blocks non-canonical and symlinked stable fixture directories", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const leakedHost = await createCommittedRepo("cli-host-");
    const leaked = registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
    });
    const outsideDir = await createTestTempDir("outside-hub-project-");
    rewriteRegistry(env, (projects) => {
      const entry = projects.find(
        (project) => project.id === leaked.project.id,
      );
      if (entry) {
        entry.hubProjectDir = outsideDir;
      }
    });

    let report = diagnoseLeakedCliTestFixtures({ env });
    expect(report.registryEntries).toEqual([]);
    expect(report.blockedRegistryEntries[0]?.reason).toMatch(/canonical path/);

    rewriteRegistry(env, (projects) => {
      const entry = projects.find(
        (project) => project.id === leaked.project.id,
      );
      if (entry) {
        entry.hubProjectDir = leaked.project.hubProjectDir;
      }
    });
    rmSync(leaked.project.hubProjectDir, { recursive: true, force: true });
    symlinkSync(outsideDir, leaked.project.hubProjectDir, "dir");

    report = diagnoseLeakedCliTestFixtures({ env });
    expect(report.registryEntries).toEqual([]);
    expect(report.blockedRegistryEntries[0]?.reason).toMatch(/symbolic link/);
    rmSync(leaked.project.hubProjectDir, { force: true });
    symlinkSync(
      join(outsideDir, "missing-target"),
      leaked.project.hubProjectDir,
    );
    report = diagnoseLeakedCliTestFixtures({ env });
    expect(report.registryEntries).toEqual([]);
    expect(report.blockedRegistryEntries[0]?.reason).toMatch(/symbolic link/);
    expect(applyLeakedCliTestFixtures({ env, apply: true }).applied).toBe(
      false,
    );
    expect(existsSync(outsideDir)).toBe(true);
  });

  it("backs up complete payload content with verified digests before deletion", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const leakedHost = await createCommittedRepo("cli-host-");
    const leaked = registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
    });
    const contractPath = join(leaked.project.hubProjectDir, "contract.md");
    writeFileSync(contractPath, "recover this stable payload\n");
    const pathHashDir = legacyProjectDir(dataDir, leakedHost);
    writeRunStarted(pathHashDir, "run-payload", leakedHost);
    const artifactPath = join(
      pathHashDir,
      "runs",
      "run-payload",
      "artifact.txt",
    );
    writeFileSync(artifactPath, "recover this run artifact\n");

    const applied = applyLeakedCliTestFixtures({
      env,
      apply: true,
      now: new Date("2026-08-20T00:00:00.000Z"),
    });
    const manifest = JSON.parse(
      readFileSync(join(applied.backupDir!, "manifest.json"), "utf8"),
    ) as {
      payloads: Array<{
        originalPath: string;
        backupRelativePath: string;
        digest: { sha256: string; files: number; bytes: number };
      }>;
    };
    expect(manifest.payloads).toHaveLength(2);
    expect(manifest.payloads.every((payload) => payload.digest.sha256)).toBe(
      true,
    );
    const stablePayload = manifest.payloads.find(
      (payload) => payload.originalPath === leaked.project.hubProjectDir,
    )!;
    const runPayload = manifest.payloads.find(
      (payload) => payload.originalPath === pathHashDir,
    )!;
    expect(
      readFileSync(
        join(
          applied.backupDir!,
          stablePayload.backupRelativePath,
          "contract.md",
        ),
        "utf8",
      ),
    ).toBe("recover this stable payload\n");
    expect(
      readFileSync(
        join(
          applied.backupDir!,
          runPayload.backupRelativePath,
          "runs",
          "run-payload",
          "artifact.txt",
        ),
        "utf8",
      ),
    ).toBe("recover this run artifact\n");
  });

  it("does not mutate registry or payloads when backup verification fails", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const leakedHost = await createCommittedRepo("cli-host-");
    const leaked = registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
    });

    expect(() =>
      applyLeakedCliTestFixtures({
        env,
        apply: true,
        now: new Date("2026-08-21T00:00:00.000Z"),
        verifyBackupPayload: () => {
          throw new Error("injected verification failure");
        },
      }),
    ).toThrow(/injected verification failure/);
    expect(listHubProjects({ env }).map((entry) => entry.id)).toEqual([
      leaked.project.id,
    ]);
    expect(existsSync(leaked.project.hubProjectDir)).toBe(true);
    expect(
      existsSync(
        join(
          dataDir,
          "archloop",
          "hub",
          "backups",
          "leaked-cli-test-fixtures-2026-08-21T00-00-00-000Z",
        ),
      ),
    ).toBe(false);
  });

  it("keeps registry evidence after deletion failure so a retry converges", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const leakedHost = await createCommittedRepo("cli-host-");
    const leaked = registerHubProject({
      repoPath: leakedHost,
      projectName: `cli-host-${leakedHost.slice(-6)}`,
      env,
    });

    expect(() =>
      applyLeakedCliTestFixtures({
        env,
        apply: true,
        now: new Date("2026-08-22T00:00:00.000Z"),
        removeProjectDirectory: (path) => {
          rmSync(path, { recursive: true, force: true });
          throw new Error("injected deletion failure");
        },
      }),
    ).toThrow(/injected deletion failure/);
    expect(listHubProjects({ env }).map((entry) => entry.id)).toEqual([
      leaked.project.id,
    ]);

    const retried = applyLeakedCliTestFixtures({
      env,
      apply: true,
      now: new Date("2026-08-22T00:01:00.000Z"),
    });
    expect(retried.applied).toBe(true);
    expect(listHubProjects({ env })).toEqual([]);
  });
});

describe("archloop project prune-test-fixtures", () => {
  const cliPath = join(import.meta.dirname, "..", "dist", "main.js");
  const runCli = (args: string, cwd: string, env: NodeJS.ProcessEnv) =>
    execAsync(`"${process.execPath}" ${cliPath} ${args}`, { cwd, env });

  it("previews leaked fixtures without mutating, then applies with --yes", async () => {
    const dataDir = await createTestTempDir("leaked-cli-data-");
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

    const { stdout: dryRun, stderr: dryRunStderr } = await runCli(
      "project prune-test-fixtures",
      durableRepo,
      env,
    );
    const dryRunOutput = `${dryRun}${dryRunStderr}`;
    expect(dryRunOutput).toContain("dry run");
    expect(dryRunOutput).toContain(leaked.project.name);
    expect(listHubProjects({ env })).toHaveLength(2);

    try {
      await runCli("project prune-test-fixtures --apply", durableRepo, env);
      expect.fail("Expected command to fail without --yes");
    } catch (error) {
      const failure = error as Partial<Record<"stdout" | "stderr", unknown>>;
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      expect(output).toMatch(/--yes/);
    }

    const { stdout: applied, stderr: appliedStderr } = await runCli(
      "project prune-test-fixtures --apply --yes",
      durableRepo,
      env,
    );
    expect(`${applied}${appliedStderr}`).toContain(
      "Removed leaked CLI-test Hub fixtures.",
    );
    expect(listHubProjects({ env })).toEqual([
      expect.objectContaining({ id: durable.project.id, selected: true }),
    ]);
    expect(existsSync(leaked.project.hubProjectDir)).toBe(false);
  });
});
