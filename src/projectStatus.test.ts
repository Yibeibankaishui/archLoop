import { exec } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  formatHubProjectStatusLines,
  resolveFailedTaskNextAction,
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveHubProjectStatus,
  resolveArchloopUserDataDir,
} from "./projectStatus.js";
import type { HubTaskProjection } from "./taskBoard.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const createTask = (
  overrides: Partial<HubTaskProjection> &
    Pick<HubTaskProjection, "id" | "title">,
): HubTaskProjection => ({
  beadsStatus: "open",
  hubStatus: "inbox",
  claim: undefined,
  claimState: undefined,
  labels: [],
  metadata: {},
  description: undefined,
  notes: undefined,
  comments: [],
  remoteRefs: [],
  runRefs: [],
  ...overrides,
});

describe("resolveArchloopUserDataDir", () => {
  it("prefers XDG_DATA_HOME and falls back to ~/.local/share", () => {
    expect(
      resolveArchloopUserDataDir(
        { XDG_DATA_HOME: "/tmp/xdg-data" } as NodeJS.ProcessEnv,
        "/home/tester",
      ),
    ).toBe("/tmp/xdg-data/archloop");
    expect(
      resolveArchloopUserDataDir({} as NodeJS.ProcessEnv, "/home/tester"),
    ).toBe("/home/tester/.local/share/archloop");
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
    const canonicalRepoRoot = resolveGitRepoRoot(repoDir);
    expect(resolveGitRepoRoot(nestedDir)).toBe(canonicalRepoRoot);
  });
});

