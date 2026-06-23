import { describe, expect, it } from "vitest";

import {
  EXCLUDED_HUB_TASK_STATUSES,
  assertNoExcludedHubTaskStatuses,
  describeHubRuntimeAction,
  listCanonicalHubTaskStatuses,
} from "./hubRuntimeBridge.js";
import {
  createHubDesktopFixtureProjectStatus,
  createHubDesktopFixtureTaskBoard,
} from "./hubRuntimeBridgeFixtures.js";
import { createHubRuntimeBridgeService } from "./hubRuntimeBridgeService.js";
import { isCanonicalHubTaskStatus } from "./taskBoard.js";

describe("hubRuntimeBridge contract", () => {
  it("describes mutating actions as confirm-gated", () => {
    expect(describeHubRuntimeAction("recover.execute")).toEqual({
      kind: "mutating",
      requiresConfirm: true,
    });
    expect(describeHubRuntimeAction("project.getStatus")).toEqual({
      kind: "read",
      requiresConfirm: false,
    });
    expect(describeHubRuntimeAction("recover.preview")).toEqual({
      kind: "preview",
      requiresConfirm: false,
    });
  });

  it("rejects excluded Hub task statuses in bridge fixtures and vocabulary", () => {
    const board = createHubDesktopFixtureTaskBoard();
    const statuses = board.tasks.map((task) => task.hubStatus);
    assertNoExcludedHubTaskStatuses(statuses);
    for (const status of EXCLUDED_HUB_TASK_STATUSES) {
      expect(isCanonicalHubTaskStatus(status)).toBe(false);
    }
    for (const status of listCanonicalHubTaskStatuses()) {
      expect(isCanonicalHubTaskStatus(status)).toBe(true);
    }
  });
});

describe("hubRuntimeBridgeService", () => {
  it("serves fixture project status and task board for smoke checks", async () => {
    const bridge = createHubRuntimeBridgeService({ useFixtures: true });
    const status = await bridge.invoke({
      action: "project.getStatus",
      params: {},
    });
    const board = await bridge.invoke({
      action: "taskBoard.load",
      params: {},
    });

    expect(status.ok).toBe(true);
    expect(board.ok).toBe(true);
    if (status.ok) {
      expect(status.data.repoRoot).toBe(
        createHubDesktopFixtureProjectStatus().repoRoot,
      );
    }
    if (board.ok) {
      expect(board.data.tasks.length).toBeGreaterThan(0);
    }
  });

  it("requires preview confirm tokens before mutating actions execute", async () => {
    const bridge = createHubRuntimeBridgeService({ useFixtures: true });
    const preview = await bridge.invoke({
      action: "recover.preview",
      params: { taskId: "arch-2" },
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }

    const rejected = await bridge.invoke({
      action: "recover.execute",
      params: {
        taskId: "arch-2",
        outcome: "ready_for_agent",
        confirmToken: "invalid",
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("confirm_invalid");
    }

    const accepted = await bridge.invoke({
      action: "recover.execute",
      params: {
        taskId: "arch-2",
        outcome: "ready_for_agent",
        confirmToken: preview.data.confirmToken,
      },
    });
    expect(accepted.ok).toBe(true);
  });

  it("returns disabled reasons for recover preview on non-failed tasks in real mode", async () => {
    const bridge = createHubRuntimeBridgeService({
      cwd: process.cwd(),
      useFixtures: false,
    });
    const board = await bridge.invoke({
      action: "taskBoard.load",
      params: {},
    });
    if (!board.ok || board.data.tasks.length === 0) {
      return;
    }

    const readyTask = board.data.tasks.find(
      (task) => task.hubStatus !== "failed",
    );
    if (!readyTask) {
      return;
    }

    const preview = await bridge.invoke({
      action: "recover.preview",
      params: { taskId: readyTask.id },
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.disabledReason).toContain("failed");
    }
  });
});
