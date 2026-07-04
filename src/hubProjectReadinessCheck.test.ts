import { exec } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { HubProjectListEntry } from "./hubProjectRegistry.js";

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

const createProject = (
  overrides: Partial<HubProjectListEntry> &
    Pick<HubProjectListEntry, "id" | "name">,
): HubProjectListEntry => ({
  id: overrides.id,
  name: overrides.name,
  repoRoot: overrides.repoRoot ?? "/tmp/repo",
  hubProjectDir:
    overrides.hubProjectDir ?? "/tmp/data/archloop/hub/projects/demo",
  projectProfile: overrides.projectProfile ?? "generic",
  createdAt: overrides.createdAt ?? "2026-07-04T12:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-07-04T12:00:00.000Z",
  selected: overrides.selected ?? false,
});

describe("hubProjectReadinessCheck", () => {
  it("reports repo, git, contract, task-store, run, and flow readiness for a selected project", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-project-readiness-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const project = createProject({
      id: "project-alpha",
      name: "alpha",
      repoRoot: repoDir,
      hubProjectDir: join(repoDir, ".archloop", "hub", "projects", "alpha"),
      projectProfile: "node",
      selected: true,
    });

    const report = await (
      await import("./hubProjectReadinessCheck.js")
    ).collectHubProjectReadinessCheck(project, {
      resolveProjectStatus: () => ({
        repoRoot: repoDir,
        archloopUserDataDir: join(repoDir, "xdg-data", "archloop"),
        hubProjectDir: project.hubProjectDir,
        projectProfile: "node",
        projectDevelopmentContractPath: join(
          project.hubProjectDir,
          "development-contract.json",
        ),
        projectDevelopmentContractPersisted: true,
        projectRegistered: true,
        beadsAvailable: true,
        taskStoreInitialized: true,
        taskCounts: { ready: 2, total: 5 },
        statusCounts: { failed: 1 },
        failedTasks: [
          {
            id: "bd-2",
            title: "Failed task",
            failureReason: "agent_failed",
            nextAction:
              "archloop tasks recover bd-2 to reset and retry agent work",
          },
        ],
        syncCounts: {
          pushPending: 0,
          conflict: 0,
          localOnly: 0,
          synced: 0,
        },
        activeBatches: [
          {
            runId: "run-1",
            batchId: "batch-1",
            runDir: join(project.hubProjectDir, "runs", "run-1"),
            status: "planned",
            flowId: "with-review",
            taskCount: 1,
            active: true,
          },
        ],
        runDirectories: [join(project.hubProjectDir, "runs", "run-1")],
        recentEvents: [],
        worktreeLeaseDiagnostics: [],
      }),
    });

    const output = (await import("./hubProjectReadinessCheck.js"))
      .formatHubProjectReadinessCheckLines(project, report)
      .join("\n");

    expect(report.hasErrors).toBe(false);
    expect(report.hasWarnings).toBe(true);
    expect(output).toContain("Hub project readiness check: alpha");
    expect(output).toContain("Checking repository path");
    expect(output).toContain(`Repository path exists at ${repoDir}.`);
    expect(output).toContain("Checking git repository");
    expect(output).toContain("Git repository root:");
    expect(output).toContain("Checking initial commit");
    expect(output).toContain("Initial commit present.");
    expect(output).toContain("Checking development contract");
    expect(output).toContain("development-contract.json");
    expect(output).toContain("Checking local task store");
    expect(output).toContain("Local task store is initialized.");
    expect(output).toContain("Checking task summary");
    expect(output).toContain("Ready tasks: 2");
    expect(output).toContain("Failed tasks: 1");
    expect(output).toContain("Checking active runs");
    expect(output).toContain("run-1 / batch-1");
    expect(output).toContain("Checking flow readiness signals");
    expect(output).toContain("ready for flows");
  });

  it("fails when the selected project repo path is missing", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-project-readiness-missing-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const project = createProject({
      id: "project-missing",
      name: "missing",
      repoRoot: repoDir,
      hubProjectDir: join(repoDir, ".archloop", "hub", "projects", "missing"),
      selected: true,
    });

    await rm(repoDir, { recursive: true, force: true });

    const report = await (
      await import("./hubProjectReadinessCheck.js")
    ).collectHubProjectReadinessCheck(project);
    const output = (await import("./hubProjectReadinessCheck.js"))
      .formatHubProjectReadinessCheckLines(project, report)
      .join("\n");

    expect(report.hasErrors).toBe(true);
    expect(output).toContain("Checking repository path");
    expect(output).toContain("Repository path missing");
    expect(output).toContain("does not exist");
  });
});
