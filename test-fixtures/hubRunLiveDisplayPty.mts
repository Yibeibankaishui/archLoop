import type { HubRunDisplayState } from "../src/hubRunDisplay.ts";
import { createHubRunLiveDisplay } from "../src/hubRunLiveDisplay.ts";
import { setupTerminalCleanup } from "../src/terminalCleanup.ts";

const mode = process.argv[2];
if (mode !== "complete" && mode !== "signal") {
  throw new Error(`Unknown PTY fixture mode: ${mode ?? "missing"}`);
}

setupTerminalCleanup();
process.stdout.write(`PTY_READY tty=${String(process.stdout.isTTY)}\n`);

const runId = "run-74cc88e3-6757-4472-b152-f5cf151be9d3";
const batch1 = "batch-daca6200-3d0a-4e48-86b4-4253a24b4056";
const batch2 = "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b";

const started: HubRunDisplayState = {
  hubProjectName: "archloop",
  flowId: "no-review",
  runId,
  runDir: `/tmp/archloop/${runId}`,
  status: "running",
  completedBatchCount: 0,
  completedTaskCount: 0,
  batches: {},
  tasks: {},
  seenEventIds: new Set(),
  eventSequences: { batches: {}, tasks: {} },
};

const withCompletedBatch: HubRunDisplayState = {
  ...started,
  batches: {
    [batch1]: {
      batchId: batch1,
      selectedTaskIds: ["task-done"],
      taskTitles: { "task-done": "Completed earlier" },
      status: "done",
      stage: "Completed",
    },
    [batch2]: {
      batchId: batch2,
      selectedTaskIds: ["task-pty"],
      taskTitles: { "task-pty": "Verify real PTY cleanup" },
      status: "planning",
      stage: "Planning",
    },
  },
  tasks: {
    "task-done": {
      taskId: "task-done",
      batchId: batch1,
      status: "done",
      stage: "Completed",
    },
    "task-pty": {
      taskId: "task-pty",
      batchId: batch2,
      status: "implementing",
      stage: "Implementing",
    },
  },
};

const display = createHubRunLiveDisplay({
  terminal: {
    write: (chunk) => {
      process.stdout.write(chunk);
    },
  },
  clock: { now: () => 5_000 },
  startedAt: 2_000,
  columns: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
  color: Boolean(process.stdout.isTTY),
  enableSpinner: Boolean(process.stdout.isTTY),
});

display.update(started);
display.update({
  ...started,
  batches: {
    [batch1]: {
      batchId: batch1,
      selectedTaskIds: ["task-done"],
      status: "planning",
      stage: "Planning",
    },
  },
});
display.update({
  ...started,
  batches: {
    [batch1]: {
      batchId: batch1,
      selectedTaskIds: ["task-done"],
      status: "done",
      stage: "Completed",
    },
  },
  tasks: {
    "task-done": {
      taskId: "task-done",
      batchId: batch1,
      status: "done",
      stage: "Completed",
    },
  },
});
display.update(withCompletedBatch);

if (mode === "complete") {
  display.finalize(withCompletedBatch, {
    outcome: "completed",
    summary: "Run completed",
    counts: {
      completed: 1,
      failed: 0,
      blocked: 0,
      skipped: 0,
      readyToMerge: 0,
    },
    taskDetails: [],
    exitCode: 0,
  });
} else {
  process.stdin.setRawMode?.(true);
  process.stdout.write("\nPTY_SIGNAL_ARMED\n");
  process.prependOnceListener("SIGINT", () => {
    process.stdout.write("\nPTY_SIGNAL_HANDLED\n");
    display.dispose();
    process.exit(130);
  });
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
    setTimeout(() => process.kill(process.pid, "SIGINT"), 20);
  });
}
