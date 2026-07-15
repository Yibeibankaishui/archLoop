import { stripVTControlCharacters } from "node:util";

import type {
  HubRunDisplayState,
  HubRunOutcomeProjection,
} from "./hubRunDisplay.js";
import { projectHubRunStateOutcome } from "./hubRunDisplay.js";
import stringWidth from "string-width";
import {
  HUB_RUN_MIN_LIVE_COLUMNS,
  HUB_RUN_MIN_LIVE_ROWS,
  HUB_RUN_WIDE_COLUMNS,
} from "./hubRunOutputMode.js";
import { SHOW_CURSOR, setTerminalCursorHidden } from "./terminalCleanup.js";

const HIDE_CURSOR = "\x1b[?25l";
const ERASE_LINE = "\r\x1b[2K";
const CURSOR_UP = "\x1b[1A";

export interface HubRunLiveTerminal {
  readonly write: (chunk: string) => void;
}

export interface HubRunLiveClock {
  readonly now: () => number;
}

export interface HubRunLiveDisplayOptions {
  readonly terminal: HubRunLiveTerminal;
  readonly clock: HubRunLiveClock;
  readonly startedAt: number;
  readonly columns: number;
  readonly rows?: number;
  readonly color: boolean;
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
}

const taskSymbol = (status: string): string => {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "blocked":
      return "!";
    case "reviewing":
    case "merging":
      return "◆";
    case "waiting_for_merge":
      return "○";
    case "implementing":
      return "●";
    default:
      return "·";
  }
};

const TASK_STAGE_BY_STATUS: Readonly<Record<string, string>> = {
  inbox: "Inbox",
  needs_info: "Needs info",
  ready_for_agent: "Ready for agent",
  ready_for_human: "Ready for human",
  blocked: "Blocked",
  implementing: "Implementing",
  reviewing: "Reviewing",
  waiting_for_merge: "Waiting for merge",
  merging: "Merging",
  done: "Completed",
  wontfix: "Closed",
  failed: "Failed",
  sync_conflict: "Sync conflict",
};

const SAFE_TASK_STAGES = new Set([
  ...Object.values(TASK_STAGE_BY_STATUS),
  "Resolving merge conflict",
  "Verifying",
  "Closing",
  "In progress",
]);

const canonicalTaskStage = (
  task: HubRunDisplayState["tasks"][string],
): string =>
  SAFE_TASK_STAGES.has(task.stage)
    ? task.stage
    : (TASK_STAGE_BY_STATUS[task.status] ?? "In progress");

const canonicalBatchStage = (
  batch: HubRunDisplayState["batches"][string],
): string => {
  const expected =
    batch.status === "planning"
      ? "Planning"
      : batch.status === "merging"
        ? "Merging"
        : batch.status === "done"
          ? "Completed"
          : "Completed with failures";
  return batch.stage === "Preparing to merge" ? batch.stage : expected;
};

const currentBatch = (state: HubRunDisplayState) =>
  Object.values(state.batches).find(
    (batch) => batch.status !== "done" && batch.status !== "partial_failed",
  );

const taskCountLabel = (count: number): string =>
  `${count} ${count === 1 ? "task" : "tasks"}`;

const completedBatchSummary = (
  batch: HubRunDisplayState["batches"][string],
): string =>
  batch.status === "done"
    ? `✓ Batch ${batch.batchId} completed | ${taskCountLabel(batch.selectedTaskIds.length)}`
    : `! Batch ${batch.batchId} completed with failures | ${taskCountLabel(batch.selectedTaskIds.length)}`;

