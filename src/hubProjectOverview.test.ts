import { describe, expect, it } from "vitest";

import {
  buildHubOverviewModel,
  formatHubOverviewPath,
  resolveHubOverviewGridClass,
} from "./hubProjectOverview.js";
import { createHubDesktopFixtureProjectStatus } from "./hubRuntimeBridgeFixtures.js";
import { HUB_TASK_STORE_INIT_COMMAND } from "./hubTaskStore.js";
import type { HubProjectStatus } from "./projectStatus.js";

const emptyStatus = (
  overrides: Partial<HubProjectStatus> = {},
): HubProjectStatus => ({
  repoRoot: "/repo",
  archloopUserDataDir: "/data/archloop",
  hubProjectDir: "/data/archloop/hub/projects/abc",
  projectRegistered: false,
  beadsAvailable: false,
  taskStoreInitialized: false,
  taskCounts: { ready: 0, total: 0 },
  statusCounts: {},
  failedTasks: [],
  syncCounts: {
    pushPending: 0,
    conflict: 0,
    localOnly: 0,
    synced: 0,
  },
  activeBatches: [],
  runDirectories: [],
  recentEvents: [],
  worktreeLeaseDiagnostics: [],
  ...overrides,
});

describe("hubProjectOverview", () => {
  it("builds a loading model before runtime data is available", () => {
    const model = buildHubOverviewModel({ loading: true });
    expect(model.phase).toBe("loading");
    expect(model.banners).toEqual([]);
    expect(model.actions).toEqual([]);
  });

  it("surfaces runtime unavailable state with CLI fallback", () => {
    const model = buildHubOverviewModel({
      runtimeError: "Bridge offline",
    });
    expect(model.phase).toBe("runtime_unavailable");
    expect(model.runtimeError).toBe("Bridge offline");
    expect(model.banners[0]).toEqual(
      expect.objectContaining({
        severity: "error",
        cliFallback: "archloop project status",
      }),
    );
  });

  it("reads real project health fields and task counts from status", () => {
    const status = createHubDesktopFixtureProjectStatus();
    const model = buildHubOverviewModel({ status });

    expect(model.phase).toBe("ready");
    expect(model.projectPaths).toEqual({
      repoRoot: status.repoRoot,
      archloopUserDataDir: status.archloopUserDataDir,
      hubProjectDir: status.hubProjectDir,
      projectRegistered: true,
      beadsAvailable: true,
      taskStoreInitialized: true,
    });
    expect(model.taskCounts).toEqual({ ready: 1, total: 3 });
    expect(model.statusCountEntries).toEqual(
      expect.arrayContaining([
        { status: "ready_for_agent", count: 1 },
        { status: "failed", count: 1 },
      ]),
    );
  });

  it("shows banners and CLI-only init action when the task store is missing", () => {
    const model = buildHubOverviewModel({
      status: emptyStatus({
        beadsAvailable: true,
        taskStoreInitialized: false,
      }),
    });

    expect(model.banners).toContainEqual(
      expect.objectContaining({
        id: "task-store-missing",
        severity: "warning",
        cliFallback: HUB_TASK_STORE_INIT_COMMAND,
      }),
    );
    expect(model.actions).toContainEqual(
      expect.objectContaining({
        id: "initialize-task-store",
        kind: "cli_only",
        cliFallback: HUB_TASK_STORE_INIT_COMMAND,
        disabledReason: expect.stringContaining("preview"),
      }),
    );
  });

  it("keeps local task store health separate from remote sync counts", () => {
    const model = buildHubOverviewModel({
      status: createHubDesktopFixtureProjectStatus(),
    });

    expect(model.syncSections).toHaveLength(2);
    expect(model.syncSections[0]).toEqual(
      expect.objectContaining({
        scope: "local",
        title: "Local task store",
      }),
    );
    expect(model.syncSections[1]).toEqual(
      expect.objectContaining({
        scope: "remote",
        title: "Remote sync metadata",
        description: expect.stringContaining("does not mutate"),
      }),
    );
    expect(model.syncSections[1]?.counts).toEqual(
      expect.arrayContaining([
        { label: "push pending", value: 0, tone: "neutral" },
        { label: "local only", value: 1, tone: "neutral" },
        { label: "synced", value: 2, tone: "neutral" },
      ]),
    );
  });

  it("exposes recover and sync preview actions with disabled reasons when unavailable", () => {
    const model = buildHubOverviewModel({
      status: createHubDesktopFixtureProjectStatus(),
    });

    expect(model.actions).toContainEqual(
      expect.objectContaining({
        id: "recover-arch-2",
        kind: "bridge_preview",
        bridgeAction: "recover.preview",
        bridgeParams: { taskId: "arch-2" },
      }),
    );
    expect(model.actions).toContainEqual(
      expect.objectContaining({
        id: "sync-push",
        kind: "bridge_preview",
        bridgeAction: "sync.pushPreview",
      }),
    );
    expect(model.actions).toContainEqual(
      expect.objectContaining({
        id: "sync-pull",
        kind: "bridge_preview",
        bridgeAction: "sync.pullPreview",
      }),
    );

    const beadsUnavailable = buildHubOverviewModel({
      status: emptyStatus({ beadsAvailable: false }),
    });
    expect(beadsUnavailable.actions).toContainEqual(
      expect.objectContaining({
        id: "sync-push",
        disabledReason: expect.stringContaining("Beads"),
      }),
    );
  });

  it("includes failed tasks, active batches, run directories, events, and lease diagnostics", () => {
    const status = createHubDesktopFixtureProjectStatus();
    const model = buildHubOverviewModel({ status });

    expect(model.failedTasks).toHaveLength(1);
    expect(model.activeBatches).toHaveLength(1);
    expect(model.runDirectories).toHaveLength(1);
    expect(model.recentEvents.length).toBeGreaterThan(0);
    expect(model.worktreeLeaseDiagnostics).toEqual([]);
  });

  it("uses stacked overview grid class on narrow viewports", () => {
    expect(resolveHubOverviewGridClass(1440)).toBe("hub-overview-grid");
    expect(resolveHubOverviewGridClass(700)).toBe(
      "hub-overview-grid hub-overview-grid-narrow",
    );
  });

  it("formats long filesystem paths for dense overview panels", () => {
    const path = "/very/long/archloop/user/data/projects/fixture/runs/run-fixture-1";
    expect(formatHubOverviewPath(path, 40)).toBe(
      "…/projects/fixture/runs/run-fixture-1",
    );
    expect(formatHubOverviewPath("/short/path", 40)).toBe("/short/path");
  });
});
