import { describe, expect, it } from "vitest";

import type { HubRunDisplayState } from "./hubRunDisplay.js";
import { createHubRunLiveDisplay } from "./hubRunLiveDisplay.js";
import { isTerminalCursorHidden } from "./terminalCleanup.js";

const runningState = (): HubRunDisplayState => ({
  hubProjectName: "archloop",
  flowId: "with-review",
  runId: "run-74cc88e3-6757-4472-b152-f5cf151be9d3",
  runDir: "/repo/.archloop/hub/projects/archloop/runs/run-74cc88e3-6757-4472-b152-f5cf151be9d3",
  status: "running",
  completedBatchCount: 0,
  completedTaskCount: 0,
  batches: {
    "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b": {
      batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
      selectedTaskIds: ["task-b", "task-a"],
      status: "planning",
      stage: "Planning",
    },
  },
  tasks: {
    "task-a": {
      taskId: "task-a",
      batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
      status: "reviewing",
      stage: "Reviewing",
    },
    "task-b": {
      taskId: "task-b",
      batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
      status: "implementing",
      stage: "Implementing",
    },
  },
  seenEventIds: new Set(),
  eventSequences: { batches: {}, tasks: {} },
});

const createRecordingSpinner = () => {
  const calls: { readonly op: string; readonly msg?: string }[] = [];
  return {
    calls,
    create: () => ({
      start(msg?: string) {
        calls.push({ op: "start", msg });
      },
      stop(msg?: string) {
        calls.push({ op: "stop", msg });
      },
      message(msg?: string) {
        calls.push({ op: "message", msg });
      },
    }),
  };
};

