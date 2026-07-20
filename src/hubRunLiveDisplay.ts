import * as clack from "@clack/prompts";

import type {
  HubRunDisplayState,
  HubRunOutcomeProjection,
} from "./hubRunDisplay.js";
import { projectHubRunStateOutcome } from "./hubRunDisplay.js";
import {
  buildRunCardSectionModel,
  detectRunCardTransition,
  refreshRunCardSpinnerText,
  renderRunCardSectionText,
  type RunCardSectionModel,
  type RunCardTransitionKind,
} from "./hubRunCard.js";
import { SHOW_CURSOR, setTerminalCursorHidden } from "./terminalCleanup.js";

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

export interface HubRunLiveDisplayOptions {
  readonly terminal: HubRunLiveTerminal;
  readonly clock: HubRunLiveClock;
  readonly startedAt: number;
  readonly columns: number;
  readonly rows?: number;
  readonly color: boolean;
  /** When false, skip the clack spinner (tests / plain / non-TTY). Default: color. */
  readonly enableSpinner?: boolean;
  readonly createSpinner?: () => HubRunLiveSpinner;
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
  /** Test/inspection helper: models emitted so far. */
  readonly emittedModels: () => readonly RunCardSectionModel[];
}

const cancellationOutcome = (
  state: HubRunDisplayState,
): HubRunOutcomeProjection =>
  projectHubRunStateOutcome(state, {
    outcome: "cancelled",
    summary: "Run cancelled",
    exitCode: 130,
  });

const findActiveTaskId = (
  state: HubRunDisplayState,
): string | undefined => {
  const activeBatch = Object.values(state.batches).find(
    (batch) => batch.status !== "done" && batch.status !== "partial_failed",
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

export const createHubRunLiveDisplay = (
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
  const createSpinner =
    options.createSpinner ??
    (() => clack.spinner() as HubRunLiveSpinner);
  let spinner: HubRunLiveSpinner | undefined;
  let spinnerText: string | undefined;

  const stopSpinner = (preserve = true): void => {
    if (!spinner) {
      return;
    }
    try {
      if (preserve && spinnerText) {
        spinner.stop(spinnerText);
      } else {
        spinner.stop();
      }
    } catch {
      // Best-effort — terminal may already be tearing down.
    }
    spinner = undefined;
    setTerminalCursorHidden(false);
  };

  const startSpinner = (text: string | undefined): void => {
    stopSpinner(true);
    spinnerText = text;
    if (!enableSpinner || text === undefined) {
      return;
    }
    // Default clack.spinner takes over stdin raw mode; skip when stdin is not
    // a TTY (vitest mocks, redirected input) to avoid hanging the process.
    // Injected spinners (unit tests) are always allowed.
    if (
      !usingInjectedSpinner &&
      typeof process !== "undefined" &&
      process.stdin &&
      !process.stdin.isTTY
    ) {
      return;
    }
    try {
      spinner = createSpinner();
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
        (batch.status === "done" || batch.status === "partial_failed") &&
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
      // keep activeTaskId for the completed/failed section
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
    if (closed) {
      return;
    }
    const kind: RunCardTransitionKind =
      outcome.outcome === "failed" ? "run.failed" : "run.completed";
    const failedTask = Object.values(state.tasks).find(
      (task) => task.status === "failed",
    );
    emitTransition(kind, state, {
      activeTaskId:
        failedTask?.taskId ?? outcome.taskDetails[0]?.taskId,
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
    if (closed) {
      return;
    }
    stopSpinner(false);
    options.terminal.write(SHOW_CURSOR);
    setTerminalCursorHidden(false);
    closed = true;
  };

  return {
    update: (state) => {
      if (closed) {
        return false;
      }
      const detection = detectRunCardTransition(lastState, state);
      lastState = state;
      if (!detection) {
        return true;
      }
      if (detection.kind === "subphase") {
        if (detection.activeTaskId) {
          activeTaskId = detection.activeTaskId;
        }
        // Sub-phase ticks stay on the same section; only the spinner heartbeat moves.
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
      if (closed) {
        return false;
      }
      if (!lastModel?.spinnerText || !spinner) {
        return true;
      }
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
