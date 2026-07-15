import { stripVTControlCharacters } from "node:util";

import stringWidth from "string-width";

import {
  HUB_RUN_MIN_LIVE_COLUMNS,
  HUB_RUN_MIN_LIVE_ROWS,
  HUB_RUN_WIDE_COLUMNS,
} from "./hubRunOutputMode.js";
import type {
  HubProposalRunDisplayState,
  HubProposalRunOutcomeProjection,
} from "./hubProposalRunDisplay.js";
import type {
  HubProposalPresentationPhase,
  HubProposalPresentationStatus,
} from "./hubProposalSession.js";
import { SHOW_CURSOR, setTerminalCursorHidden } from "./terminalCleanup.js";

const HIDE_CURSOR = "\x1b[?25l";
const ERASE_LINE = "\r\x1b[2K";
const CURSOR_UP = "\x1b[1A";

const PHASES: readonly HubProposalPresentationPhase[] = [
  "input_preparation",
  "draft",
  "refinement",
  "finalization",
  "mutation_detection",
  "approval",
  "validation",
  "apply",
];

const PHASE_LABELS: Readonly<Record<HubProposalPresentationPhase, string>> = {
  input_preparation: "Prepare input",
  draft: "Generate draft",
  refinement: "Refine proposal",
  finalization: "Finalize proposal",
  approval: "Approve proposal",
  validation: "Validate proposal",
  mutation_detection: "Check mutations",
  apply: "Apply proposal",
};

const statusLabel = (status: HubProposalPresentationStatus): string => {
  switch (status) {
    case "started":
      return "In progress";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "no_change":
      return "No changes";
  }
};

const statusSymbol = (status: HubProposalPresentationStatus): string => {
  switch (status) {
    case "started":
      return "●";
    case "completed":
      return "✓";
    case "cancelled":
      return "!";
    case "failed":
      return "✗";
    case "no_change":
      return "○";
  }
};

const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const UNSAFE_TERMINAL_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

const safeText = (value: string): string =>
  stripVTControlCharacters(value).replace(UNSAFE_TERMINAL_TEXT, " ").trim();

const fitLine = (value: string, columns: number): string => {
  const text = safeText(value);
  const width = Math.max(1, Math.floor(columns) - 1);
  if (stringWidth(text) <= width) {
    return text;
  }
  let result = "";
  for (const character of text) {
    if (stringWidth(`${result}${character}...`) > width) {
      break;
    }
    result += character;
  }
  return `${result}...`;
};

const clearRegion = (lineCount: number): string =>
  Array.from(
    { length: lineCount },
    (_, index) => `${ERASE_LINE}${index < lineCount - 1 ? CURSOR_UP : ""}`,
  ).join("");

const colorize = (line: string, enabled: boolean): string => {
  if (!enabled) {
    return line;
  }
  return line.replace(/^([✓✗!●○])(?= )/, (symbol) => {
    const color = symbol === "✓" ? 32 : symbol === "✗" ? 31 : 36;
    return `\x1b[${color}m${symbol}\x1b[0m`;
  });
};