describe("createHubRunLiveDisplay (append-only run card)", () => {
  it("appends a section snapshot without cursor-up repaint", () => {
    let output = "";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
      enableSpinner: false,
    });

    display.update(runningState());

    expect(output).toContain("archLoop");
    expect(output).toContain("archloop · with-review");
    expect(output).toContain("run 74cc88e3");
    expect(output).toContain("batch fd3cdf79");
    expect(output).toContain("task-b");
    expect(output).not.toContain("\x1b[1A");
    expect(output).not.toContain("\x1b[2K");
    expect(output).not.toContain("\x1b[?1049");
    display.dispose();
  });

  it("emits a new section on cross-phase change and only spinner text on sub-phase ticks", () => {
    const chunks: string[] = [];
    const spinner = createRecordingSpinner();
    let now = 5_000;
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => now },
      startedAt: 2_000,
      columns: 120,
      color: true,
      enableSpinner: true,
      createSpinner: spinner.create,
    });
    const first = runningState();
    display.update(first);

    const afterImplementingStage: HubRunDisplayState = {
      ...first,
      tasks: {
        ...first.tasks,
        "task-b": {
          ...first.tasks["task-b"]!,
          stage: "Running tests",
        },
      },
    };
    const sectionCountAfterStart = display.emittedModels().length;
    display.update(afterImplementingStage);
    expect(display.emittedModels()).toHaveLength(sectionCountAfterStart);

    now = 6_000;
    display.refresh();
    expect(spinner.calls.some((call) => call.op === "message")).toBe(true);

    const afterReview: HubRunDisplayState = {
      ...first,
      tasks: {
        ...first.tasks,
        "task-b": {
          ...first.tasks["task-b"]!,
          status: "reviewing",
          stage: "Reviewing",
        },
      },
    };
    display.update(afterReview);
    expect(display.emittedModels().length).toBeGreaterThan(sectionCountAfterStart);
    expect(display.emittedModels().at(-1)?.kind).toBe("task.phase-changed");
    expect(chunks.join("")).not.toContain("\x1b[1A");
    display.dispose();
  });

  it("collapses completed batches on the next section", () => {
    const display = createHubRunLiveDisplay({
      terminal: { write: () => undefined },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
      enableSpinner: false,
    });
    const first = runningState();
    display.update(first);

    const completed: HubRunDisplayState = {
      ...first,
      batches: {
        "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b": {
          ...first.batches["batch-fd3cdf79-1786-4647-8899-d5f80fd8255b"]!,
          status: "done",
          stage: "Completed",
        },
      },
      tasks: {
        "task-a": { ...first.tasks["task-a"]!, status: "done", stage: "Completed" },
        "task-b": { ...first.tasks["task-b"]!, status: "done", stage: "Completed" },
      },
    };
    display.update(completed);
    expect(display.emittedModels().at(-1)?.kind).toBe("batch.completed");

    const nextBatch: HubRunDisplayState = {
      ...completed,
      batches: {
        ...completed.batches,
        "batch-daca6200-3d0a-4e48-86b4-4253a24b4056": {
          batchId: "batch-daca6200-3d0a-4e48-86b4-4253a24b4056",
          selectedTaskIds: ["task-c"],
          status: "planning",
          stage: "Planning",
        },
      },
    };
    display.update(nextBatch);
    const latest = display.emittedModels().at(-1)!;
    expect(latest.kind).toBe("batch.started");
    expect(
      latest.batches.some(
        (batch) =>
          batch.kind === "collapsed" &&
          batch.summary.includes("batch fd3cdf79"),
      ),
    ).toBe(true);
    display.dispose();
  });

  it("finalizes run.failed with a retry fix footer and restores the cursor", () => {
    let output = "";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 65_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
      enableSpinner: false,
    });
    const state = runningState();
    display.update(state);
    display.finalize(
      {
        ...state,
        status: "failed",
        tasks: {
          "task-b": {
            ...state.tasks["task-b"]!,
            status: "failed",
            stage: "Failed",
            detail: {
              taskId: "task-b",
              stage: "Implementation failed",
              diagnostic: "typecheck failed",
            },
          },
        },
      },
      {
        outcome: "failed",
        summary: "Run failed",
        counts: {
          completed: 0,
          failed: 1,
          blocked: 0,
          skipped: 0,
          readyToMerge: 0,
        },
        taskDetails: [],
        exitCode: 1,
      },
    );

    expect(output).toContain("archloop run --resume 74cc88e3 --only-failed");
    expect(output).toContain("\x1b[?25h");
    expect(isTerminalCursorHidden()).toBe(false);
    expect(display.emittedModels().at(-1)?.kind).toBe("run.failed");
  });

  it("keeps the full transition timeline in scrollback across updates", () => {
    let output = "";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
      enableSpinner: false,
    });

    const started: HubRunDisplayState = {
      ...runningState(),
      batches: {},
      tasks: {},
    };
    display.update(started);
    expect(display.emittedModels()[0]?.kind).toBe("run.started");
    expect(display.emittedModels()[0]?.spinnerText).toContain("waiting · plan");

    const withBatch: HubRunDisplayState = {
      ...started,
      batches: {
        "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b": {
          batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
          selectedTaskIds: ["task-b"],
          status: "planning",
          stage: "Planning",
        },
      },
    };
    display.update(withBatch);
    expect(output).toContain("batch fd3cdf79");
    expect(display.emittedModels().map((model) => model.kind)).toEqual([
      "run.started",
      "batch.started",
    ]);
    // Earlier run.started header remains (append-only)
    expect(output.indexOf("archLoop")).toBeLessThan(
      output.lastIndexOf("batch fd3cdf79"),
    );
    display.dispose();
  });

  it("does not use HIDE_CURSOR / CURSOR_UP / clearRenderedRegion machinery", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
      enableSpinner: false,
    });
    display.update(runningState());
    display.update({
      ...runningState(),
      tasks: {
        ...runningState().tasks,
        "task-b": {
          ...runningState().tasks["task-b"]!,
          status: "reviewing",
          stage: "Reviewing",
        },
      },
    });
    const joined = chunks.join("");
    expect(joined).not.toContain("\x1b[1A");
    expect(joined).not.toContain("\x1b[2K");
    expect(joined).not.toMatch(/\x1b\[(?:\d+;)?\d+A/);
    display.dispose();
  });
});