const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${mmss}` : mmss;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const takeDisplayWidth = (text: string, maximumWidth: number): string => {
  let result = "";
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = stringWidth(segment);
    if (width + segmentWidth > maximumWidth) {
      break;
    }
    result += segment;
    width += segmentWidth;
  }
  return result;
};

const TERMINAL_UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

const sanitizeTerminalText = (text: string): string =>
  stripVTControlCharacters(text)
    .replace(TERMINAL_UNSAFE_CHARACTERS, " ")
    .trimEnd();

const fitLine = (line: string, columns: number): string => {
  const safeLine = sanitizeTerminalText(line);
  const maximumWidth = Math.max(1, Math.floor(columns) - 1);
  if (stringWidth(safeLine) <= maximumWidth) {
    return safeLine;
  }
  const ellipsis = "...";
  return `${takeDisplayWidth(safeLine, Math.max(0, maximumWidth - stringWidth(ellipsis)))}${ellipsis}`;
};

const wrapLine = (line: string, columns: number): readonly string[] => {
  const safeLine = sanitizeTerminalText(line);
  const maximumWidth = Math.max(1, Math.floor(columns) - 1);
  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  for (const { segment } of graphemeSegmenter.segment(safeLine)) {
    const segmentWidth = stringWidth(segment);
    if (currentLine.length > 0 && currentWidth + segmentWidth > maximumWidth) {
      lines.push(currentLine);
      currentLine = "";
      currentWidth = 0;
    }
    currentLine += segment;
    currentWidth += segmentWidth;
  }
  if (currentLine.length > 0 || lines.length === 0) {
    lines.push(currentLine);
  }
  return lines;
};

const SYMBOL_COLORS: Readonly<Record<string, number>> = {
  "✓": 32,
  "✗": 31,
  "!": 33,
  "◆": 36,
  "○": 33,
  "●": 36,
  "·": 90,
};

const colorizeStatusSymbol = (line: string, enabled: boolean): string => {
  if (!enabled) {
    return line;
  }
  return line.replace(/^(\s*)([✓✗!◆○●·])(?= )/, (_, spacing, symbol) => {
    const color = SYMBOL_COLORS[symbol] ?? 37;
    return `${spacing}\x1b[${color}m${symbol}\x1b[0m`;
  });
};

const clearRenderedRegion = (lineCount: number): string =>
  Array.from(
    { length: lineCount },
    (_, index) => `${ERASE_LINE}${index < lineCount - 1 ? CURSOR_UP : ""}`,
  ).join("");

const finalOutcomeLines = (
  state: HubRunDisplayState,
  outcome: HubRunOutcomeProjection,
  elapsedMs: number,
  columns: number,
): readonly string[] => {
  const symbol =
    outcome.outcome === "completed"
      ? "✓"
      : outcome.outcome === "failed"
        ? "✗"
        : "!";
  const lines =
    columns >= HUB_RUN_WIDE_COLUMNS
      ? [
          `${symbol} ${outcome.summary} | Completed ${outcome.counts.completed} | Failed ${outcome.counts.failed} | Blocked ${outcome.counts.blocked} | Skipped ${outcome.counts.skipped} | Ready to merge ${outcome.counts.readyToMerge}`,
          `Elapsed ${formatElapsed(elapsedMs)} | Logs ${state.runDir ?? "pending"}`,
        ]
      : [
          `${symbol} ${outcome.summary}`,
          `Completed ${outcome.counts.completed} | Failed ${outcome.counts.failed}`,
          `Blocked ${outcome.counts.blocked} | Skipped ${outcome.counts.skipped}`,
          `Ready to merge ${outcome.counts.readyToMerge}`,
          `Elapsed ${formatElapsed(elapsedMs)}`,
          `Logs ${state.runDir ?? "pending"}`,
        ];
  return lines.flatMap((line) => wrapLine(line, columns));
};

const finalTaskDetailLines = (
  outcome: HubRunOutcomeProjection,
  columns: number,
): readonly string[] =>
  outcome.taskDetails.flatMap((detail) =>
    [
      `! Task ${detail.taskId} | ${detail.stage}`,
      `  Diagnostic: ${detail.diagnostic}`,
      ...(detail.logPath ? [`  Log: ${detail.logPath}`] : []),
      ...(detail.recoveryCommand
        ? [`  Recovery: ${detail.recoveryCommand}`]
        : []),
      ...(detail.blockingPaths
        ? [`  Blocking paths: ${detail.blockingPaths.join(", ")}`]
        : []),
    ].flatMap((line) => wrapLine(line, columns)),
  );

const cancellationOutcome = (
  state: HubRunDisplayState,
): HubRunOutcomeProjection =>
  projectHubRunStateOutcome(state, {
    outcome: "cancelled",
    summary: "Run cancelled",
    exitCode: 130,
  });

const renderLines = (
  state: HubRunDisplayState,
  elapsedMs: number,
  columns: number,
): readonly string[] => {
  const batch = currentBatch(state);
  const isWide = columns >= HUB_RUN_WIDE_COLUMNS;
  const lines = isWide
    ? [
        `archLoop run | Project ${state.hubProjectName} | Flow ${state.flowId} | Run ${state.runId ?? "starting"}`,
      ]
    : [
        `archLoop run | Project ${state.hubProjectName}`,
        `Flow ${state.flowId} | Run ${state.runId ?? "starting"}`,
      ];
  if (!batch) {
    lines.push(
      ...(isWide
        ? [
            `Elapsed ${formatElapsed(elapsedMs)} | Logs ${state.runDir ?? "pending"}`,
          ]
        : [
            `Elapsed ${formatElapsed(elapsedMs)}`,
            `Logs ${state.runDir ?? "pending"}`,
          ]),
    );
    return lines.map((line) => fitLine(line, columns));
  }

  lines.push(
    `Batch ${batch.batchId} | ${canonicalBatchStage(batch)} | ${taskCountLabel(batch.selectedTaskIds.length)}`,
  );
  for (const taskId of batch.selectedTaskIds) {
    const task = state.tasks[taskId];
    const title = batch.taskTitles?.[taskId];
    const taskLabel = `${taskId}${title ? ` - ${title}` : ""}`;
    const symbol = task ? taskSymbol(task.status) : "·";
    const stage = task ? canonicalTaskStage(task) : "Queued";
    lines.push(
      ...(isWide
        ? [`  ${symbol} ${stage} | ${taskLabel}`]
        : [`  ${symbol} ${stage}`, `    ${taskLabel}`]),
    );
  }
  lines.push(
    ...(isWide
      ? [
          `Elapsed ${formatElapsed(elapsedMs)} | Logs ${state.runDir ?? "pending"}`,
        ]
      : [
          `Elapsed ${formatElapsed(elapsedMs)}`,
          `Logs ${state.runDir ?? "pending"}`,
        ]),
  );
  return lines.map((line) => fitLine(line, columns));
};

export const createHubRunLiveDisplay = (
  options: HubRunLiveDisplayOptions,
): HubRunLiveDisplay => {
  let renderedLineCount = 0;
  let closed = false;
  let cursorMayBeHidden = false;
  let columns = options.columns;
  let rows = options.rows ?? Number.POSITIVE_INFINITY;
  let lastState: HubRunDisplayState | undefined;
  let renderedLines: readonly string[] = [];
  const scrolledBatchIds = new Set<string>();

  const renderedPhysicalLineCount = (atColumns: number): number => {
    const width = Math.max(1, Math.floor(atColumns));
    return renderedLines.reduce(
      (count, line) =>
        count + Math.max(1, Math.ceil(stringWidth(line) / width)),
      0,
    );
  };

  const closeWithOutcome = (
    state: HubRunDisplayState,
    outcome: HubRunOutcomeProjection,
  ): void => {
    if (closed) {
      return;
    }
    const lines = [
      ...finalTaskDetailLines(outcome, columns),
      ...finalOutcomeLines(
        state,
        outcome,
        options.clock.now() - options.startedAt,
        columns,
      ),
    ].map((line) => colorizeStatusSymbol(line, options.color));
    options.terminal.write(
      `${clearRenderedRegion(renderedPhysicalLineCount(columns))}${lines.join("\n")}\n${SHOW_CURSOR}`,
    );
    setTerminalCursorHidden(false);
    renderedLineCount = 0;
    renderedLines = [];
    cursorMayBeHidden = false;
    closed = true;
  };

  const closeLiveRegion = (): void => {
    if (closed) {
      return;
    }
    if (renderedLineCount > 0 || cursorMayBeHidden) {
      options.terminal.write(
        `${clearRenderedRegion(renderedPhysicalLineCount(columns))}${SHOW_CURSOR}`,
      );
      setTerminalCursorHidden(false);
    }
    renderedLineCount = 0;
    renderedLines = [];
    cursorMayBeHidden = false;
    closed = true;
  };

  const renderState = (state: HubRunDisplayState): boolean => {
    if (closed) {
      return false;
    }
    lastState = state;
    const visibleLines = renderLines(
      state,
      options.clock.now() - options.startedAt,
      columns,
    );
    if (visibleLines.length >= rows) {
      closeLiveRegion();
      return false;
    }
    const lines = visibleLines.map((line) =>
      colorizeStatusSymbol(line, options.color),
    );
    const completedBatchLines = Object.values(state.batches)
      .filter(
        (batch) =>
          (batch.status === "done" || batch.status === "partial_failed") &&
          !scrolledBatchIds.has(batch.batchId),
      )
      .sort((left, right) => left.batchId.localeCompare(right.batchId))
      .map((batch) => {
        scrolledBatchIds.add(batch.batchId);
        return colorizeStatusSymbol(
          fitLine(completedBatchSummary(batch), columns),
          options.color,
        );
      });
    const clearRegion = clearRenderedRegion(renderedPhysicalLineCount(columns));
    const shouldHideCursor = renderedLineCount === 0 && !cursorMayBeHidden;
    if (shouldHideCursor) {
      cursorMayBeHidden = true;
      setTerminalCursorHidden(true);
    }
    options.terminal.write(
      `${shouldHideCursor ? HIDE_CURSOR : clearRegion}${completedBatchLines.length > 0 ? `${completedBatchLines.join("\n")}\n` : ""}${lines.join("\n")}`,
    );
    renderedLineCount = lines.length;
    renderedLines = visibleLines;
    return true;
  };

  const dispose = (): void => closeLiveRegion();

  return {
    update: renderState,
    refresh: () => {
      if (lastState) {
        return renderState(lastState);
      }
      return !closed;
    },
    resize: (nextColumns, nextRows = rows) => {
      if (
        closed ||
        !Number.isFinite(nextColumns) ||
        nextColumns < HUB_RUN_MIN_LIVE_COLUMNS ||
        (nextRows !== Number.POSITIVE_INFINITY &&
          (!Number.isFinite(nextRows) || nextRows < HUB_RUN_MIN_LIVE_ROWS))
      ) {
        if (!closed && (renderedLineCount > 0 || cursorMayBeHidden)) {
          const cleanupColumns =
            Number.isFinite(nextColumns) && nextColumns > 0
              ? nextColumns
              : columns;
          options.terminal.write(
            `${clearRenderedRegion(renderedPhysicalLineCount(cleanupColumns))}${SHOW_CURSOR}`,
          );
          setTerminalCursorHidden(false);
          renderedLineCount = 0;
          renderedLines = [];
          cursorMayBeHidden = false;
          closed = true;
        } else {
          dispose();
        }
        return false;
      }
      if (nextColumns !== columns && renderedLineCount > 0) {
        options.terminal.write(
          clearRenderedRegion(renderedPhysicalLineCount(nextColumns)),
        );
        renderedLineCount = 0;
        renderedLines = [];
      }
      columns = nextColumns;
      rows = nextRows;
      if (lastState) {
        return renderState(lastState);
      }
      return true;
    },
    finalize: closeWithOutcome,
    cancel: (state) => closeWithOutcome(state, cancellationOutcome(state)),
    dispose,
  };
};