describe("resolveFailedTaskNextAction", () => {
  it("suggests recover for execution failures", () => {
    expect(
      resolveFailedTaskNextAction(
        createTask({ id: "bd-1", title: "Task", hubStatus: "failed" }),
        "agent_failed",
      ),
    ).toContain("archloop tasks recover bd-1");
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

    const canonicalRepoRoot = resolveGitRepoRoot(repoDir);
    const archloopUserDataDir = join(repoDir, "data", "archloop");
    const status = resolveHubProjectStatus({
      cwd: repoDir,
      archloopUserDataDir,
      detectBeadsAvailable: () => false,
    });

    expect(status.repoRoot).toBe(canonicalRepoRoot);
    expect(status.archloopUserDataDir).toBe(archloopUserDataDir);
    expect(status.projectRegistered).toBe(false);
    expect(status.beadsAvailable).toBe(false);
    expect(status.taskStoreInitialized).toBe(false);
    expect(status.taskCounts).toEqual({ ready: 0, total: 0 });
    expect(status.statusCounts).toEqual({});
    expect(status.failedTasks).toEqual([]);
    expect(status.syncCounts).toEqual({
      pushPending: 0,
      conflict: 0,
      localOnly: 0,
      synced: 0,
    });
    expect(status.activeBatches).toEqual([]);
    expect(status.runDirectories).toEqual([]);
    expect(status.recentEvents).toEqual([]);
    expect(status.hubProjectDir).toContain(
      join("data", "archloop", "hub", "projects"),
    );
    expect(status.hubProjectDir).toContain(join(repoDir, "data", "archloop"));

    const secondStatus = resolveHubProjectStatus({
      cwd: repoDir,
      archloopUserDataDir,
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
      archloopUserDataDir: join(repoDir, "data", "archloop"),
      detectBeadsAvailable: () => true,
      detectTaskStoreInitialized: () => true,
      countReadyTasks: () => 2,
      countTotalTasks: () => 7,
      loadTaskBoard: () => ({
        tasks: [
          createTask({
            id: "bd-1",
            title: "Ready",
            hubStatus: "ready_for_agent",
          }),
          createTask({
            id: "bd-2",
            title: "Done",
            hubStatus: "done",
          }),
        ],
        groups: [],
      }),
    });

    expect(status.beadsAvailable).toBe(true);
    expect(status.taskStoreInitialized).toBe(true);
    expect(status.taskCounts).toEqual({ ready: 2, total: 7 });
    expect(status.statusCounts).toEqual({
      ready_for_agent: 1,
      done: 1,
    });
  });

  it("reports uninitialized task store guidance in archLoop terms", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-status-"));
    await initRepo(repoDir);

    const status = resolveHubProjectStatus({
      cwd: repoDir,
      archloopUserDataDir: join(repoDir, "data", "archloop"),
      detectBeadsAvailable: () => true,
      detectTaskStoreInitialized: () => false,
    });

    expect(status.taskStoreInitialized).toBe(false);
    expect(status.taskCounts).toEqual({ ready: 0, total: 0 });
    expect(formatHubProjectStatusLines(status).join("\n")).toContain(
      "archloop tasks init",
    );
    expect(formatHubProjectStatusLines(status).join("\n")).not.toContain(
      "bd init",
    );
  });

  it("summarizes active batches, failed tasks, and run directories", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-status-"));
    await initRepo(repoDir);
    const canonicalRepoRoot = resolveGitRepoRoot(repoDir);
    const archloopUserDataDir = join(repoDir, "data", "archloop");
    const hubProjectDir = resolveHubProjectDir(
      archloopUserDataDir,
      canonicalRepoRoot,
    );
    const runDir = join(hubProjectDir, "runs", "run-active");
    const eventsDir = join(runDir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, "run.jsonl"),
      `${JSON.stringify({
        type: "run_started",
        runId: "run-active",
        branch: "main",
        startedAt: "2026-06-12T10:00:00.000Z",
      })}\n`,
    );
    await writeFile(
      join(eventsDir, "batch.jsonl"),
      [
        {
          type: "batch_started",
          runId: "run-active",
          batchId: "batch-active",
          branch: "main",
          startedAt: "2026-06-12T10:00:00.000Z",
        },
        {
          type: "batch_planned",
          runId: "run-active",
          batchId: "batch-active",
          flowId: "no-review",
          createdAt: "2026-06-12T10:01:00.000Z",
          taskIds: ["bd-1"],
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")
        .concat("\n"),
    );
    await writeFile(
      join(eventsDir, "task.jsonl"),
      `${JSON.stringify({
        type: "task_implementation_started",
        runId: "run-active",
        batchId: "batch-active",
        taskId: "bd-1",
        branch: "archloop/bd-1-task",
        createdAt: "2026-06-12T10:02:00.000Z",
        status: "implementing",
      })}\n`,
    );

    const status = resolveHubProjectStatus({
      cwd: repoDir,
      archloopUserDataDir,
      detectBeadsAvailable: () => true,
      detectTaskStoreInitialized: () => true,
      countReadyTasks: () => 0,
      countTotalTasks: () => 2,
      ensureHubProjectDir: () => true,
      loadTaskBoard: () => ({
        tasks: [
          createTask({
            id: "bd-1",
            title: "Implementing task",
            hubStatus: "implementing",
            claim: {
              runId: "run-active",
              batchId: "batch-active",
              branch: "archloop/bd-1-task",
              claimedAt: "2026-06-12T10:02:00.000Z",
              raw: {},
            },
            claimState: "active",
          }),
          createTask({
            id: "bd-2",
            title: "Failed task",
            hubStatus: "failed",
            metadata: { failureReason: "agent_failed" },
          }),
        ],
        groups: [],
      }),
    });

    expect(status.activeBatches).toEqual([
      expect.objectContaining({
        runId: "run-active",
        batchId: "batch-active",
        status: "planned",
        flowId: "no-review",
        runDir,
        active: true,
      }),
    ]);
    expect(status.failedTasks).toEqual([
      expect.objectContaining({
        id: "bd-2",
        failureReason: "agent_failed",
        nextAction: expect.stringContaining("archloop tasks recover bd-2"),
      }),
    ]);
    expect(status.runDirectories).toContain(runDir);
    expect(status.recentEvents.some((event) => event.includes("bd-1"))).toBe(
      true,
    );
  });

  it("summarizes sync-pending and conflict tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-status-"));
    await initRepo(repoDir);

    const status = resolveHubProjectStatus({
      cwd: repoDir,
      archloopUserDataDir: join(repoDir, "data", "archloop"),
      detectBeadsAvailable: () => true,
      detectTaskStoreInitialized: () => true,
      countReadyTasks: () => 0,
      countTotalTasks: () => 3,
      loadTaskBoard: () => ({
        tasks: [
          createTask({
            id: "bd-push",
            title: "Push pending",
            hubStatus: "ready_for_agent",
            metadata: { sync_state: "push_pending" },
          }),
          createTask({
            id: "bd-conflict",
            title: "Conflict",
            hubStatus: "sync_conflict",
            metadata: { sync_state: "conflict" },
          }),
          createTask({
            id: "bd-synced",
            title: "Synced",
            hubStatus: "done",
            metadata: { sync_state: "synced" },
          }),
        ],
        groups: [],
      }),
    });

    expect(status.syncCounts).toEqual({
      pushPending: 1,
      conflict: 1,
      localOnly: 0,
      synced: 1,
    });
  });
});

