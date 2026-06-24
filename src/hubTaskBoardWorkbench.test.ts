import { describe, expect, it } from "vitest";

import {
  buildHubTaskBoardWorkbenchModel,
  buildHubTaskInspectorModel,
  filterHubTaskBoardTasks,
  formatHubTaskBoardStatusLabel,
  matchesHubTaskBoardSearch,
  readHubTaskBoardSyncState,
  resolveHubTaskBoardGridClass,
} from "./hubTaskBoardWorkbench.js";
import {
  createHubDesktopFixtureProjectStatus,
  createHubDesktopFixtureTaskBoard,
  createHubDesktopFixtureTasks,
} from "./hubRuntimeBridgeFixtures.js";
import { HUB_TASK_STATUSES } from "./taskBoard.js";
import { EXCLUDED_HUB_TASK_STATUSES } from "./hubRuntimeBridge.js";

describe("hubTaskBoardWorkbench", () => {
  it("builds a loading model before runtime data is available", () => {
    const model = buildHubTaskBoardWorkbenchModel({ loading: true });
    expect(model.phase).toBe("loading");
    expect(model.columns).toEqual([]);
    expect(model.actions).toEqual([]);
  });

  it("surfaces runtime unavailable state with CLI fallback", () => {
    const model = buildHubTaskBoardWorkbenchModel({
      runtimeError: "Bridge offline",
    });
    expect(model.phase).toBe("runtime_unavailable");
    expect(model.runtimeError).toBe("Bridge offline");
    expect(model.cliFallback).toBe("archloop tasks list");
  });

  it("shows empty state when the local task store has no tasks", () => {
    const model = buildHubTaskBoardWorkbenchModel({
      board: { tasks: [], groups: [] },
    });
    expect(model.phase).toBe("empty");
    expect(model.totalTaskCount).toBe(0);
  });

  it("groups tasks only by canonical Hub statuses", () => {
    const board = createHubDesktopFixtureTaskBoard();
    const model = buildHubTaskBoardWorkbenchModel({ board });

    expect(model.phase).toBe("ready");
    expect(model.columns.map((column) => column.status)).toEqual(
      HUB_TASK_STATUSES.filter((status) =>
        board.tasks.some((task) => task.hubStatus === status),
      ),
    );
    for (const status of EXCLUDED_HUB_TASK_STATUSES) {
      expect(
        model.columns.some((column) => column.status === (status as string)),
      ).toBe(false);
    }
  });

  it("builds task cards with sync, claim, warning, failure, and dependency markers", () => {
    const tasks = createHubDesktopFixtureTasks();
    const board = createHubDesktopFixtureTaskBoard();
    const model = buildHubTaskBoardWorkbenchModel({
      board: {
        ...board,
        tasks,
      },
    });

    const failedCard = model.columns
      .flatMap((column) => column.tasks)
      .find((card) => card.id === "arch-2");
    expect(failedCard?.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "failure" }),
        expect.objectContaining({ kind: "sync" }),
      ]),
    );
    expect(failedCard?.progressPercent).toBeGreaterThan(0);
    expect(failedCard?.claimSummary).toBeUndefined();

    const claimedCard = model.columns
      .flatMap((column) => column.tasks)
      .find((card) => card.id === "arch-3");
    expect(claimedCard?.claimState).toBe("active");
    expect(claimedCard?.claimSummary).toContain(
      "archloop/arch-3-awaiting-merge",
    );
    expect(claimedCard?.progressLabel).toContain("waiting for merge");
    expect(claimedCard?.markers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "claim" })]),
    );

    const blockedCard = model.columns
      .flatMap((column) => column.tasks)
      .find((card) => card.id === "arch-4");
    expect(blockedCard?.markers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "dependency" })]),
    );
  });

  it("treats claim as metadata rather than a task status", () => {
    const board = createHubDesktopFixtureTaskBoard();
    const statuses = board.tasks.map((task) => task.hubStatus);
    expect(statuses).not.toContain("claimed");
    expect(board.tasks.find((task) => task.id === "arch-3")?.claimState).toBe(
      "active",
    );
  });

  it("filters tasks by search query and hub status", () => {
    const tasks = createHubDesktopFixtureTasks();
    const filtered = filterHubTaskBoardTasks(tasks, {
      searchQuery: "recover",
      hubStatus: "failed",
    });
    expect(filtered.map((task) => task.id)).toEqual(["arch-2"]);
    expect(matchesHubTaskBoardSearch(tasks[0]!, "wire")).toBe(true);
    expect(matchesHubTaskBoardSearch(tasks[0]!, "missing")).toBe(false);
  });

  it("filters tasks by claim and sync metadata", () => {
    const tasks = createHubDesktopFixtureTasks();
    expect(
      filterHubTaskBoardTasks(tasks, { claimFilter: "active" }).map(
        (task) => task.id,
      ),
    ).toEqual(["arch-3"]);
    expect(
      filterHubTaskBoardTasks(tasks, { syncFilter: "push_pending" }).map(
        (task) => task.id,
      ),
    ).toEqual(["arch-2"]);
    expect(readHubTaskBoardSyncState(tasks[1]!)).toBe("push_pending");
  });

  it("builds inspector sections with beads details, comments, lease, and next actions", () => {
    const tasks = createHubDesktopFixtureTasks();
    const task = tasks.find((entry) => entry.id === "arch-2")!;
    const inspector = buildHubTaskInspectorModel({
      task,
      projectStatus: createHubDesktopFixtureProjectStatus({
        includeStaleLeaseDiagnostic: true,
      }),
    });

    expect(inspector.sections.map((section) => section.id)).toEqual(
      expect.arrayContaining([
        "summary",
        "beads",
        "metadata",
        "runs",
        "run-directories",
        "lease",
        "failure",
        "comments",
      ]),
    );
    expect(inspector.commentsSummary).toContain("1 comment");
    expect(inspector.actions).toContainEqual(
      expect.objectContaining({
        id: "recover-arch-2",
        kind: "bridge_preview",
        bridgeAction: "recover.preview",
      }),
    );
    expect(inspector.actions).toContainEqual(
      expect.objectContaining({
        id: "comment-arch-2",
        kind: "cli_only",
        cliFallback: "archloop tasks comment arch-2",
      }),
    );
  });

  it("exposes sync preview actions and CLI-only open-run/open-remote fallbacks", () => {
    const model = buildHubTaskBoardWorkbenchModel({
      board: createHubDesktopFixtureTaskBoard(),
      projectStatus: createHubDesktopFixtureProjectStatus(),
      selectedTaskId: "arch-5",
    });

    expect(model.toolbarActions).toContainEqual(
      expect.objectContaining({
        id: "create-task",
        kind: "bridge_preview",
        bridgeAction: "task.createPreview",
      }),
    );
    expect(model.toolbarActions).toContainEqual(
      expect.objectContaining({
        id: "run-triage",
        kind: "cli_only",
        cliFallback: expect.stringContaining("tasks triage"),
      }),
    );
    expect(model.actions).toContainEqual(
      expect.objectContaining({
        id: "sync-push",
        kind: "bridge_preview",
        bridgeAction: "sync.pushPreview",
      }),
    );
    expect(model.inspector?.actions).toContainEqual(
      expect.objectContaining({
        id: "open-remote-arch-5",
        kind: "cli_only",
        cliFallback: expect.stringContaining("gh issue view"),
      }),
    );
    expect(model.inspector?.actions).toContainEqual(
      expect.objectContaining({
        id: "open-run-arch-5",
        kind: "cli_only",
        cliFallback: expect.stringContaining("archloop project status"),
      }),
    );
  });

  it("uses stacked board grid class on narrow viewports", () => {
    expect(resolveHubTaskBoardGridClass(1440)).toBe("hub-task-board-grid");
    expect(resolveHubTaskBoardGridClass(700)).toBe(
      "hub-task-board-grid hub-task-board-grid-narrow",
    );
  });

  it("formats canonical status labels for column headers", () => {
    expect(formatHubTaskBoardStatusLabel("ready_for_agent")).toBe(
      "ready for agent",
    );
    expect(formatHubTaskBoardStatusLabel("sync_conflict")).toBe(
      "sync conflict",
    );
  });
});