const frameLines = (
  state: HubProposalRunDisplayState,
  elapsedMs: number,
  columns: number,
): readonly string[] => {
  const wide = columns >= HUB_RUN_WIDE_COLUMNS;
  const lines = wide
    ? [
        `archLoop run | Project ${state.hubProjectName} | Flow ${state.flowId} | Run ${state.runId ?? "starting"}`,
      ]
    : [
        `archLoop run | Project ${state.hubProjectName}`,
        `Flow ${state.flowId} | Run ${state.runId ?? "starting"}`,
      ];
  for (const phase of PHASES) {
    const projected = state.phases[phase];
    if (projected) {
      lines.push(
        `${statusSymbol(projected.status)} ${PHASE_LABELS[phase]} | ${statusLabel(projected.status)}`,
      );
    }
  }
  lines.push(
    ...(wide
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

export interface HubProposalRunLiveDisplayOptions {
  readonly terminal: { readonly write: (chunk: string) => void };
  readonly clock: { readonly now: () => number };
  readonly startedAt: number;
  readonly columns: number;
  readonly rows?: number;
  readonly color: boolean;
}

export interface HubProposalRunLiveDisplay {
  readonly update: (state: HubProposalRunDisplayState) => boolean;
  readonly refresh: () => boolean;
  readonly suspend: () => void;
  readonly resume: () => boolean;
  readonly resize: (columns: number, rows?: number) => boolean;
  readonly finalize: (
    state: HubProposalRunDisplayState,
    outcome: HubProposalRunOutcomeProjection,
  ) => void;
  readonly dispose: () => void;
}

export const createHubProposalRunLiveDisplay = (
  options: HubProposalRunLiveDisplayOptions,
): HubProposalRunLiveDisplay => {
  let columns = options.columns;
  let rows = options.rows ?? Number.POSITIVE_INFINITY;
  let renderedLineCount = 0;
  let renderedLines: readonly string[] = [];
  let cursorHidden = false;
  let closed = false;
  let suspended = false;
  let lastState: HubProposalRunDisplayState | undefined;

  const renderedPhysicalLineCount = (atColumns: number): number => {
    const width = Math.max(1, Math.floor(atColumns));
    return renderedLines.reduce(
      (count, line) =>
        count + Math.max(1, Math.ceil(stringWidth(line) / width)),
      0,
    );
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    if (renderedLineCount > 0 || cursorHidden) {
      options.terminal.write(
        `${clearRegion(renderedPhysicalLineCount(columns))}${SHOW_CURSOR}`,
      );
      setTerminalCursorHidden(false);
    }
    renderedLineCount = 0;
    renderedLines = [];
    cursorHidden = false;
    closed = true;
  };

  const render = (state: HubProposalRunDisplayState): boolean => {
    if (closed) {
      return false;
    }
    lastState = state;
    if (suspended) {
      return true;
    }
    const lines = frameLines(
      state,
      options.clock.now() - options.startedAt,
      columns,
    );
    if (lines.length >= rows) {
      close();
      return false;
    }
    const output = lines.map((line) => colorize(line, options.color));
    const shouldHideCursor = !cursorHidden;
    if (shouldHideCursor) {
      cursorHidden = true;
      setTerminalCursorHidden(true);
    }
    options.terminal.write(
      `${shouldHideCursor ? HIDE_CURSOR : clearRegion(renderedPhysicalLineCount(columns))}${output.join("\n")}`,
    );
    renderedLineCount = output.length;
    renderedLines = lines;
    return true;
  };

  return {
    update: render,
    refresh: () => (lastState ? render(lastState) : !closed),
    suspend: () => {
      if (closed || suspended) {
        return;
      }
      if (renderedLineCount > 0 || cursorHidden) {
        options.terminal.write(
          `${clearRegion(renderedPhysicalLineCount(columns))}${SHOW_CURSOR}`,
        );
        setTerminalCursorHidden(false);
      }
      renderedLineCount = 0;
      renderedLines = [];
      cursorHidden = false;
      suspended = true;
    },
    resume: () => {
      if (closed) {
        return false;
      }
      suspended = false;
      return lastState ? render(lastState) : true;
    },
    resize: (nextColumns, nextRows = rows) => {
      if (
        closed ||
        !Number.isFinite(nextColumns) ||
        nextColumns < HUB_RUN_MIN_LIVE_COLUMNS ||
        (nextRows !== Number.POSITIVE_INFINITY &&
          (!Number.isFinite(nextRows) || nextRows < HUB_RUN_MIN_LIVE_ROWS))
      ) {
        close();
        return false;
      }
      if (renderedLineCount > 0) {
        options.terminal.write(
          clearRegion(renderedPhysicalLineCount(nextColumns)),
        );
        renderedLineCount = 0;
        renderedLines = [];
      }
      columns = nextColumns;
      rows = nextRows;
      return lastState ? render(lastState) : true;
    },
    finalize: (state, outcome) => {
      if (closed) {
        return;
      }
      const symbol =
        outcome.exitCode === 0 ? "✓" : outcome.exitCode === 130 ? "!" : "✗";
      const lines = [
        `${symbol} ${outcome.summary} | Applied ${outcome.counts.applied} | Skipped ${outcome.counts.skipped} | Dependencies ${outcome.counts.dependencies}`,
        ...(outcome.diagnostic ? [`  Diagnostic: ${outcome.diagnostic}`] : []),
        ...(outcome.recoveryCommand
          ? [`  Recovery: ${outcome.recoveryCommand}`]
          : []),
        `Elapsed ${formatElapsed(options.clock.now() - options.startedAt)} | Logs ${outcome.logs || state.runDir || "pending"}`,
      ].map((line) => colorize(fitLine(line, columns), options.color));
      options.terminal.write(
        `${clearRegion(renderedPhysicalLineCount(columns))}${lines.join("\n")}\n${SHOW_CURSOR}`,
      );
      setTerminalCursorHidden(false);
      renderedLineCount = 0;
      renderedLines = [];
      cursorHidden = false;
      closed = true;
    },
    dispose: close,
  };
};
