import { describe, expect, it, vi } from "vitest";

import type { HubRunDisplayState } from "./hubRunDisplay.js";
import {
  createHubRunLiveDisplay,
  paintAltScreenFrame,
  paintScrollbackSummary,
  shouldUseAltScreenDashboard,
  type AltScreenAdapters,
} from "./hubRunLiveDisplay.js";
import { createPalette } from "./ansi.js";
import { isTerminalCursorHidden } from "./terminalCleanup.js";

const runningState = (): HubRunDisplayState => ({
  hubProjectName: "archloop",
  flowId: "with-review",
  runId: "run-74cc88e3-6757-4472-b152-f5cf151be9d3",
  runDir:
    "/repo/.archloop/hub/projects/archloop/runs/run-74cc88e3-6757-4472-b152-f5cf151be9d3",
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

// ---------------------------------------------------------------------------
// Fallback path (ADR-0032 append-only semantics — retained for --stream and
// non-TTY consumers)
// ---------------------------------------------------------------------------

describe("createHubRunLiveDisplay (fallback / append-only path)", () => {
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
    expect(display.emittedModels().length).toBeGreaterThan(
      sectionCountAfterStart,
    );
    expect(display.emittedModels().at(-1)?.kind).toBe("task.phase-changed");
    expect(chunks.join("")).not.toContain("\x1b[1A");
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

    expect(output).toContain("archloop tasks recover --stale");
    expect(output).not.toContain("--only-failed");
    expect(output).toContain("\x1b[?25h");
    expect(isTerminalCursorHidden()).toBe(false);
    expect(display.emittedModels().at(-1)?.kind).toBe("run.failed");
  });

  it("does not emit any alt-screen escape sequences on the fallback path", () => {
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
    expect(joined).not.toContain("\x1b[?1049h");
    expect(joined).not.toContain("\x1b[?1049l");
    expect(joined).not.toContain("\x1b[1A");
    display.dispose();
  });
});

// ---------------------------------------------------------------------------
// shouldUseAltScreenDashboard decision matrix
// ---------------------------------------------------------------------------

