import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { stripVTControlCharacters } from "node:util";

import type { HubRunDisplayState } from "./hubRunDisplay.js";
import { createHubRunLiveDisplay } from "./hubRunLiveDisplay.js";

const runningState = (): HubRunDisplayState => ({
  hubProjectName: "archloop",
  flowId: "with-review",
  runId: "run-7",
  runDir: "/repo/.archloop/hub/projects/archloop/runs/run-7",
  status: "running",
  completedBatchCount: 0,
  completedTaskCount: 0,
  batches: {
    "batch-1": {
      batchId: "batch-1",
      selectedTaskIds: ["task-b", "task-a"],
      status: "planning",
      stage: "Planning",
    },
  },
  tasks: {
    "task-a": {
      taskId: "task-a",
      batchId: "batch-1",
      status: "reviewing",
      stage: "Reviewing",
    },
    "task-b": {
      taskId: "task-b",
      batchId: "batch-1",
      status: "implementing",
      stage: "Implementing",
    },
  },
  seenEventIds: new Set(),
  eventSequences: { batches: {}, tasks: {} },
});

describe("createHubRunLiveDisplay", () => {
  it("renders a compact header and stable current-batch rows", () => {
    let output = "";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    display.update(runningState());

    expect(output).toContain(
      "archLoop run | Project archloop | Flow with-review | Run run-7",
    );
    expect(output).toContain("Batch batch-1 | Planning | 2 tasks");
    expect(output).toContain("Implementing | task-b");
    expect(output).toContain("Reviewing | task-a");
    expect(output.indexOf("task-b")).toBeLessThan(output.indexOf("task-a"));
  });

  it("keeps every planned task row stable before its first task event", () => {
    let output = "";
    const state = runningState();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 72,
      color: false,
    });

    display.update({
      ...state,
      batches: {
        "batch-1": {
          ...state.batches["batch-1"]!,
          taskTitles: {
            "task-b": "Implement a deliberately long selected task title",
            "task-a": "Review output",
          },
        },
      },
      tasks: {},
    });

    expect(output).toContain("Queued");
    expect(output).toContain("task-b");
    expect(output).toContain("Implement a deliberately long selected");
    expect(output).toContain("task-a");
    expect(
      output
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .split("\n")
        .every((line) => stringWidth(line) < 72),
    ).toBe(true);
  });

  it("rewrites only its bounded region without entering alternate screen", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });
    const first = runningState();
    const second: HubRunDisplayState = {
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

    display.update(first);
    display.update(second);

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain("\x1b[2K");
    const firstRegionLineCount = chunks[0]!.split("\n").length;
    expect(chunks[1]!.match(/\x1b\[1A/g)).toHaveLength(
      firstRegionLineCount - 1,
    );
    expect(chunks.join("")).not.toContain("\x1b[?1049");
    expect(chunks.join("").match(/\x1b\[\?25l/g)).toHaveLength(1);
  });

  it("moves completed batches to scrollback exactly once", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });
    const first = runningState();
    const second: HubRunDisplayState = {
      ...first,
      batches: {
        "batch-1": {
          ...first.batches["batch-1"]!,
          status: "done",
          stage: "Completed",
        },
        "batch-2": {
          batchId: "batch-2",
          selectedTaskIds: ["task-c"],
          status: "planning",
          stage: "Planning",
        },
      },
      tasks: {
        ...first.tasks,
        "task-c": {
          taskId: "task-c",
          batchId: "batch-2",
          status: "implementing",
          stage: "Implementing",
        },
      },
    };

    display.update(first);
    display.update(second);
    display.update({
      ...second,
      tasks: {
        ...second.tasks,
        "task-c": {
          ...second.tasks["task-c"]!,
          status: "reviewing",
          stage: "Reviewing",
        },
      },
    });

    expect(chunks[1]).toContain("✓ Batch batch-1 completed | 2 tasks\n");
    expect(chunks[1]).toContain("Batch batch-2 | Planning | 1 task");
    expect(chunks[2]).not.toContain("Batch batch-1 completed");
  });

  it("shows elapsed time and the durable log location", () => {
    let output = "";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 65_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    display.update(runningState());

    expect(output).toContain(
      "Elapsed 01:03 | Logs /repo/.archloop/hub/projects/archloop/runs/run-7",
    );
  });

  it("stacks labels and values without overflowing a narrow terminal", () => {
    let output = "";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 56,
      color: false,
    });

    display.update(runningState());

    expect(output).toContain("● Implementing\n    task-b");
    expect(output).toContain("Elapsed 00:03\nLogs");
    const visibleLines = output
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .split("\n");
    expect(visibleLines.every((line) => line.length <= 56)).toBe(true);
  });

  it("refuses a live region that would exceed the terminal height", () => {
    const chunks: string[] = [];
    const state = runningState();
    const taskIds = Array.from({ length: 10 }, (_, index) => `task-${index}`);
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 56,
      rows: 24,
      color: false,
    });

    const rendered = display.update({
      ...state,
      batches: {
        "batch-1": {
          ...state.batches["batch-1"]!,
          selectedTaskIds: taskIds,
        },
      },
      tasks: Object.fromEntries(
        taskIds.map((taskId) => [
          taskId,
          {
            taskId,
            batchId: "batch-1",
            status: "implementing",
            stage: "Implementing",
          },
        ]),
      ),
    });

    expect(rendered).toBe(false);
    expect(chunks).toEqual([]);
  });

  it("fits CJK, emoji, and combining graphemes by terminal display width", () => {
    let output = "";
    const state = runningState();
    const emojiTaskId = `emoji-${"🧑‍💻".repeat(8)}-e\u0301`;
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 40,
      color: false,
    });

    display.update({
      ...state,
      hubProjectName: "中文项目中文项目中文项目中文项目",
      batches: {
        "batch-1": {
          ...state.batches["batch-1"]!,
          selectedTaskIds: [emojiTaskId],
        },
      },
      tasks: {
        [emojiTaskId]: {
          taskId: emojiTaskId,
          batchId: "batch-1",
          status: "implementing",
          stage: "Implementing",
        },
      },
    });

    const lines = output.split("\n");
    expect(lines.every((line) => stringWidth(line) < 40)).toBe(true);
    expect(output).toContain(emojiTaskId);
  });

  it("uses color only as a redundant cue beside symbols and text labels", () => {
    const render = (color: boolean): string => {
      let output = "";
      createHubRunLiveDisplay({
        terminal: { write: (chunk) => (output += chunk) },
        clock: { now: () => 5_000 },
        startedAt: 2_000,
        columns: 120,
        color,
      }).update(runningState());
      return output;
    };

    const withoutColor = render(false);
    const withColor = render(true);

    expect(withoutColor).toContain("● Implementing");
    expect(withoutColor).not.toMatch(/\x1b\[(?:3\d|9\d)m/);
    expect(withColor).toContain("\x1b[36m●\x1b[0m Implementing");
    expect(withColor).toContain("\x1b[36m◆\x1b[0m Reviewing");
  });

  it("renders canonical stages without raw prose, percentages, or ETA claims", () => {
    let output = "";
    const state = runningState();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    display.update({
      ...state,
      tasks: {
        ...state.tasks,
        "task-b": {
          ...state.tasks["task-b"]!,
          stage: "Implementing 42% - ETA 3m - model says almost done",
        },
      },
    });

    expect(output).toContain("● Implementing | task-b");
    expect(output).not.toContain("42%");
    expect(output).not.toContain("ETA");
    expect(output).not.toContain("model says");
  });

  it("filters ANSI, newlines, and control characters from dynamic values", () => {
    let output = "";
    const state = runningState();
    const unsafeTaskId = "task\x1b[31m-red\nINJECTED-TASK\x07";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 200,
      color: false,
    });
    const unsafeState: HubRunDisplayState = {
      ...state,
      hubProjectName: "project\x1b[31m-red\nINJECTED-PROJECT",
      flowId: "flow\rINJECTED-FLOW",
      runId: "run\x00INJECTED-RUN",
      runDir: "/logs\x1b]8;;https://example.invalid\x07/path",
      batches: {
        "batch-1": {
          ...state.batches["batch-1"]!,
          selectedTaskIds: [unsafeTaskId],
        },
      },
      tasks: {
        [unsafeTaskId]: {
          taskId: unsafeTaskId,
          batchId: "batch-1",
          status: "failed",
          stage: "Failed",
        },
      },
    };

    display.update(unsafeState);
    display.finalize(unsafeState, {
      outcome: "failed",
      summary: "Run failed\nINJECTED-SUMMARY",
      counts: {
        completed: 0,
        failed: 1,
        blocked: 0,
        skipped: 0,
        readyToMerge: 0,
      },
      taskDetails: [
        {
          taskId: unsafeTaskId,
          stage: "Failure\x1b[2J\nINJECTED-STAGE",
          diagnostic: "Bad\rINJECTED-DIAGNOSTIC",
          logPath: "/logs\x1b[31m-red\nINJECTED-LOG",
          recoveryCommand: "recover\x07\nINJECTED-RECOVERY",
        },
      ],
      exitCode: 1,
    });

    expect(output).not.toContain("\x1b[31m");
    expect(output).not.toContain("\x1b[2J");
    expect(output).not.toContain("\x1b]8;");
    expect(output).not.toContain("\nINJECTED");
    expect(output).not.toContain("\rINJECTED");
    expect(output).not.toContain("\x00");
    expect(output).not.toContain("\x07");
    expect(output).toContain("INJECTED-DIAGNOSTIC");
    expect(output).toContain("INJECTED-RECOVERY");
  });

  it("finalizes into a durable outcome and restores the cursor once", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 65_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });
    const state = runningState();

    display.update(state);
    display.finalize(state, {
      outcome: "completed",
      summary: "Run completed",
      counts: {
        completed: 2,
        failed: 0,
        blocked: 0,
        skipped: 0,
        readyToMerge: 0,
      },
      taskDetails: [],
      exitCode: 0,
    });
    display.dispose();

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain(
      "✓ Run completed | Completed 2 | Failed 0 | Blocked 0 | Skipped 0 | Ready to merge 0",
    );
    expect(chunks[1]).toContain(
      "Elapsed 01:03 | Logs /repo/.archloop/hub/projects/archloop/runs/run-7",
    );
    expect(chunks.join("").match(/\x1b\[\?25h/g)).toHaveLength(1);
  });

  it("preserves actionable failed and blocked task details in final scrollback", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });
    const state = runningState();

    display.update(state);
    display.finalize(state, {
      outcome: "completed_with_failures",
      summary: "Run completed with failures",
      counts: {
        completed: 1,
        failed: 1,
        blocked: 1,
        skipped: 0,
        readyToMerge: 0,
      },
      taskDetails: [
        {
          taskId: "task-b",
          stage: "Implementation failed",
          diagnostic: "Agent exited before producing a commit.",
          logPath: "/repo/.archloop/runs/run-7/logs/task-b.log",
          recoveryCommand: "archloop tasks recover task-b",
        },
        {
          taskId: "task-a",
          stage: "Merge blocked",
          diagnostic: "Source changes overlap the task branch.",
          logPath: "/repo/.archloop/runs/run-7/logs/task-a-merge.log",
          recoveryCommand: "archloop tasks repair-state task-a",
          blockingPaths: ["src/shared.ts", "src/config.ts"],
        },
      ],
      exitCode: 1,
    });

    expect(chunks[1]).toContain("! Task task-b | Implementation failed");
    expect(chunks[1]).toContain(
      "Diagnostic: Agent exited before producing a commit.",
    );
    expect(chunks[1]).toContain(
      "Log: /repo/.archloop/runs/run-7/logs/task-b.log",
    );
    expect(chunks[1]).toContain("Recovery: archloop tasks recover task-b");
    expect(chunks[1]).toContain("! Task task-a | Merge blocked");
    expect(chunks[1]).toContain(
      "Diagnostic: Source changes overlap the task branch.",
    );
    expect(chunks[1]).toContain(
      "Log: /repo/.archloop/runs/run-7/logs/task-a-merge.log",
    );
    expect(chunks[1]).toContain("Recovery: archloop tasks repair-state task-a");
    expect(chunks[1]).toContain("Blocking paths: src/shared.ts, src/config.ts");
    expect(chunks[1]!.indexOf("! Task task-b")).toBeLessThan(
      chunks[1]!.indexOf("! Run completed with failures"),
    );
  });

  it("wraps final log and recovery values without permanently truncating them", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 40,
      color: false,
    });
    const taskLog =
      "/repo/.archloop/runs/run-7/logs/中文-🧪-task-output-complete.log";
    const runLog =
      "/repo/.archloop/runs/run-7/完整运行日志目录-with-a-long-suffix";
    const recovery =
      "archloop tasks recover task-b --diagnostic-context preserve-all";
    const state = { ...runningState(), runDir: runLog };

    display.update(state);
    display.finalize(state, {
      outcome: "failed",
      summary: "Run failed",
      counts: {
        completed: 0,
        failed: 1,
        blocked: 0,
        skipped: 0,
        readyToMerge: 0,
      },
      taskDetails: [
        {
          taskId: "task-b",
          stage: "Implementation failed",
          diagnostic: "No commit was produced.",
          logPath: taskLog,
          recoveryCommand: recovery,
        },
      ],
      exitCode: 1,
    });

    const scrollback = stripVTControlCharacters(chunks[1]!).replace(/\r/g, "");
    const flattened = scrollback.replace(/\n/g, "");
    expect(flattened).toContain(`Log: ${taskLog}`);
    expect(flattened).toContain(`Recovery: ${recovery}`);
    expect(flattened).toContain(`Logs ${runLog}`);
    expect(scrollback).not.toContain("...");
    expect(scrollback.split("\n").every((line) => stringWidth(line) < 40)).toBe(
      true,
    );
  });

  it("turns cancellation into a final labelled outcome with exit-safe cleanup", () => {
    let output = "";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    display.update(runningState());
    display.cancel(runningState());

    expect(output).toContain(
      "! Run cancelled | Completed 0 | Failed 0 | Blocked 0 | Skipped 0 | Ready to merge 0",
    );
    expect(output.endsWith("\x1b[?25h")).toBe(true);
  });

  it("rerenders on resize and exits live mode when width becomes unsafe", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    display.update(runningState());
    expect(display.resize(56)).toBe(true);
    expect(chunks[1]).toContain("\x1b[2K");
    expect(chunks[1]).not.toBe("\n");
    expect(chunks[2]).toContain("● Implementing\n    task-b");

    expect(display.resize(39)).toBe(false);
    expect(chunks.at(-1)).toContain("\x1b[2K");
    expect(chunks.at(-1)).toContain("\x1b[?25h");
    expect(chunks.join("").match(/\x1b\[\?25h/g)).toHaveLength(1);
  });

  it("clears every reflowed row before rerendering at a new width", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    const state = {
      ...runningState(),
      hubProjectName:
        "a-deliberately-long-project-name-that-reflows-after-resize",
    };
    display.update(state);
    const originalLogicalRows = chunks[0]!.split("\n").length;
    display.resize(40);

    expect(chunks[1]).toContain("\x1b[2K");
    expect(chunks[1]).not.toContain("\n");
    expect(chunks[1]!.match(/\x1b\[1A/g)!.length).toBeGreaterThan(
      originalLogicalRows - 1,
    );
    expect(chunks[2]).toContain("archLoop run | Project a-deliberatel");
    expect(chunks.join("").match(/\x1b\[\?25l/g)).toHaveLength(1);
  });

  it("refreshes elapsed time without requiring a new run event", () => {
    const chunks: string[] = [];
    let now = 5_000;
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => now },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    display.update(runningState());
    now = 67_000;
    display.refresh();

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain("\x1b[2K");
    expect(chunks[1]).toContain("Elapsed 01:05");
    expect(chunks[1]).not.toContain("Batch batch-1 completed");
  });

  it("keeps every final count visible in the stacked layout", () => {
    let output = "";
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (output += chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 56,
      color: false,
    });
    const state = runningState();

    display.update(state);
    display.finalize(state, {
      outcome: "completed_with_failures",
      summary: "Run completed with failures",
      counts: {
        completed: 1,
        failed: 2,
        blocked: 3,
        skipped: 4,
        readyToMerge: 5,
      },
      taskDetails: [],
      exitCode: 1,
    });

    expect(output).toContain("! Run completed with failures");
    expect(output).toContain("Completed 1 | Failed 2");
    expect(output).toContain("Blocked 3 | Skipped 4");
    expect(output).toContain("Ready to merge 5");
  });

  it("restores the terminal when an abnormal caller path disposes the view", () => {
    const chunks: string[] = [];
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => chunks.push(chunk) },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    try {
      display.update(runningState());
      throw new Error("simulated caller failure");
    } catch {
      display.dispose();
    }
    display.dispose();

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain("\x1b[2K");
    expect(chunks[1]!.endsWith("\x1b[?25h")).toBe(true);
  });

  it("restores the cursor after the first terminal write partially succeeds", () => {
    let output = "";
    let writeCount = 0;
    const display = createHubRunLiveDisplay({
      terminal: {
        write: (chunk) => {
          writeCount += 1;
          if (writeCount === 1) {
            output += chunk.slice(0, "\x1b[?25l".length);
            throw new Error("partial terminal write");
          }
          output += chunk;
        },
      },
      clock: { now: () => 5_000 },
      startedAt: 2_000,
      columns: 120,
      color: false,
    });

    expect(() => display.update(runningState())).toThrow(
      "partial terminal write",
    );
    display.dispose();

    expect(writeCount).toBe(2);
    expect(output).toBe("\x1b[?25l\x1b[?25h");
  });
});
