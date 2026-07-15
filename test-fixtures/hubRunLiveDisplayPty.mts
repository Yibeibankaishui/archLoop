import type { HubRunDisplayState } from "../src/hubRunDisplay.ts";
import { createHubRunLiveDisplay } from "../src/hubRunLiveDisplay.ts";
import { setupTerminalCleanup } from "../src/terminalCleanup.ts";

const mode = process.argv[2];
if (mode !== "complete" && mode !== "signal") {
  throw new Error(`Unknown PTY fixture mode: ${mode ?? "missing"}`);
}

setupTerminalCleanup();
process.stdout.write(`PTY_READY tty=${String(process.stdout.isTTY)}\n`);

const state: HubRunDisplayState = {
  hubProjectName: "archloop",
  flowId: "no-review",
  runId: "run-pty",
  runDir: "/tmp/archloop/run-pty",
  status: "running",
  completedBatchCount: 0,
  completedTaskCount: 0,
  batches: {
    "batch-pty": {
      batchId: "batch-pty",
      selectedTaskIds: ["task-pty"],
      taskTitles: { "task-pty": "Verify real PTY cleanup" },
      status: "planning",
      stage: "Planning",
    },
  },
  tasks: {
    "task-pty": {
      taskId: "task-pty",
      batchId: "batch-pty",
      status: "implementing",
      stage: "Implementing",
    },
  },
  seenEventIds: new Set(),
  eventSequences: { batches: {}, tasks: {} },
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
  color: false,
});

display.update(state);

if (mode === "complete") {
  display.finalize(state, {
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
    process.exit(130);
  });
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
    setTimeout(() => process.kill(process.pid, "SIGINT"), 20);
  });
}
