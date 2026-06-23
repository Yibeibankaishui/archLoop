import { describe, expect, it } from "vitest";

import {
  buildHubRunWorkbenchModel,
  formatHubRunEventLine,
  resolveHubRunWorkbenchGridClass,
  resolveRunBatchRunDir,
  selectDefaultRunFocus,
} from "./hubRunWorkbench.js";
import {
  createHubDesktopFixtureProjectStatus,
  createHubDesktopFixtureRunEvents,
  createHubDesktopFixtureRunSummaries,
} from "./hubRuntimeBridgeFixtures.js";
import type { HubProjectRunSummary } from "./projectStatus.js";

describe("hubRunWorkbench", () => {
  it("builds a loading model before runtime data is available", () => {
    const model = buildHubRunWorkbenchModel({ loading: true });
    expect(model.phase).toBe("loading");
    expect(model.stages).toEqual([]);
    expect(model.actions).toEqual([]);
  });

  it("surfaces runtime unavailable state with CLI fallback", () => {
    const model = buildHubRunWorkbenchModel({
      runtimeError: "Bridge offline",
    });
    expect(model.phase).toBe("runtime_unavailable");
    expect(model.runtimeError).toBe("Bridge offline");
    expect(model.cliFallback).toBe("archloop run . --flow <id>");
  });

  it("shows empty state when no Hub runs exist", () => {
    const model = buildHubRunWorkbenchModel({
      runSummaries: [],
    });
    expect(model.phase).toBe("empty");
    expect(model.terminalPhase).toBe("no_events");
  });

  it("reads run metadata from bridge summaries and events", () => {
    const runSummaries = createHubDesktopFixtureRunSummaries();
    const events = createHubDesktopFixtureRunEvents();
    const model = buildHubRunWorkbenchModel({
      runSummaries,
      eventsSnapshot: events,
      selectedRunId: "run-fixture-1",
      selectedBatchId: "batch-fixture-1",
    });

    expect(model.phase).toBe("ready");
    expect(model.metadata).toEqual(
      expect.objectContaining({
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        flowId: "with-review",
        branch: "archloop/arch-3-awaiting-merge",
        batchStrategy: "ready_queue",
        rationale: "Fixture batch for desktop run workbench",
        selectedTaskIds: ["arch-3"],
      }),
    );
    expect(model.metadata?.deferredTasks).toEqual([
      { taskId: "arch-4", reason: "blocked_dependency" },
    ]);
  });

  it("builds stage timeline from real Hub event vocabulary", () => {
    const model = buildHubRunWorkbenchModel({
      runSummaries: createHubDesktopFixtureRunSummaries(),
      eventsSnapshot: createHubDesktopFixtureRunEvents(),
      selectedRunId: "run-fixture-1",
      selectedBatchId: "batch-fixture-1",
    });

    expect(model.stages.map((stage) => stage.id)).toEqual([
      "run_start",
      "task_claim",
      "implementation",
      "review",
      "verification",
      "merge",
      "close",
      "failure",
      "recovery",
    ]);
    expect(model.stages.find((stage) => stage.id === "run_start")?.state).toBe(
      "complete",
    );
    expect(model.stages.find((stage) => stage.id === "merge")?.state).toBe(
      "active",
    );
  });

  it("represents gate states with actionable next-step copy", () => {
    const model = buildHubRunWorkbenchModel({
      runSummaries: createHubDesktopFixtureRunSummaries(),
      eventsSnapshot: createHubDesktopFixtureRunEvents({
        includeMergeConflict: true,
      }),
      selectedRunId: "run-fixture-1",
      selectedBatchId: "batch-fixture-1",
      projectStatus: createHubDesktopFixtureProjectStatus({
        includeStaleLeaseDiagnostic: true,
      }),
    });

    expect(model.gates).toContainEqual(
      expect.objectContaining({
        kind: "merge_conflict",
        nextStep: expect.stringContaining("Resolve"),
      }),
    );
    expect(model.gates).toContainEqual(
      expect.objectContaining({
        kind: "stale_claim",
      }),
    );
  });

  it("formats terminal output and resolves running vs completed phases", () => {
    const running = buildHubRunWorkbenchModel({
      runSummaries: createHubDesktopFixtureRunSummaries(),
      eventsSnapshot: createHubDesktopFixtureRunEvents(),
      selectedRunId: "run-fixture-1",
      selectedBatchId: "batch-fixture-1",
    });
    expect(running.terminalPhase).toBe("running");
    expect(running.terminalLines.length).toBeGreaterThan(0);
    expect(running.terminalLines.some((line) => line.includes("batch_planned"))).toBe(
      true,
    );

    const completed = buildHubRunWorkbenchModel({
      runSummaries: createHubDesktopFixtureRunSummaries({
        batchStatus: "done",
      }),
      eventsSnapshot: createHubDesktopFixtureRunEvents({ completed: true }),
      selectedRunId: "run-fixture-1",
      selectedBatchId: "batch-fixture-1",
    });
    expect(completed.terminalPhase).toBe("passed");
  });

  it("exposes recover preview and CLI-only resume/cancel actions", () => {
    const model = buildHubRunWorkbenchModel({
      runSummaries: createHubDesktopFixtureRunSummaries(),
      eventsSnapshot: createHubDesktopFixtureRunEvents({
        includeFailedTask: true,
      }),
      selectedRunId: "run-fixture-1",
      selectedBatchId: "batch-fixture-1",
      projectStatus: createHubDesktopFixtureProjectStatus({
        includeStaleLeaseDiagnostic: true,
      }),
    });

    expect(model.actions).toContainEqual(
      expect.objectContaining({
        id: "recover-arch-2",
        kind: "bridge_preview",
        bridgeAction: "recover.preview",
      }),
    );
    expect(model.actions).toContainEqual(
      expect.objectContaining({
        id: "resume-merge",
        kind: "cli_only",
        cliFallback: expect.stringContaining("archloop run"),
      }),
    );
    expect(model.actions).toContainEqual(
      expect.objectContaining({
        id: "cancel-run",
        kind: "cli_only",
        disabledReason: expect.stringContaining("v0"),
      }),
    );
  });

  it("selects active batch focus by default", () => {
    const summaries = createHubDesktopFixtureRunSummaries();
    expect(
      selectDefaultRunFocus(summaries, createHubDesktopFixtureProjectStatus()),
    ).toEqual({
      runId: "run-fixture-1",
      batchId: "batch-fixture-1",
    });
  });

  it("resolves run directory for a selected run and batch", () => {
    const summaries = createHubDesktopFixtureRunSummaries();
    expect(
      resolveRunBatchRunDir(summaries, "run-fixture-1", "batch-fixture-1"),
    ).toBe("/tmp/archloop-user-data/projects/fixture/runs/run-fixture-1");
    expect(
      resolveRunBatchRunDir(summaries, "missing-run", "batch-fixture-1"),
    ).toBeUndefined();
  });

  it("uses stacked grid class on narrow viewports", () => {
    expect(resolveHubRunWorkbenchGridClass(1440)).toBe("hub-run-grid");
    expect(resolveHubRunWorkbenchGridClass(700)).toBe(
      "hub-run-grid hub-run-grid-narrow",
    );
  });

  it("formats JSONL events as readable monospace lines", () => {
    const line = formatHubRunEventLine({
      file: "task.jsonl",
      lineNumber: 2,
      event: {
        type: "task_claimed",
        taskId: "arch-3",
        batchId: "batch-fixture-1",
        createdAt: "2026-06-23T10:01:00.000Z",
      },
    });
    expect(line).toContain("task_claimed");
    expect(line).toContain("arch-3");
  });

  it("surfaces verification failure gate and failed terminal phase", () => {
    const events = createHubDesktopFixtureRunEvents();
    const verificationFailedEvent = {
      file: "task.jsonl",
      lineNumber: 12,
      event: {
        type: "verification_failed",
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        taskId: "arch-3",
        createdAt: "2026-06-23T10:38:30.000Z",
      },
    };
    const model = buildHubRunWorkbenchModel({
      runSummaries: createHubDesktopFixtureRunSummaries(),
      eventsSnapshot: {
        ...events,
        events: [...events.events, verificationFailedEvent],
      },
      selectedRunId: "run-fixture-1",
      selectedBatchId: "batch-fixture-1",
    });

    expect(model.gates).toContainEqual(
      expect.objectContaining({ kind: "verification_failed" }),
    );
    expect(model.terminalPhase).toBe("failed");
    expect(
      model.stages.find((stage) => stage.id === "verification")?.state,
    ).toBe("failed");
  });

  it("marks passed terminal phase when verification succeeds and batch completes", () => {
    const model = buildHubRunWorkbenchModel({
      runSummaries: createHubDesktopFixtureRunSummaries({ batchStatus: "done" }),
      eventsSnapshot: createHubDesktopFixtureRunEvents({ completed: true }),
      selectedRunId: "run-fixture-1",
      selectedBatchId: "batch-fixture-1",
    });

    expect(model.terminalPhase).toBe("passed");
  });
});