describe("formatHubProjectStatusLines", () => {
  it("renders useful output for empty, active, failed, and sync-pending projects", async () => {
    const emptyLines = formatHubProjectStatusLines(
      resolveHubProjectStatus({
        cwd: "/tmp/repo",
        archloopUserDataDir: "/tmp/data/archloop",
        resolveRepoRoot: () => "/tmp/repo",
        detectBeadsAvailable: () => false,
      }),
    );
    expect(emptyLines.join("\n")).toContain(
      "archLoop task runtime unavailable",
    );
    expect(emptyLines.join("\n")).toContain("No Hub run directories");

    const activeLines = formatHubProjectStatusLines(
      resolveHubProjectStatus({
        cwd: "/tmp/repo",
        archloopUserDataDir: "/tmp/data/archloop",
        resolveRepoRoot: () => "/tmp/repo",
        detectBeadsAvailable: () => true,
        detectTaskStoreInitialized: () => true,
        countReadyTasks: () => 1,
        countTotalTasks: () => 2,
        loadTaskBoard: () => ({
          tasks: [
            createTask({
              id: "bd-1",
              title: "Active",
              hubStatus: "implementing",
            }),
          ],
          groups: [],
        }),
        listRunSummaries: () => [
          {
            runId: "run-1",
            runDir: "/tmp/data/archloop/hub/projects/x/runs/run-1",
            branch: "main",
            startedAt: "2026-06-12T10:00:00.000Z",
            batches: [
              {
                runId: "run-1",
                batchId: "batch-1",
                runDir: "/tmp/data/archloop/hub/projects/x/runs/run-1",
                status: "planned",
                flowId: "no-review",
                taskCount: 1,
                active: true,
              },
            ],
          },
        ],
      }),
    );
    expect(activeLines.join("\n")).toContain("implementing: 1");
    expect(activeLines.join("\n")).toContain("batch-1");
    expect(activeLines.join("\n")).toContain("planned");

    const failedLines = formatHubProjectStatusLines(
      resolveHubProjectStatus({
        cwd: "/tmp/repo",
        archloopUserDataDir: "/tmp/data/archloop",
        resolveRepoRoot: () => "/tmp/repo",
        detectBeadsAvailable: () => true,
        detectTaskStoreInitialized: () => true,
        countReadyTasks: () => 0,
        countTotalTasks: () => 1,
        loadTaskBoard: () => ({
          tasks: [
            createTask({
              id: "bd-fail",
              title: "Broken",
              hubStatus: "failed",
              metadata: { failureReason: "merge_conflict" },
            }),
          ],
          groups: [],
        }),
      }),
    );
    expect(failedLines.join("\n")).toContain("bd-fail");
    expect(failedLines.join("\n")).toContain("merge_conflict");
    expect(failedLines.join("\n")).toContain("archloop tasks recover bd-fail");

    const syncLines = formatHubProjectStatusLines(
      resolveHubProjectStatus({
        cwd: "/tmp/repo",
        archloopUserDataDir: "/tmp/data/archloop",
        resolveRepoRoot: () => "/tmp/repo",
        detectBeadsAvailable: () => true,
        detectTaskStoreInitialized: () => true,
        countReadyTasks: () => 0,
        countTotalTasks: () => 1,
        loadTaskBoard: () => ({
          tasks: [
            createTask({
              id: "bd-sync",
              title: "Needs push",
              hubStatus: "ready_for_agent",
              metadata: { sync_state: "push_pending" },
            }),
          ],
          groups: [],
        }),
      }),
    );
    expect(syncLines.join("\n")).toContain("push_pending: 1");
  });
});
