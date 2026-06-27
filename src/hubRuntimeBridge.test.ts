import { describe, expect, it } from "vitest";

import {
  EXCLUDED_HUB_TASK_STATUSES,
  assertNoExcludedHubTaskStatuses,
  buildHubRuntimeExecuteParams,
  describeHubRuntimeAction,
  listCanonicalHubTaskStatuses,
  type HubTaskStatus,
} from "./hubRuntimeBridge.js";
import {
  createHubDesktopFixtureProjectStatus,
  createHubDesktopFixtureProposalRunSummaries,
  createHubDesktopFixtureRunSummaries,
  createHubDesktopFixtureTaskBoard,
  FIXTURE_PROPOSAL_RUN_DIR,
} from "./hubRuntimeBridgeFixtures.js";
import { createHubRuntimeBridgeService } from "./hubRuntimeBridgeService.js";
import { isCanonicalHubTaskStatus } from "./taskBoard.js";

describe("hubRuntimeBridge contract", () => {
  it("builds execute params from preview actions", () => {
    expect(
      buildHubRuntimeExecuteParams(
        {
          action: "recover.execute",
          summary: "Recover arch-2",
          confirmToken: "recover-token",
        },
        { taskId: "arch-2" },
      ),
    ).toEqual({
      taskId: "arch-2",
      outcome: "ready_for_agent",
      confirmToken: "recover-token",
    });
    expect(
      buildHubRuntimeExecuteParams(
        {
          action: "sync.pushExecute",
          summary: "Push",
          confirmToken: "push-token",
        },
        { cwd: "/repo" },
      ),
    ).toEqual({
      confirmToken: "push-token",
    });
    expect(
      buildHubRuntimeExecuteParams(
        {
          action: "task.createExecute",
          summary: "Create",
          confirmToken: "create-token",
        },
        { title: "New task" },
      ),
    ).toEqual({
      title: "New task",
      confirmToken: "create-token",
    });
    expect(
      buildHubRuntimeExecuteParams(
        {
          action: "proposal.applyExecute",
          summary: "Apply proposal",
          confirmToken: "proposal-token",
        },
        { runDir: "/tmp/run" },
      ),
    ).toEqual({
      runDir: "/tmp/run",
      confirmToken: "proposal-token",
    });
  });

  it("describes mutating actions as confirm-gated", () => {
    expect(describeHubRuntimeAction("recover.execute")).toEqual({
      kind: "mutating",
      requiresConfirm: true,
    });
    expect(describeHubRuntimeAction("proposal.applyExecute")).toEqual({
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
    expect(describeHubRuntimeAction("proposal.applyPreview")).toEqual({
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
    const canonicalStatuses = listCanonicalHubTaskStatuses();
    expect(canonicalStatuses.length).toBeGreaterThan(0);
    for (const status of canonicalStatuses) {
      const hubStatus: HubTaskStatus = status;
      expect(isCanonicalHubTaskStatus(hubStatus)).toBe(true);
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

  it("serves fixture run summaries and JSONL events for the run workbench", async () => {
    const bridge = createHubRuntimeBridgeService({ useFixtures: true });
    const summaries = await bridge.invoke({
      action: "run.listSummaries",
      params: {},
    });
    expect(summaries.ok).toBe(true);
    if (!summaries.ok) {
      return;
    }

    expect(summaries.data).toEqual([
      ...createHubDesktopFixtureRunSummaries(),
      ...createHubDesktopFixtureProposalRunSummaries(),
    ]);
    const runDir = summaries.data[0]?.batches[0]?.runDir;
    expect(runDir).toBeDefined();
    if (!runDir) {
      return;
    }

    const events = await bridge.invoke({
      action: "run.readEvents",
      params: { runDir },
    });
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.data.events.length).toBeGreaterThan(0);
      expect(events.data.events[0]?.event).toEqual(
        expect.objectContaining({ type: "run_started" }),
      );
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

  it("exposes proposal apply preview-confirm actions for session approval", async () => {
    const bridge = createHubRuntimeBridgeService({ useFixtures: true });
    const preview = await bridge.invoke({
      action: "proposal.applyPreview",
      params: { runDir: FIXTURE_PROPOSAL_RUN_DIR },
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.data.action).toBe("proposal.applyExecute");
    expect(preview.data.summary).toContain("Approve");

    const rejected = await bridge.invoke({
      action: "proposal.applyExecute",
      params: {
        runDir: FIXTURE_PROPOSAL_RUN_DIR,
        confirmToken: "invalid",
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("confirm_invalid");
    }
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
  }, 15_000);
});