describe("shouldUseAltScreenDashboard", () => {
  const base = { isTTY: true, plain: false, stream: false, yes: false };

  it("returns true when a TTY has no disabling flags or env", () => {
    expect(shouldUseAltScreenDashboard({ ...base, env: {} })).toBe(true);
  });

  it("returns false when stdout is not a TTY", () => {
    expect(
      shouldUseAltScreenDashboard({ ...base, isTTY: false, env: {} }),
    ).toBe(false);
  });

  it("returns false for --plain", () => {
    expect(shouldUseAltScreenDashboard({ ...base, plain: true, env: {} })).toBe(
      false,
    );
  });

  it("returns false for --stream", () => {
    expect(
      shouldUseAltScreenDashboard({ ...base, stream: true, env: {} }),
    ).toBe(false);
  });

  it("returns false for --yes", () => {
    expect(shouldUseAltScreenDashboard({ ...base, yes: true, env: {} })).toBe(
      false,
    );
  });

  it("returns false for NO_COLOR=1", () => {
    expect(
      shouldUseAltScreenDashboard({ ...base, env: { NO_COLOR: "1" } }),
    ).toBe(false);
  });

  it("ignores empty NO_COLOR", () => {
    expect(
      shouldUseAltScreenDashboard({ ...base, env: { NO_COLOR: "" } }),
    ).toBe(true);
  });

  it("returns false for TERM=dumb", () => {
    expect(
      shouldUseAltScreenDashboard({ ...base, env: { TERM: "dumb" } }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alt-screen frame painter (pure function tests)
// ---------------------------------------------------------------------------

const buildLedgerEntry = (
  overrides: Partial<
    Parameters<typeof paintAltScreenFrame>[0]["ledger"][number]
  >,
) => ({
  kind: "task" as const,
  id: "task-x",
  title: "example task",
  outcome: "done" as const,
  durationMs: 60_000,
  atMs: 1_000,
  ...overrides,
});

describe("paintAltScreenFrame", () => {
  const paletteMono = createPalette(false);
  const state = runningState();

  it("writes a home+clear prefix and includes all four regions at 40x100", () => {
    const bytes = paintAltScreenFrame({
      state,
      ledger: [],
      nowMs: 65_000,
      runStartedAtMs: 5_000,
      rows: 40,
      columns: 100,
      palette: paletteMono,
      phaseStartedByTaskId: new Map(),
    });
    expect(bytes.startsWith("\x1b[H\x1b[2J")).toBe(true);
    expect(bytes).toContain("archLoop");
    expect(bytes).toContain("archloop");
    expect(bytes).toContain("with-review");
    expect(bytes).toContain("run 74cc88e3");
    expect(bytes).toContain("nothing shipped yet");
    expect(bytes).toContain("active");
    // active region names an active batch
    expect(bytes).toContain("batch fd3cdf79");
    // footer with hotkeys and logs
    expect(bytes).toContain("logs");
    expect(bytes).toContain("press");
    expect(bytes).toContain("quit");
  });

  it("renders 'running' outcome by default and 'done'/'failed' when specified", () => {
    const running = paintAltScreenFrame({
      state,
      ledger: [],
      nowMs: 65_000,
      runStartedAtMs: 5_000,
      rows: 30,
      columns: 100,
      palette: paletteMono,
      phaseStartedByTaskId: new Map(),
    });
    expect(running).toContain("running");

    const done = paintAltScreenFrame({
      state,
      ledger: [],
      nowMs: 65_000,
      runStartedAtMs: 5_000,
      rows: 30,
      columns: 100,
      palette: paletteMono,
      runOutcome: "done",
      phaseStartedByTaskId: new Map(),
    });
    expect(done).toContain("✓ done");

    const failed = paintAltScreenFrame({
      state,
      ledger: [],
      nowMs: 65_000,
      runStartedAtMs: 5_000,
      rows: 30,
      columns: 100,
      palette: paletteMono,
      runOutcome: "failed",
      phaseStartedByTaskId: new Map(),
    });
    expect(failed).toContain("✗ failed");
  });

  it("drops top rows and inserts the '… N earlier shipped' sentinel when the ledger overflows the row budget", () => {
    const ledger = Array.from({ length: 20 }, (_, i) =>
      buildLedgerEntry({ id: `task-${i}`, title: `title ${i}` }),
    );
    const bytes = paintAltScreenFrame({
      state,
      ledger,
      nowMs: 65_000,
      runStartedAtMs: 5_000,
      rows: 24,
      columns: 100,
      palette: paletteMono,
      phaseStartedByTaskId: new Map(),
    });
    expect(bytes).toMatch(/… \d+ earlier shipped, see run log/);
    // Header/active/footer never truncated
    expect(bytes).toContain("archLoop");
    expect(bytes).toContain("active");
    expect(bytes).toContain("logs");
  });

  it("does not truncate the ledger when everything fits", () => {
    const ledger = [
      buildLedgerEntry({ id: "task-1", title: "one" }),
      buildLedgerEntry({ id: "task-2", title: "two" }),
    ];
    const bytes = paintAltScreenFrame({
      state,
      ledger,
      nowMs: 65_000,
      runStartedAtMs: 5_000,
      rows: 60,
      columns: 120,
      palette: paletteMono,
      phaseStartedByTaskId: new Map(),
    });
    expect(bytes).not.toContain("earlier shipped");
    expect(bytes).toContain("task-1");
    expect(bytes).toContain("task-2");
  });
});

describe("paintScrollbackSummary", () => {
  const paletteMono = createPalette(false);
  it("dumps header + completed summary + ledger rows + logs path", () => {
    const state = runningState();
    const bytes = paintScrollbackSummary({
      state,
      ledger: [
        {
          kind: "task",
          id: "task-a",
          title: "task alpha",
          outcome: "done",
          durationMs: 30_000,
          atMs: 5_000,
        },
        {
          kind: "batch",
          id: "fd3cdf79",
          title: "1 task shipped",
          outcome: "done",
          durationMs: 40_000,
          atMs: 6_000,
        },
      ],
      nowMs: 65_000,
      runStartedAtMs: 5_000,
      rows: 40,
      columns: 100,
      palette: paletteMono,
      runOutcome: "done",
      phaseStartedByTaskId: new Map(),
    });
    expect(bytes).toContain("archLoop");
    expect(bytes).toContain("✓ done");
    expect(bytes).toContain("2 done");
    expect(bytes).toContain("task-a");
    expect(bytes).toContain("fd3cdf79");
    expect(bytes).toContain("logs");
    // No alt-screen leave sequence — cli.ts already left alt-screen when
    // it dumps this string.
    expect(bytes).not.toContain("\x1b[?1049");
  });
});

// ---------------------------------------------------------------------------
// Alt-screen orchestrator (integration — injected timers/stdin/exit)
// ---------------------------------------------------------------------------

interface HarnessAdapters {
  readonly adapters: AltScreenAdapters;
  readonly out: { value: string };
  readonly setSize: (rows: number, columns: number) => void;
  readonly fireSignal: (signal: "SIGINT" | "SIGTERM") => void;
  readonly pushStdin: (data: string) => void;
  readonly exitCalls: number[];
  readonly ticks: () => void;
  readonly advance: (ms: number) => void;
  readonly stdin: {
    isTTY: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    on: (event: string, handler: (chunk: string) => void) => void;
    off: (event: string, handler: (chunk: string) => void) => void;
    setEncoding: ReturnType<typeof vi.fn>;
  };
}

const createHarness = (
  size: { rows: number; columns: number } = { rows: 40, columns: 100 },
): HarnessAdapters => {
  const out = { value: "" };
  let currentSize = size;
  const dataHandlers: ((chunk: string) => void)[] = [];
  const stdin = {
    isTTY: true as const,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    setEncoding: vi.fn(),
    on: (event: string, handler: (chunk: string) => void) => {
      if (event === "data") dataHandlers.push(handler);
    },
    off: (event: string, handler: (chunk: string) => void) => {
      if (event === "data") {
        const idx = dataHandlers.indexOf(handler);
        if (idx >= 0) dataHandlers.splice(idx, 1);
      }
    },
  };

  const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  const exitCalls: number[] = [];
  let pendingTicker: (() => void) | undefined;
  const pendingTimeouts: { fn: () => void; ms: number; at: number }[] = [];
  let clock = 0;

  const adapters: AltScreenAdapters = {
    stdin: stdin as unknown as NodeJS.ReadStream,
    readTerminalSize: () => currentSize,
    onSignal: (signal, handler) => {
      signalHandlers.set(signal, handler);
    },
    setInterval: (fn) => {
      pendingTicker = fn;
      return {} as NodeJS.Timeout;
    },
    clearInterval: () => {
      pendingTicker = undefined;
    },
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, at: clock + ms };
      pendingTimeouts.push(handle);
      return handle as unknown as NodeJS.Timeout;
    },
    clearTimeout: (handle) => {
      const idx = pendingTimeouts.indexOf(
        handle as unknown as { fn: () => void; ms: number; at: number },
      );
      if (idx >= 0) pendingTimeouts.splice(idx, 1);
    },
    exitProcess: (code) => {
      exitCalls.push(code);
    },
    registerProcessExit: () => {
      // no-op in tests
    },
  };

  return {
    adapters,
    out,
    setSize: (rows, columns) => {
      currentSize = { rows, columns };
    },
    fireSignal: (signal) => {
      const handler = signalHandlers.get(signal);
      if (handler) handler();
    },
    pushStdin: (data) => {
      for (const h of dataHandlers) h(data);
    },
    exitCalls,
    ticks: () => {
      if (pendingTicker) pendingTicker();
    },
    advance: (ms) => {
      clock += ms;
      const fired = pendingTimeouts.filter((t) => t.at <= clock);
      for (const t of fired) {
        const idx = pendingTimeouts.indexOf(t);
        if (idx >= 0) pendingTimeouts.splice(idx, 1);
        t.fn();
      }
    },
    stdin,
  };
};

describe("createHubRunLiveDisplay (alt-screen dashboard)", () => {
  it("enters alt-screen, hides cursor, paints frames, and exposes ledger from state transitions", () => {
    const harness = createHarness();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (harness.out.value += chunk) },
      clock: { now: () => 10_000 },
      startedAt: 5_000,
      columns: 100,
      rows: 40,
      color: false,
      mode: "alt-screen",
      altScreen: harness.adapters,
    });

    // Arm on first update
    display.update(runningState());
    expect(harness.out.value).toContain("\x1b[?1049h");
    expect(harness.out.value).toContain("\x1b[?25l");
    expect(harness.out.value).toContain("\x1b[H\x1b[2J");
    expect(harness.out.value).toContain("archLoop");
    expect(harness.out.value).toContain("batch fd3cdf79");
    expect(harness.out.value).toContain("running");

    // Complete a task and a batch
    const completed: HubRunDisplayState = {
      ...runningState(),
      batches: {
        "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b": {
          ...runningState().batches[
            "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b"
          ]!,
          status: "done",
          stage: "Completed",
        },
      },
      tasks: {
        "task-a": {
          ...runningState().tasks["task-a"]!,
          status: "done",
          stage: "Completed",
        },
        "task-b": {
          ...runningState().tasks["task-b"]!,
          status: "done",
          stage: "Completed",
        },
      },
    };
    display.update(completed);
    const ledger = display.ledger?.() ?? [];
    expect(ledger.map((l) => l.kind)).toEqual(["task", "task", "batch"]);
    expect(ledger.filter((l) => l.outcome === "done")).toHaveLength(3);

    display.dispose();
    // Cleanup emits SHOW_CURSOR + alt-leave in one write.
    expect(harness.out.value).toContain("\x1b[?25h");
    expect(harness.out.value).toContain("\x1b[?1049l");
  });

  it("records a pending host-contribution batch as pending, not shipped or failed", () => {
    const harness = createHarness();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (harness.out.value += chunk) },
      clock: { now: () => 10_000 },
      startedAt: 5_000,
      columns: 100,
      rows: 40,
      color: false,
      mode: "alt-screen",
      altScreen: harness.adapters,
    });

    const base = runningState();
    display.update(base);
    display.update({
      ...base,
      batches: {
        "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b": {
          ...base.batches["batch-fd3cdf79-1786-4647-8899-d5f80fd8255b"]!,
          selectedTaskIds: ["task-a"],
          status: "pending",
          stage: "Pending",
        },
      },
      tasks: {
        "task-a": {
          ...base.tasks["task-a"]!,
          status: "waiting_for_merge",
          stage: "Waiting for merge",
        },
      },
    });

    const ledger = display.ledger?.() ?? [];
    expect(ledger).toEqual([
      expect.objectContaining({
        kind: "batch",
        title: "1 task pending",
        outcome: "pending",
      }),
    ]);
    expect(JSON.stringify(ledger)).not.toMatch(/shipped|failed/);
    display.dispose();
  });

  it("cleans up on q keypress and dumps a scrollback summary", () => {
    const harness = createHarness();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (harness.out.value += chunk) },
      clock: { now: () => 10_000 },
      startedAt: 5_000,
      columns: 100,
      rows: 40,
      color: false,
      mode: "alt-screen",
      altScreen: harness.adapters,
    });
    display.update(runningState());
    harness.out.value = ""; // reset to only capture the cleanup output

    harness.pushStdin("q");

    expect(harness.exitCalls).toEqual([0]);
    // Leave sequence written, then summary text follows.
    expect(harness.out.value).toContain("\x1b[?1049l");
    const leaveIdx = harness.out.value.indexOf("\x1b[?1049l");
    const summaryIdx = harness.out.value.indexOf("archLoop", leaveIdx);
    expect(summaryIdx).toBeGreaterThan(leaveIdx);
    display.dispose();
  });

  it("cleans up on Ctrl+C via stdin and exits 130", () => {
    const harness = createHarness();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (harness.out.value += chunk) },
      clock: { now: () => 10_000 },
      startedAt: 5_000,
      columns: 100,
      rows: 40,
      color: false,
      mode: "alt-screen",
      altScreen: harness.adapters,
    });
    display.update(runningState());
    harness.pushStdin("\x03");
    expect(harness.exitCalls).toEqual([130]);
    display.dispose();
  });

  it("cleans up on SIGINT and exits 130", () => {
    const harness = createHarness();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (harness.out.value += chunk) },
      clock: { now: () => 10_000 },
      startedAt: 5_000,
      columns: 100,
      rows: 40,
      color: false,
      mode: "alt-screen",
      altScreen: harness.adapters,
    });
    display.update(runningState());
    harness.out.value = "";
    harness.fireSignal("SIGINT");
    expect(harness.exitCalls).toEqual([130]);
    expect(harness.out.value).toContain("\x1b[?1049l");
  });

  it("cleans up on SIGTERM and exits 143", () => {
    const harness = createHarness();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (harness.out.value += chunk) },
      clock: { now: () => 10_000 },
      startedAt: 5_000,
      columns: 100,
      rows: 40,
      color: false,
      mode: "alt-screen",
      altScreen: harness.adapters,
    });
    display.update(runningState());
    harness.fireSignal("SIGTERM");
    expect(harness.exitCalls).toEqual([143]);
    display.dispose();
  });

  it("dumps a scrollback summary synchronously on natural completion (cli.ts owns process exit)", () => {
    const harness = createHarness();
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (harness.out.value += chunk) },
      clock: { now: () => 10_000 },
      startedAt: 5_000,
      columns: 100,
      rows: 40,
      color: false,
      mode: "alt-screen",
      altScreen: harness.adapters,
    });
    display.update(runningState());
    display.finalize(runningState(), {
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
    // Finalize does the whole cleanup dance inline — cli.ts owns exit code.
    expect(harness.exitCalls).toEqual([]);
    expect(harness.out.value).toContain("\x1b[?1049l");
    // Scrollback dump lands AFTER the leave sequence.
    const leaveIdx = harness.out.value.indexOf("\x1b[?1049l");
    const summaryIdx = harness.out.value.indexOf("archLoop", leaveIdx);
    expect(summaryIdx).toBeGreaterThan(leaveIdx);
    expect(harness.out.value).toContain("Run completed");
  });

  it("re-reads terminal size on every frame so resize takes effect immediately", () => {
    const harness = createHarness({ rows: 40, columns: 100 });
    let now = 10_000;
    const display = createHubRunLiveDisplay({
      terminal: { write: (chunk) => (harness.out.value += chunk) },
      clock: { now: () => now },
      startedAt: 5_000,
      columns: 100,
      rows: 40,
      color: false,
      mode: "alt-screen",
      altScreen: harness.adapters,
    });
    display.update(runningState());
    harness.out.value = "";
    harness.setSize(24, 80);
    now = 10_500;
    harness.ticks();
    // 80-col frames still contain the header text
    expect(harness.out.value).toContain("archLoop");
    display.dispose();
  });
});
