// Hub run live display (ADR-0033).
//
// Two rendering paths share the same public interface:
//
//   1. Alt-screen dashboard (TTY + color enabled, no --stream/--plain/--yes):
//      enter `\e[?1049h`, hide cursor, run a 500 ms setInterval ticker that
//      repaints a four-region dashboard (header + done ledger + live active
//      card + footer). On exit — q / SIGINT / SIGTERM / natural completion —
//      leave alt-screen, restore cursor, and dump a plain-text scrollback
//      summary (header + `completed · N done · M failed` + every on-screen
//      ledger row + logs path) to the real terminal.
//
//   2. Append-only fallback (non-TTY / --plain / NO_COLOR / --yes / --stream
//      / TERM=dumb): one line per transition via the existing
//      `renderRunCardSectionText` machinery from hubRunCard.ts. No alt-screen
//      escapes are ever written on this path.
//
// The `HubRunDisplayState` state model is unchanged. The done ledger is built
// inside this module from the transition detector, so no state-model change
// is required.

import * as clack from "@clack/prompts";

import {
  alignLeftRight,
  createPalette,
  truncateTail,
  visibleLength,
  type Palette,
} from "./ansi.js";
import type {
  HubRunDisplayState,
  HubRunOutcomeProjection,
} from "./hubRunDisplay.js";
import {
  isTerminalHubRunBatchStatus,
  projectHubRunStateOutcome,
} from "./hubRunDisplay.js";
import {
  buildRunCardSectionModel,
  detectRunCardTransition,
  formatClockElapsed,
  refreshRunCardSpinnerText,
  renderRunCardSectionText,
  resolveRunFailureFixCommand,
  shortHubId,
  type RunCardSectionModel,
  type RunCardTransitionKind,
} from "./hubRunCard.js";
import { SHOW_CURSOR, setTerminalCursorHidden } from "./terminalCleanup.js";

// -----------------------------------------------------------------------------
// Public interface
// -----------------------------------------------------------------------------

export interface HubRunLiveTerminal {
  readonly write: (chunk: string) => void;
}

export interface HubRunLiveClock {
  readonly now: () => number;
}

export interface HubRunLiveSpinner {
  start(msg?: string): void;
  stop(msg?: string): void;
  message(msg?: string): void;
}

export type HubRunLiveDisplayMode = "alt-screen" | "fallback";

export interface HubRunLiveDisplayOptions {
  readonly terminal: HubRunLiveTerminal;
  readonly clock: HubRunLiveClock;
  readonly startedAt: number;
  readonly columns: number;
  readonly rows?: number;
  readonly color: boolean;
  /** Fallback path only — skip clack spinner in tests / plain output. */
  readonly enableSpinner?: boolean;
  readonly createSpinner?: () => HubRunLiveSpinner;
  /** Default: "fallback" (preserves the append-only contract for cli.ts + existing tests). */
  readonly mode?: HubRunLiveDisplayMode;
  /**
   * Alt-screen path only — injected process-level side effects so tests can
   * observe the dashboard without hijacking stdin/timers/process.exit.
   */
  readonly altScreen?: AltScreenAdapters;
}

export interface AltScreenAdapters {
  /** stdin used for raw-mode keypress capture. Defaults to `process.stdin`. */
  readonly stdin?: NodeJS.ReadStream;
  /** Reads current terminal size on every frame. Defaults to `process.stdout.rows/columns`. */
  readonly readTerminalSize?: () => { rows: number; columns: number };
  /** Signal registrar. Defaults to `process.once`. */
  readonly onSignal?: (
    signal: "SIGINT" | "SIGTERM",
    handler: () => void,
  ) => void;
  /** Ticker install/uninstall. Defaults to `setInterval` / `clearInterval`. */
  readonly setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearInterval?: (handle: NodeJS.Timeout) => void;
  readonly setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void;
  /**
   * Called with the intended exit code after natural completion / q / SIGINT.
   * Defaults to `process.exit`. Tests inject a no-op so vitest survives.
   */
  readonly exitProcess?: (code: number) => void;
  /**
   * Registered belt-and-suspenders on `process.once("exit")` so a hard
   * disconnect still leaves alt-screen + shows the cursor.
   */
  readonly registerProcessExit?: (handler: () => void) => void;
}

export interface HubRunLiveDisplay {
  readonly update: (state: HubRunDisplayState) => boolean;
  readonly refresh: () => boolean;
  readonly resize: (columns: number, rows?: number) => boolean;
  readonly finalize: (
    state: HubRunDisplayState,
    outcome: HubRunOutcomeProjection,
  ) => void;
  readonly cancel: (state: HubRunDisplayState) => void;
  readonly dispose: () => void;
  /** Test / inspection helper — models appended so far (fallback path only). */
  readonly emittedModels: () => readonly RunCardSectionModel[];
  /**
   * Alt-screen only: returns the byte sequence that WOULD be written on the
   * next paint. Handy for frame-painter tests that don't want to spin an
   * actual interval.
   */
  readonly paintFrame?: () => string;
  /** Alt-screen only: current ledger contents (test/debug). */
  readonly ledger?: () => readonly LedgerEntry[];
}

// -----------------------------------------------------------------------------
// shouldUseAltScreenDashboard — the sole decision helper (issue #223)
// -----------------------------------------------------------------------------

export interface ShouldUseAltScreenDashboardInput {
  readonly isTTY?: boolean;
  readonly plain?: boolean;
  readonly stream?: boolean;
  readonly yes?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Return `true` when the CLI should enter the alt-screen dashboard for a
 * Hub run. `false` means take the append-only fallback path
 * (`renderRunCardSectionText` + `Display.section`).
 */
export const shouldUseAltScreenDashboard = (
  input: ShouldUseAltScreenDashboardInput,
): boolean => {
  if (!input.isTTY) {
    return false;
  }
  if (input.plain === true) {
    return false;
  }
  if (input.stream === true) {
    return false;
  }
  if (input.yes === true) {
    return false;
  }
  const env = input.env ?? {};
  if (
    Object.prototype.hasOwnProperty.call(env, "NO_COLOR") &&
    env.NO_COLOR !== undefined &&
    env.NO_COLOR !== ""
  ) {
    return false;
  }
  if (env.TERM?.trim().toLowerCase() === "dumb") {
    return false;
  }
  return true;
};

// -----------------------------------------------------------------------------
// Alt-screen sequences
// -----------------------------------------------------------------------------

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const CURSOR_HOME_CLEAR = "\x1b[H\x1b[2J";
const CTRL_C = "\x03";
const MARGIN = "  ";

// -----------------------------------------------------------------------------
// Ledger model (built inside the renderer from state transitions)
// -----------------------------------------------------------------------------

export interface LedgerEntry {
  readonly kind: "task" | "batch";
  readonly id: string;
  readonly title: string;
  readonly outcome: "done" | "failed" | "pending";
  readonly durationMs: number;
  readonly atMs: number;
}

const taskCountLabel = (count: number, noun: "shipped" | "pending"): string =>
  `${count} task${count === 1 ? "" : "s"} ${noun}`;

const countShippedBatchTasks = (
  batch: HubRunDisplayState["batches"][string],
  state: HubRunDisplayState,
): number =>
  batch.selectedTaskIds.filter(
    (taskId) => state.tasks[taskId]?.status === "done",
  ).length;

const countPendingBatchTasks = (
  batch: HubRunDisplayState["batches"][string],
  state: HubRunDisplayState,
): number =>
  batch.selectedTaskIds.filter((taskId) => {
    const task = state.tasks[taskId];
    return (
      task !== undefined &&
      task.status !== "done" &&
      task.status !== "failed" &&
      !task.skipped
    );
  }).length;

const resolveBatchLedgerTitle = (input: {
  readonly batch: HubRunDisplayState["batches"][string];
  readonly shippedCount: number;
  readonly pendingCount: number;
}): string => {
  const { batch, shippedCount, pendingCount } = input;
  const showPending =
    batch.status === "pending" || (shippedCount === 0 && pendingCount > 0);
  if (showPending) {
    return taskCountLabel(
      pendingCount || batch.selectedTaskIds.length,
      "pending",
    );
  }
  return taskCountLabel(shippedCount, "shipped");
};

const resolveBatchLedgerOutcome = (input: {
  readonly batchStatus: HubRunDisplayState["batches"][string]["status"];
  readonly shippedCount: number;
}): LedgerEntry["outcome"] => {
  switch (input.batchStatus) {
    case "done":
      return "done";
    case "pending":
      return "pending";
    case "partial_failed":
      return input.shippedCount > 0 ? "failed" : "pending";
    default:
      // planning/merging are filtered out before ledger ingest
      return "pending";
  }
};

const cancellationOutcome = (
  state: HubRunDisplayState,
): HubRunOutcomeProjection =>
  projectHubRunStateOutcome(state, {
    outcome: "cancelled",
    summary: "Run cancelled",
    exitCode: 130,
  });

const findActiveTaskId = (state: HubRunDisplayState): string | undefined => {
  const activeBatch = Object.values(state.batches).find(
    (batch) => !isTerminalHubRunBatchStatus(batch.status),
  );
  if (!activeBatch) {
    return undefined;
  }
  const fromSelection = activeBatch.selectedTaskIds
    .map((taskId) => state.tasks[taskId])
    .find(
      (task) =>
        task &&
        task.status !== "done" &&
        task.status !== "failed" &&
        !task.skipped,
    );
  return fromSelection?.taskId;
};

// -----------------------------------------------------------------------------
// Phase / label helpers (shared by both paths)
// -----------------------------------------------------------------------------

const phaseKey = (statusOrStage: string): string => {
  const normalized = statusOrStage.trim().toLowerCase().replace(/\s+/g, "_");
  switch (normalized) {
    case "planning":
      return "planning";
    case "implementing":
    case "implementation":
      return "implementing";
    case "reviewing":
    case "review":
      return "reviewing";
    case "merging":
    case "waiting_for_merge":
      return "merging";
    default:
      return normalized || "running";
  }
};

const taskTitleFor = (state: HubRunDisplayState, taskId: string): string => {
  const task = state.tasks[taskId];
  const batch = task ? state.batches[task.batchId] : undefined;
  return batch?.taskTitles?.[taskId] ?? task?.stage ?? taskId;
};

// -----------------------------------------------------------------------------
// Alt-screen frame painter (pure)
// -----------------------------------------------------------------------------

export interface AltScreenFrameInput {
  readonly state: HubRunDisplayState;
  readonly ledger: readonly LedgerEntry[];
  readonly nowMs: number;
  readonly runStartedAtMs: number;
  readonly rows: number;
  readonly columns: number;
  readonly palette: Palette;
  readonly runOutcome?: "done" | "failed" | "cancelled";
  /** Optional outcome summary line (e.g. "Nothing to run", "Run completed"). */
  readonly outcomeSummary?: string;
  /** Phase-elapsed start reference per taskId — for the "N s in this step" sub-line. */
  readonly phaseStartedByTaskId: ReadonlyMap<string, number>;
}

const renderHeaderLine = (
  input: AltScreenFrameInput,
  outcome: "running" | "done" | "failed" | "cancelled",
): string => {
  const { palette, columns, state, runStartedAtMs, nowMs } = input;
  const elapsed = formatClockElapsed(nowMs - runStartedAtMs);
  const short = state.runId ? shortHubId(state.runId) : "……";
  const status =
    outcome === "done"
      ? palette.green("✓ done")
      : outcome === "failed"
        ? palette.red("✗ failed")
        : outcome === "cancelled"
          ? palette.yellow("! cancelled")
          : palette.bold("running");
  // Match section.ts's header convention (ADR-0030) so cross-region searches
  // for "<project> · <flow>" continue to work: subtitle is a single cyan
  // group containing both project name and flow id.
  const subtitle = palette.cyan(`${state.hubProjectName} · ${state.flowId}`);
  const left = `${palette.bold("archLoop")} ${palette.dim("·")} ${subtitle}`;
  const right = `${palette.dim("run")} ${palette.cyan(short)} ${palette.dim("·")} ${status} ${palette.dim("·")} ${elapsed}`;
  return MARGIN + alignLeftRight(left, right, columns - MARGIN.length);
};

const ledgerOutcomeGlyph = (outcome: LedgerEntry["outcome"]): string => {
  switch (outcome) {
    case "failed":
      return "✗";
    case "pending":
      return "◐";
    case "done":
      return "✓";
  }
};

const ledgerOutcomeColor = (
  outcome: LedgerEntry["outcome"],
  palette: Palette,
): ((text: string) => string) => {
  switch (outcome) {
    case "failed":
      return palette.red;
    case "pending":
      return palette.yellow;
    case "done":
      return palette.green;
  }
};

const ledgerRowLine = (
  entry: LedgerEntry,
  palette: Palette,
  columns: number,
): string => {
  const sym = ledgerOutcomeColor(entry.outcome, palette)(
    ledgerOutcomeGlyph(entry.outcome),
  );
  const kindTag = entry.kind === "batch" ? palette.dim("batch ") : "";
  const idCol = palette.cyan(entry.id);
  const dur = palette.dim(formatClockElapsed(entry.durationMs));
  const budget = Math.max(
    10,
    columns -
      MARGIN.length -
      visibleLength(`  ${sym}  ${kindTag}`) -
      visibleLength(idCol) -
      3 -
      visibleLength(dur) -
      2,
  );
  const title = truncateTail(entry.title, budget);
  const left = `  ${sym}  ${kindTag}${idCol}   ${title}`;
  return MARGIN + alignLeftRight(left, dur, columns - MARGIN.length);
};

const renderLedgerRegion = (
  input: AltScreenFrameInput,
  budget: number,
): readonly string[] => {
  const { ledger, palette, columns } = input;
  const doneCount = ledger.filter((e) => e.outcome !== "failed").length;
  const failedCount = ledger.filter((e) => e.outcome === "failed").length;
  const parts: string[] = [];
  if (doneCount) {
    parts.push(palette.green(`${doneCount} done`));
  }
  if (failedCount) {
    parts.push(palette.red(`${failedCount} failed`));
  }
  if (parts.length === 0) {
    parts.push(palette.dim("nothing shipped yet"));
  }
  const headerLine =
    MARGIN +
    `${palette.dim("completed")}   ${palette.dim("·")}   ${parts.join(palette.dim(" · "))}`;

  const bodyBudget = Math.max(0, budget - 1);
  const rows = ledger.map((entry) => ledgerRowLine(entry, palette, columns));
  if (rows.length <= bodyBudget) {
    return [headerLine, ...rows];
  }
  const hiddenAbove = rows.length - bodyBudget + 1;
  return [
    headerLine,
    MARGIN +
      "    " +
      palette.dim(`… ${hiddenAbove} earlier shipped, see run log`),
    ...rows.slice(rows.length - (bodyBudget - 1)),
  ];
};

const renderActiveRegion = (input: AltScreenFrameInput): readonly string[] => {
  const { state, palette, columns, nowMs, phaseStartedByTaskId } = input;
  const activeBatches = Object.values(state.batches).filter(
    (batch) => !isTerminalHubRunBatchStatus(batch.status),
  );
  const activeTasks = Object.values(state.tasks).filter(
    (task) =>
      task.status !== "done" && task.status !== "failed" && !task.skipped,
  );
  const lines: string[] = [];
  const bCount = activeBatches.length;
  const tCount = activeTasks.length;
  const headerLine =
    MARGIN +
    `${palette.dim("active")}   ${palette.dim("·")}   ${bCount} batch${bCount === 1 ? "" : "es"} ${palette.dim("·")} ${tCount} task${tCount === 1 ? "" : "s"}`;
  lines.push(headerLine);

  if (bCount === 0 && tCount === 0) {
    lines.push(MARGIN + "    " + palette.dim("(nothing active)"));
    return lines;
  }

  for (const batch of activeBatches) {
    const shortId = shortHubId(batch.batchId);
    let impl = 0;
    let plan = 0;
    let merge = 0;
    for (const taskId of batch.selectedTaskIds) {
      const task = state.tasks[taskId];
      if (!task || task.status === "done" || task.status === "failed") {
        continue;
      }
      const key = phaseKey(task.status);
      if (key === "implementing" || key === "reviewing") {
        impl += 1;
      } else if (key === "merging") {
        merge += 1;
      } else if (key === "planning") {
        plan += 1;
      }
    }
    const bits: string[] = [];
    if (impl) bits.push(`${impl} impl`);
    if (merge) bits.push(`${merge} merging`);
    if (plan) bits.push(`${plan} planning`);
    const trailing = bits.length
      ? bits.map((b) => palette.dim(b)).join(palette.dim(" · "))
      : palette.dim(phaseKey(batch.status));
    const total = batch.selectedTaskIds.length;
    const left = `  ${palette.yellow("◐")}  batch ${palette.cyan(shortId)}   ${total} task${total === 1 ? "" : "s"}`;
    lines.push(
      MARGIN + alignLeftRight(left, trailing, columns - MARGIN.length),
    );
  }

  const indent = MARGIN + "    ";
  const titleStart = visibleLength(indent) + 3;
  const titleW = Math.max(20, columns - titleStart);
  for (const task of activeTasks) {
    const title = taskTitleFor(state, task.taskId);
    const wrapped = wrapWords(title, titleW);
    const arrow = palette.cyan("↳");
    lines.push(
      `${indent}${arrow}  ${palette.cyan(task.taskId)}   ${wrapped[0]!}`,
    );
    for (let i = 1; i < wrapped.length; i++) {
      lines.push(" ".repeat(titleStart) + wrapped[i]!);
    }
    const phase = phaseKey(task.status);
    const phaseColor =
      phase === "implementing"
        ? palette.yellow
        : phase === "merging"
          ? palette.cyan
          : palette.dim;
    const phaseStartMs =
      phaseStartedByTaskId.get(task.taskId) ?? input.runStartedAtMs;
    const phaseElapsed = formatClockElapsed(nowMs - phaseStartMs);
    lines.push(
      " ".repeat(titleStart) +
        `${phaseColor(phase)} ${palette.dim("·")} ${palette.dim(phaseElapsed + " in this step")}`,
    );
  }
  return lines;
};

const renderFooterLine = (input: AltScreenFrameInput): string => {
  const { palette, columns, state } = input;
  const short = state.runId ? shortHubId(state.runId) : "pending";
  const logsPath = `…/runs/run-${short}/`;
  const left = `${palette.dim("logs")}   ${palette.dim(logsPath)}`;
  const right = `${palette.dim("press")} ${palette.bold("o")} ${palette.dim("open ·")} ${palette.bold("l")} ${palette.dim("tail ·")} ${palette.bold("q")} ${palette.dim("quit")}`;
  return MARGIN + alignLeftRight(left, right, columns - MARGIN.length);
};

const wrapWords = (text: string, width: number): readonly string[] => {
  const toks = String(text).split(/(\s+)/);
  const out: string[] = [];
  let cur = "";
  let vl = 0;
  for (const t of toks) {
    const v = visibleLength(t);
    if (vl + v <= width) {
      cur += t;
      vl += v;
    } else {
      if (cur.trim()) out.push(cur.replace(/\s+$/, ""));
      if (/^\s+$/.test(t)) {
        cur = "";
        vl = 0;
      } else {
        cur = t;
        vl = v;
      }
    }
  }
  if (cur.length > 0) out.push(cur);
  return out.length > 0 ? out : [""];
};

/**
 * Paint one dashboard frame. Returns the exact byte sequence that would be
 * written to the terminal (starting with `\x1b[H\x1b[2J`).
 */
export const paintAltScreenFrame = (input: AltScreenFrameInput): string => {
  const outcome: "running" | "done" | "failed" | "cancelled" =
    input.runOutcome ?? "running";
  const header = renderHeaderLine(input, outcome);
  const footer = renderFooterLine(input);
  const live = renderActiveRegion(input);
  // spacing: leading blank + header + blank + ledger + blank + live + blank + footer + trailing blank
  const spacing =
    1 /* top blank */ +
    1 /* header row */ +
    1 /* blank after header */ +
    1 /* blank after ledger */ +
    1 /* blank before footer */ +
    1; /* footer row */
  const ledgerBudget = Math.max(3, input.rows - spacing - live.length);
  const ledger = renderLedgerRegion(input, ledgerBudget);

  const buf: string[] = [CURSOR_HOME_CLEAR, "\n", header, "\n", "\n"];
  for (const l of ledger) buf.push(l + "\n");
  buf.push("\n");
  for (const l of live) buf.push(l + "\n");
  buf.push("\n");
  buf.push(footer + "\n");
  return buf.join("");
};

/** Plain-text summary dumped to real scrollback after leaving alt-screen. */
export const paintScrollbackSummary = (input: AltScreenFrameInput): string => {
  const outcome: "running" | "done" | "failed" | "cancelled" =
    input.runOutcome ?? "running";
  const header = renderHeaderLine(input, outcome);
  const doneCount = input.ledger.filter((e) => e.outcome !== "failed").length;
  const failedCount = input.ledger.filter((e) => e.outcome === "failed").length;
  const parts: string[] = [];
  if (doneCount) parts.push(input.palette.green(`${doneCount} done`));
  if (failedCount) parts.push(input.palette.red(`${failedCount} failed`));
  if (parts.length === 0) parts.push(input.palette.dim("nothing shipped"));
  const summaryLine =
    MARGIN +
    `${input.palette.dim("completed")}   ${input.palette.dim("·")}   ${parts.join(input.palette.dim(" · "))}`;

  const outcomeLine =
    outcome === "cancelled"
      ? MARGIN + input.palette.yellow("! Run cancelled")
      : outcome === "failed"
        ? MARGIN + input.palette.red("✗ Run failed")
        : outcome === "done"
          ? MARGIN +
            input.palette.green(
              input.outcomeSummary && input.outcomeSummary !== "Run completed"
                ? `✓ ${input.outcomeSummary}`
                : "✓ Run completed",
            )
          : undefined;

  // Fit all ledger rows that would be on-screen at exit time. We reuse the
  // paint budget so scrollback output matches what the user last saw.
  const spacing = 6;
  const live = renderActiveRegion(input);
  const ledgerBudget = Math.max(3, input.rows - spacing - live.length);
  const ledgerLines = renderLedgerRegion(input, ledgerBudget).slice(1); // drop header (we already emitted our own summary line)
  const logsPath = input.state.runId
    ? `…/runs/run-${shortHubId(input.state.runId)}/`
    : "…/runs/run-pending/";

  // Failure diagnostics + recovery command — parity with the fallback path's
  // `run.failed` footer, so CI logs and users pressing q at a failure still
  // see the actionable next step.
  const failedTasks = Object.values(input.state.tasks).filter(
    (task) => task.status === "failed" && task.detail,
  );
  const diagnosticLines: string[] = [];
  for (const task of failedTasks) {
    if (!task.detail) continue;
    diagnosticLines.push(
      MARGIN +
        `${input.palette.red("✗")} ${input.palette.cyan(task.taskId)}   ${input.palette.dim(task.detail.stage)}`,
    );
    diagnosticLines.push(MARGIN + `    ${task.detail.diagnostic}`);
    if (task.detail.recoveryCommand) {
      diagnosticLines.push(
        MARGIN + `    ${input.palette.dim(task.detail.recoveryCommand)}`,
      );
    }
  }
  const fixFooter =
    outcome === "failed" && input.state.runId
      ? MARGIN +
        `${input.palette.dim("fix")}   ${resolveRunFailureFixCommand(input.state)}`
      : undefined;

  const lines = [
    header,
    "",
    summaryLine,
    ...(outcomeLine ? [outcomeLine] : []),
    ...ledgerLines,
    ...(diagnosticLines.length > 0 ? ["", ...diagnosticLines] : []),
    "",
    MARGIN + `${input.palette.dim("logs")}   ${input.palette.dim(logsPath)}`,
    ...(fixFooter ? [fixFooter] : []),
  ];
  return lines.join("\n") + "\n";
};

// -----------------------------------------------------------------------------
// Alt-screen orchestrator
// -----------------------------------------------------------------------------

interface AltScreenState {
  readonly ledger: LedgerEntry[];
  readonly phaseStartedByTaskId: Map<string, number>;
  readonly batchStartedAt: Map<string, number>;
  readonly recordedTasks: Set<string>;
  readonly recordedBatches: Set<string>;
  latestState: HubRunDisplayState | undefined;
  runOutcome: "done" | "failed" | "cancelled" | undefined;
  outcomeSummary: string | undefined;
  ticker: NodeJS.Timeout | undefined;
  holdTimer: NodeJS.Timeout | undefined;
  cleanedUp: boolean;
  finalized: boolean;
  raw: boolean;
}

const createAltScreenPath = (
  options: HubRunLiveDisplayOptions,
): HubRunLiveDisplay => {
  const palette = createPalette(options.color);
  const adapters = options.altScreen ?? {};
  const stdin = adapters.stdin ?? process.stdin;
  const readSize =
    adapters.readTerminalSize ??
    (() => ({
      rows: process.stdout.rows ?? 30,
      columns: process.stdout.columns ?? 100,
    }));
  const registerSignal =
    adapters.onSignal ??
    ((signal, handler) => {
      process.once(signal, handler);
    });
  const registerExit =
    adapters.registerProcessExit ??
    ((handler) => {
      process.once("exit", handler);
    });
  const setIntervalFn = adapters.setInterval ?? setInterval;
  const clearIntervalFn = adapters.clearInterval ?? clearInterval;
  const setTimeoutFn = adapters.setTimeout ?? setTimeout;
  const clearTimeoutFn = adapters.clearTimeout ?? clearTimeout;
  const exitProcess =
    adapters.exitProcess ??
    ((code: number) => {
      process.exit(code);
    });

  const st: AltScreenState = {
    ledger: [],
    phaseStartedByTaskId: new Map(),
    batchStartedAt: new Map(),
    recordedTasks: new Set(),
    recordedBatches: new Set(),
    latestState: undefined,
    runOutcome: undefined,
    outcomeSummary: undefined,
    ticker: undefined,
    holdTimer: undefined,
    cleanedUp: false,
    finalized: false,
    raw: false,
  };

  const belt = (): void => {
    // Unconditional restore for SIGHUP / hard-disconnect paths.
    try {
      options.terminal.write(SHOW_CURSOR + ALT_LEAVE);
    } catch {
      // ignore — nothing more we can do
    }
    setTerminalCursorHidden(false);
  };
  registerExit(belt);

  const buildFrameInput = (now: number): AltScreenFrameInput | undefined => {
    if (!st.latestState) {
      return undefined;
    }
    const size = readSize();
    const rows = Number.isFinite(size.rows) && size.rows > 0 ? size.rows : 30;
    const columns =
      Number.isFinite(size.columns) && size.columns > 0 ? size.columns : 100;
    return {
      state: st.latestState,
      ledger: st.ledger,
      nowMs: now,
      runStartedAtMs: options.startedAt,
      rows,
      columns,
      palette,
      runOutcome: st.runOutcome,
      outcomeSummary: st.outcomeSummary,
      phaseStartedByTaskId: st.phaseStartedByTaskId,
    };
  };

  const paintOnce = (): string => {
    const input = buildFrameInput(options.clock.now());
    if (!input) {
      return "";
    }
    const bytes = paintAltScreenFrame(input);
    options.terminal.write(bytes);
    return bytes;
  };

  const cleanup = (dumpSummary: boolean): void => {
    if (st.cleanedUp) {
      return;
    }
    st.cleanedUp = true;
    if (st.ticker !== undefined) {
      clearIntervalFn(st.ticker);
      st.ticker = undefined;
    }
    if (st.holdTimer !== undefined) {
      clearTimeoutFn(st.holdTimer);
      st.holdTimer = undefined;
    }
    if (st.raw) {
      try {
        if (typeof stdin.setRawMode === "function") {
          stdin.setRawMode(false);
        }
        stdin.pause();
      } catch {
        // best-effort
      }
      st.raw = false;
    }
    // Atomic restore: cursor + alt-screen leave in one write. Errors bubble
    // up so cli.ts can fall back to plain output.
    options.terminal.write(SHOW_CURSOR + ALT_LEAVE);
    setTerminalCursorHidden(false);
    if (dumpSummary) {
      const input = buildFrameInput(options.clock.now());
      if (input) {
        options.terminal.write("\n" + paintScrollbackSummary(input) + "\n");
      }
    }
  };

  const arm = (): void => {
    // Enter alt-screen + hide cursor as one atomic write.
    options.terminal.write(ALT_ENTER + HIDE_CURSOR);
    setTerminalCursorHidden(true);

    if (stdin && stdin.isTTY && typeof stdin.setRawMode === "function") {
      try {
        stdin.setRawMode(true);
        stdin.resume();
        if (typeof stdin.setEncoding === "function") {
          stdin.setEncoding("utf8");
        }
        st.raw = true;
        stdin.on("data", (chunk: Buffer | string) => {
          const text =
            typeof chunk === "string" ? chunk : chunk.toString("utf8");
          for (const ch of text) {
            if (ch === "q") {
              try {
                cleanup(true);
              } catch {
                // best-effort — process is exiting
              }
              exitProcess(0);
              return;
            }
            if (ch === CTRL_C) {
              try {
                cleanup(true);
              } catch {
                // best-effort — process is exiting
              }
              exitProcess(130);
              return;
            }
          }
        });
      } catch {
        st.raw = false;
      }
    }

    registerSignal("SIGINT", () => {
      try {
        cleanup(true);
      } catch {
        // best-effort — process is exiting
      }
      exitProcess(130);
    });
    registerSignal("SIGTERM", () => {
      try {
        cleanup(true);
      } catch {
        // best-effort — process is exiting
      }
      exitProcess(143);
    });

    st.ticker = setIntervalFn(() => {
      try {
        paintOnce();
      } catch {
        // ignore — a bad paint should not tear down the ticker
      }
    }, 500);
    if (
      st.ticker !== undefined &&
      typeof (st.ticker as unknown as { unref?: () => void }).unref ===
        "function"
    ) {
      (st.ticker as unknown as { unref: () => void }).unref();
    }
  };

  const ingestState = (state: HubRunDisplayState): void => {
    const now = options.clock.now();
    const prev = st.latestState;

    // Track batch-start timing so completed-batch ledger rows show duration.
    for (const batch of Object.values(state.batches)) {
      if (!st.batchStartedAt.has(batch.batchId)) {
        st.batchStartedAt.set(batch.batchId, now);
      }
    }
    // Track task-phase start (used by live active card sub-line).
    for (const task of Object.values(state.tasks)) {
      const before = prev?.tasks[task.taskId];
      if (
        !before ||
        before.status !== task.status ||
        before.stage !== task.stage
      ) {
        if (
          !st.phaseStartedByTaskId.has(task.taskId) ||
          before?.status !== task.status
        ) {
          st.phaseStartedByTaskId.set(task.taskId, now);
        }
      }
    }

    // Ledger appends from state transitions.
    for (const task of Object.values(state.tasks)) {
      if (st.recordedTasks.has(task.taskId)) {
        continue;
      }
      if (task.status === "done" || task.status === "failed") {
        st.recordedTasks.add(task.taskId);
        st.ledger.push({
          kind: "task",
          id: task.taskId,
          title: taskTitleFor(state, task.taskId),
          outcome: task.status === "done" ? "done" : "failed",
          durationMs: now - options.startedAt,
          atMs: now,
        });
      }
    }
    for (const batch of Object.values(state.batches)) {
      if (st.recordedBatches.has(batch.batchId)) {
        continue;
      }
      if (!isTerminalHubRunBatchStatus(batch.status)) {
        continue;
      }
      st.recordedBatches.add(batch.batchId);
      const started =
        st.batchStartedAt.get(batch.batchId) ?? options.startedAt;
      const shippedCount = countShippedBatchTasks(batch, state);
      const pendingCount = countPendingBatchTasks(batch, state);
      st.ledger.push({
        kind: "batch",
        id: shortHubId(batch.batchId),
        title: resolveBatchLedgerTitle({ batch, shippedCount, pendingCount }),
        outcome: resolveBatchLedgerOutcome({
          batchStatus: batch.status,
          shippedCount,
        }),
        durationMs: now - started,
        atMs: now,
      });
    }

    st.latestState = state;
  };

  let armed = false;
  const armIfNeeded = (): void => {
    if (armed) return;
    armed = true;
    arm();
  };

  const finalizeInternal = (
    state: HubRunDisplayState,
    outcome: HubRunOutcomeProjection,
  ): void => {
    if (st.finalized || st.cleanedUp) {
      return;
    }
    st.finalized = true;
    ingestState(state);
    st.runOutcome =
      outcome.outcome === "failed"
        ? "failed"
        : outcome.outcome === "cancelled"
          ? "cancelled"
          : "done";
    st.outcomeSummary = outcome.summary;
    // Paint the final frame so the user sees the outcome, then immediately
    // dump summary + restore terminal. `cli.ts` controls the process exit
    // via `process.exitCode`; the 2-second hold + exit lives on the
    // signal/keypress paths only (interactive dismissal).
    paintOnce();
    if (st.ticker !== undefined) {
      clearIntervalFn(st.ticker);
      st.ticker = undefined;
    }
    cleanup(true);
  };

  return {
    update: (state) => {
      if (st.cleanedUp) return false;
      armIfNeeded();
      ingestState(state);
      // Paint immediately so the user sees the state change without waiting
      // for the next tick.
      try {
        paintOnce();
      } catch {
        // ignore
      }
      return true;
    },
    refresh: () => {
      if (st.cleanedUp) return false;
      armIfNeeded();
      try {
        paintOnce();
      } catch {
        // ignore
      }
      return true;
    },
    resize: () => !st.cleanedUp,
    finalize: finalizeInternal,
    cancel: (state) => finalizeInternal(state, cancellationOutcome(state)),
    dispose: () => cleanup(false),
    emittedModels: () => [],
    paintFrame: () => {
      const input = buildFrameInput(options.clock.now());
      return input ? paintAltScreenFrame(input) : "";
    },
    ledger: () => st.ledger,
  };
};

// -----------------------------------------------------------------------------
// Append-only fallback path (retained from Phase 3a, ADR-0032). This is what
// `--stream` / non-TTY / --plain / NO_COLOR / --yes / TERM=dumb produce.
// -----------------------------------------------------------------------------

const createFallbackPath = (
  options: HubRunLiveDisplayOptions,
): HubRunLiveDisplay => {
  let closed = false;
  let columns = options.columns;
  let lastState: HubRunDisplayState | undefined;
  let lastModel: RunCardSectionModel | undefined;
  let activeTaskId: string | undefined;
  let phaseStartedAt = options.startedAt;
  const batchStartedAt = new Map<string, number>();
  const batchDurationsMs: Record<string, number> = {};
  const emitted: RunCardSectionModel[] = [];
  const enableSpinner = options.enableSpinner ?? options.color;
  const usingInjectedSpinner = options.createSpinner !== undefined;
  const createSpinnerFn =
    options.createSpinner ?? (() => clack.spinner() as HubRunLiveSpinner);
  let spinner: HubRunLiveSpinner | undefined;
  let spinnerText: string | undefined;

  const stopSpinner = (preserve = true): void => {
    if (!spinner) return;
    try {
      if (preserve && spinnerText) {
        spinner.stop(spinnerText);
      } else {
        spinner.stop();
      }
    } catch {
      // best-effort
    }
    spinner = undefined;
    setTerminalCursorHidden(false);
  };

  const startSpinner = (text: string | undefined): void => {
    stopSpinner(true);
    spinnerText = text;
    if (!enableSpinner || text === undefined) return;
    if (
      !usingInjectedSpinner &&
      typeof process !== "undefined" &&
      process.stdin &&
      !process.stdin.isTTY
    ) {
      return;
    }
    try {
      spinner = createSpinnerFn();
      spinner.start(text);
      setTerminalCursorHidden(true);
    } catch {
      spinner = undefined;
    }
  };

  const appendModel = (model: RunCardSectionModel): void => {
    stopSpinner(true);
    const lines = renderRunCardSectionText(model, {
      width: columns,
      colorEnabled: options.color,
    });
    options.terminal.write(`${lines.join("\n")}\n`);
    emitted.push(model);
    lastModel = model;
    startSpinner(model.spinnerText);
  };

  const trackBatchTimings = (state: HubRunDisplayState, now: number): void => {
    for (const batch of Object.values(state.batches)) {
      if (!batchStartedAt.has(batch.batchId)) {
        batchStartedAt.set(batch.batchId, now);
      }
      if (
        isTerminalHubRunBatchStatus(batch.status) &&
        batchDurationsMs[batch.batchId] === undefined
      ) {
        const started = batchStartedAt.get(batch.batchId) ?? options.startedAt;
        batchDurationsMs[batch.batchId] = now - started;
      }
    }
  };

  const emitTransition = (
    kind: RunCardTransitionKind,
    state: HubRunDisplayState,
    extras: {
      readonly activeTaskId?: string;
      readonly failureReason?: string;
      readonly outcomeCounts?: HubRunOutcomeProjection["counts"];
      readonly outcomeSummary?: string;
      readonly taskDetails?: HubRunOutcomeProjection["taskDetails"];
    } = {},
  ): void => {
    const now = options.clock.now();
    trackBatchTimings(state, now);
    if (
      kind === "task.started" ||
      kind === "task.phase-changed" ||
      kind === "batch.started" ||
      kind === "run.started"
    ) {
      phaseStartedAt = now;
    }
    const nextActive =
      extras.activeTaskId ?? activeTaskId ?? findActiveTaskId(state);
    if (extras.activeTaskId) {
      activeTaskId = extras.activeTaskId;
    } else if (kind === "task.started" || kind === "task.phase-changed") {
      activeTaskId = nextActive;
    } else if (kind === "task.completed" || kind === "task.failed") {
      // keep activeTaskId
    } else if (kind === "batch.started" || kind === "run.started") {
      activeTaskId = undefined;
    }

    const model = buildRunCardSectionModel({
      kind,
      state,
      nowMs: now,
      startedAtMs: options.startedAt,
      phaseStartedAtMs: phaseStartedAt,
      activeTaskId: extras.activeTaskId ?? activeTaskId,
      failureReason: extras.failureReason,
      batchDurationsMs,
      outcomeCounts: extras.outcomeCounts,
      outcomeSummary: extras.outcomeSummary,
      taskDetails: extras.taskDetails,
    });
    appendModel(model);
  };

  const closeWithOutcome = (
    state: HubRunDisplayState,
    outcome: HubRunOutcomeProjection,
  ): void => {
    if (closed) return;
    const kind: RunCardTransitionKind =
      outcome.outcome === "failed" ? "run.failed" : "run.completed";
    const failedTask = Object.values(state.tasks).find(
      (task) => task.status === "failed",
    );
    emitTransition(kind, state, {
      activeTaskId: failedTask?.taskId ?? outcome.taskDetails[0]?.taskId,
      failureReason:
        failedTask?.detail?.diagnostic ??
        outcome.taskDetails[0]?.diagnostic ??
        (outcome.outcome === "cancelled" ? "Run cancelled" : outcome.summary),
      outcomeCounts: outcome.counts,
      outcomeSummary: outcome.summary,
      taskDetails: outcome.taskDetails,
    });
    stopSpinner(false);
    options.terminal.write(SHOW_CURSOR);
    setTerminalCursorHidden(false);
    closed = true;
  };

  const dispose = (): void => {
    if (closed) return;
    stopSpinner(false);
    options.terminal.write(SHOW_CURSOR);
    setTerminalCursorHidden(false);
    closed = true;
  };

  return {
    update: (state) => {
      if (closed) return false;
      const detection = detectRunCardTransition(lastState, state);
      lastState = state;
      if (!detection) return true;
      if (detection.kind === "subphase") {
        if (detection.activeTaskId) {
          activeTaskId = detection.activeTaskId;
        }
        if (lastModel?.spinnerText && spinner) {
          const text = refreshRunCardSpinnerText(
            lastModel,
            options.clock.now() - phaseStartedAt,
          );
          if (text) {
            spinnerText = text;
            try {
              spinner.message(text);
            } catch {
              // ignore
            }
          }
        }
        return true;
      }
      emitTransition(detection.kind, state, {
        activeTaskId: detection.activeTaskId,
        failureReason: detection.activeTaskId
          ? state.tasks[detection.activeTaskId]?.detail?.diagnostic
          : undefined,
      });
      return true;
    },
    refresh: () => {
      if (closed) return false;
      if (!lastModel?.spinnerText || !spinner) return true;
      const text = refreshRunCardSpinnerText(
        lastModel,
        options.clock.now() - phaseStartedAt,
      );
      if (text) {
        spinnerText = text;
        try {
          spinner.message(text);
        } catch {
          // ignore
        }
      }
      return true;
    },
    resize: (nextColumns) => {
      if (closed || !Number.isFinite(nextColumns) || nextColumns < 1) {
        return !closed;
      }
      columns = nextColumns;
      return true;
    },
    finalize: closeWithOutcome,
    cancel: (state) => closeWithOutcome(state, cancellationOutcome(state)),
    dispose,
    emittedModels: () => emitted,
  };
};

// -----------------------------------------------------------------------------
// Public factory
// -----------------------------------------------------------------------------

export const createHubRunLiveDisplay = (
  options: HubRunLiveDisplayOptions,
): HubRunLiveDisplay => {
  const mode = options.mode ?? "fallback";
  if (mode === "alt-screen") {
    return createAltScreenPath(options);
  }
  return createFallbackPath(options);
};
