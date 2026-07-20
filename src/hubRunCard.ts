import type { HubRunDisplayState } from "./hubRunDisplay.js";
import {
  renderSection,
  type RenderSectionOptions,
  type SectionBlock,
  type SectionFooterBlock,
  type SectionGroupBlock,
  type SectionHeaderBlock,
  type SectionIndentedBlock,
} from "./section.js";

export type RunCardTransitionKind =
  | "run.started"
  | "batch.started"
  | "task.started"
  | "task.phase-changed"
  | "task.completed"
  | "task.failed"
  | "batch.completed"
  | "run.completed"
  | "run.failed";

export type RunCardBatchView =
  | { readonly kind: "collapsed"; readonly summary: string }
  | {
      readonly kind: "current";
      readonly line: SectionGroupBlock;
      readonly current?: SectionIndentedBlock;
    };

export interface RunCardSectionModel {
  readonly kind: RunCardTransitionKind;
  readonly header: SectionHeaderBlock;
  readonly batches: readonly RunCardBatchView[];
  readonly footer: SectionFooterBlock;
  readonly extraFooters?: readonly SectionFooterBlock[];
  readonly spinnerText?: string;
}

export interface BuildRunCardSectionModelInput {
  readonly kind: RunCardTransitionKind;
  readonly state: HubRunDisplayState;
  readonly nowMs: number;
  readonly startedAtMs: number;
  readonly phaseStartedAtMs: number;
  readonly activeTaskId?: string;
  readonly failureReason?: string;
  readonly batchDurationsMs?: Readonly<Record<string, number>>;
  readonly outcomeCounts?: {
    readonly completed: number;
    readonly failed: number;
    readonly blocked: number;
    readonly skipped: number;
    readonly readyToMerge: number;
  };
  readonly outcomeSummary?: string;
  readonly taskDetails?: readonly {
    readonly taskId: string;
    readonly stage: string;
    readonly diagnostic: string;
    readonly recoveryCommand?: string;
  }[];
}

const TASK_COUNT_LABEL = (count: number): string =>
  `${count} ${count === 1 ? "task" : "tasks"}`;

/** Leading 8 chars of the UUID portion (`run-` / `batch-` prefix stripped). */
export const shortHubId = (id: string): string => {
  const stripped = id.replace(/^(run|batch)-/i, "");
  return stripped.slice(0, 8);
};

const matchesHubIdSelector = (id: string, selector: string): boolean => {
  if (id === selector) {
    return true;
  }
  const idShort = shortHubId(id);
  const selectorShort = shortHubId(selector);
  if (idShort === selector || idShort === selectorShort) {
    return true;
  }
  if (id.startsWith(selector) || idShort.startsWith(selector)) {
    return true;
  }
  if (
    selectorShort.length > 0 &&
    (idShort.startsWith(selectorShort) || id.startsWith(selector))
  ) {
    return true;
  }
  return false;
};

/**
 * Resolve a run/batch id by full id or unambiguous prefix (ADR-0031).
 * Throws when zero or multiple candidates match.
 */
export const resolveHubIdByPrefix = (
  candidates: readonly string[],
  selector: string,
  noun: string = "run",
): string => {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new Error(`error: ${noun} id is empty`);
  }
  const exact = candidates.find((id) => id === trimmed);
  if (exact) {
    return exact;
  }
  const matches = candidates.filter((id) => matchesHubIdSelector(id, trimmed));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length === 0) {
    throw new Error(`error: ${noun} id "${trimmed}" matched no ${noun}s`);
  }
  const listed = matches.map((id) => shortHubId(id)).join(", ");
  throw new Error(
    `error: ${noun} id "${trimmed}" matches ${matches.length} ${noun}s — pass the full id (${listed})`,
  );
};

/** Compact phase/header elapsed: `0s`, `12s`, `3m12s`, `1h05m`. */
export const formatPhaseElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
};

/** Clock-style duration for collapsed batch summaries: `mm:ss` or `hh:mm:ss`. */
export const formatClockElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${mmss}` : mmss;
};

const phaseLabel = (statusOrStage: string): string => {
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
    case "done":
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    default:
      return normalized.replace(/_/g, " ") || "running";
  }
};

const currentBatch = (
  state: HubRunDisplayState,
): HubRunDisplayState["batches"][string] | undefined =>
  Object.values(state.batches).find(
    (batch) => batch.status !== "done" && batch.status !== "partial_failed",
  );

const sortedBatches = (
  state: HubRunDisplayState,
): HubRunDisplayState["batches"][string][] =>
  Object.values(state.batches).sort((a, b) =>
    a.batchId.localeCompare(b.batchId),
  );

const logsTipFooter = (state: HubRunDisplayState): SectionFooterBlock => {
  const short = state.runId ? shortHubId(state.runId) : "pending";
  return {
    kind: "footer",
    label: "tip",
    commands: [`…/runs/run-${short}/`, "press o to open · l to tail"],
  };
};

const buildHeader = (
  state: HubRunDisplayState,
  kind: RunCardTransitionKind,
  elapsedMs: number,
): SectionHeaderBlock => {
  const short = state.runId ? shortHubId(state.runId) : "……";
  const elapsed = formatPhaseElapsed(elapsedMs);
  let right = `run ${short} · ${elapsed}`;
  if (kind === "run.completed") {
    right = `run ${short} · ✓ ${elapsed}`;
  } else if (kind === "run.failed") {
    right = `run ${short} · ✗ ${elapsed}`;
  }
  return {
    kind: "header",
    title: "archLoop",
    subtitle: `${state.hubProjectName} · ${state.flowId}`,
    right,
  };
};

const collapsedSummary = (
  batch: HubRunDisplayState["batches"][string],
  durationMs: number | undefined,
): string => {
  const short = shortHubId(batch.batchId);
  const count = TASK_COUNT_LABEL(batch.selectedTaskIds.length);
  const duration =
    durationMs !== undefined ? ` · ${formatClockElapsed(durationMs)}` : "";
  if (batch.status === "done") {
    return `✓ batch ${short}   ${count}   done${duration}`;
  }
  return `✗ batch ${short}   ${count}   failed${duration}`;
};

const currentBatchGroup = (
  batch: HubRunDisplayState["batches"][string],
  activeTaskStatus?: string,
): SectionGroupBlock => {
  const short = shortHubId(batch.batchId);
  const symbol =
    batch.status === "done"
      ? "✓"
      : batch.status === "partial_failed"
        ? "✗"
        : "◐";
  const severity =
    symbol === "✓" ? "success" : symbol === "✗" ? "error" : "warn";
  const rightHint =
    batch.status === "planning"
      ? activeTaskStatus
        ? `planning · ${phaseLabel(activeTaskStatus)}`
        : "planning"
      : batch.status === "merging"
        ? "merging"
        : batch.status === "done"
          ? "done"
          : "failed";
  return {
    kind: "group",
    symbol,
    severity,
    name: `batch ${short}`,
    count: batch.selectedTaskIds.length,
    rightHint,
    items: [],
  };
};

const activeTaskBlock = (
  state: HubRunDisplayState,
  taskId: string,
  kind: RunCardTransitionKind,
  phaseElapsedMs: number,
  failureReason?: string,
): SectionIndentedBlock | undefined => {
  const task = state.tasks[taskId];
  if (!task) {
    return undefined;
  }
  const batch = state.batches[task.batchId];
  const title =
    batch?.taskTitles?.[taskId] ??
    task.detail?.stage ??
    task.stage ??
    taskId;
  const phase = phaseLabel(task.status);
  if (kind === "task.completed" || task.status === "done") {
    return {
      kind: "indented-block",
      leading: "✓",
      leadingSeverity: "success",
      id: taskId,
      title,
      subLines: [`done · ${formatPhaseElapsed(phaseElapsedMs)}`],
    };
  }
  if (kind === "task.failed" || kind === "run.failed" || task.status === "failed") {
    const reason =
      failureReason ??
      task.detail?.diagnostic ??
      "Task failed.";
    return {
      kind: "indented-block",
      leading: "✗",
      leadingSeverity: "error",
      id: taskId,
      title,
      subLines: [`! ${reason}`],
    };
  }
  return {
    kind: "indented-block",
    leading: "↳",
    leadingSeverity: "info",
    id: taskId,
    title,
    subLines: [`${phase} · ${formatPhaseElapsed(phaseElapsedMs)} in this step`],
  };
};

const buildBatchViews = (
  input: BuildRunCardSectionModelInput,
): readonly RunCardBatchView[] => {
  const { kind, state, batchDurationsMs } = input;
  const views: RunCardBatchView[] = [];
  const active = currentBatch(state);

  for (const batch of sortedBatches(state)) {
    const isTerminalBatch =
      batch.status === "done" || batch.status === "partial_failed";
    const collapseThis =
      isTerminalBatch ||
      kind === "batch.completed" ||
      kind === "run.completed" ||
      (kind === "run.failed" &&
        batch.batchId !==
          (input.activeTaskId
            ? state.tasks[input.activeTaskId]?.batchId
            : active?.batchId));

    if (collapseThis) {
      views.push({
        kind: "collapsed",
        summary: collapsedSummary(
          batch,
          batchDurationsMs?.[batch.batchId],
        ),
      });
      continue;
    }

    if (active && batch.batchId === active.batchId) {
      const taskId = input.activeTaskId;
      const block =
        taskId !== undefined
          ? activeTaskBlock(
              state,
              taskId,
              kind,
              input.nowMs - input.phaseStartedAtMs,
              input.failureReason,
            )
          : undefined;
      views.push({
        kind: "current",
        line: currentBatchGroup(
          batch,
          taskId ? state.tasks[taskId]?.status : undefined,
        ),
        ...(block ? { current: block } : {}),
      });
    }
  }

  // run.failed must always surface the failing task block (ADR-0032 / Variant C).
  if (kind === "run.failed" && input.activeTaskId) {
    const task = state.tasks[input.activeTaskId];
    const alreadyShown = views.some(
      (view) =>
        view.kind === "current" &&
        view.current?.id === input.activeTaskId,
    );
    if (task && !alreadyShown) {
      const batch = state.batches[task.batchId];
      const block = activeTaskBlock(
        state,
        input.activeTaskId,
        kind,
        input.nowMs - input.phaseStartedAtMs,
        input.failureReason,
      );
      if (batch) {
        // Replace collapsed form of this batch with current+failure detail.
        const idx = views.findIndex(
          (view) =>
            view.kind === "collapsed" &&
            view.summary.includes(shortHubId(batch.batchId)),
        );
        const currentView: RunCardBatchView = {
          kind: "current",
          line: currentBatchGroup(batch, task.status),
          ...(block ? { current: block } : {}),
        };
        if (idx >= 0) {
          views[idx] = currentView;
        } else {
          views.push(currentView);
        }
      } else if (block) {
        views.push({
          kind: "current",
          line: {
            kind: "group",
            symbol: "✗",
            severity: "error",
            name: "failed",
            count: 1,
            rightHint: "failed",
            items: [],
          },
          current: block,
        });
      }
    }
  }

  return views;
};

const buildSpinnerText = (
  input: BuildRunCardSectionModelInput,
): string | undefined => {
  const { kind, state } = input;
  if (
    kind === "task.completed" ||
    kind === "task.failed" ||
    kind === "batch.completed" ||
    kind === "run.completed" ||
    kind === "run.failed"
  ) {
    return undefined;
  }
  const runShort = state.runId ? shortHubId(state.runId) : "……";
  const phaseElapsed = formatPhaseElapsed(input.nowMs - input.phaseStartedAtMs);

  if (kind === "run.started") {
    return `◐ waiting · plan · ${phaseElapsed} · run ${runShort}`;
  }

  if (input.activeTaskId) {
    const task = state.tasks[input.activeTaskId];
    const phase = phaseLabel(task?.status ?? "implementing");
    return `◐ ${input.activeTaskId} · ${phase} · ${phaseElapsed} · run ${runShort}`;
  }

  const batch = currentBatch(state);
  if (batch) {
    const batchShort = shortHubId(batch.batchId);
    const phase = phaseLabel(batch.status);
    return `◐ batch ${batchShort} · ${phase} · ${phaseElapsed} · run ${runShort}`;
  }

  return `◐ waiting · plan · ${phaseElapsed} · run ${runShort}`;
};

const buildFooter = (
  input: BuildRunCardSectionModelInput,
): {
  readonly footer: SectionFooterBlock;
  readonly extraFooters?: readonly SectionFooterBlock[];
} => {
  const { kind, state, outcomeCounts } = input;
  if (kind === "run.failed") {
    const short = state.runId ? shortHubId(state.runId) : "……";
    return {
      footer: {
        kind: "footer",
        label: "fix",
        command: `archloop run --resume ${short} --only-failed`,
      },
    };
  }
  if (kind === "run.completed") {
    const merged = outcomeCounts?.completed ?? state.completedTaskCount;
    const failed = outcomeCounts?.failed ?? 0;
    const summaryLine =
      input.outcomeSummary &&
      input.outcomeSummary !== "Run completed" &&
      input.outcomeSummary !== "Run completed with failures"
        ? input.outcomeSummary
        : `summary  ${merged} merged · ${failed} failed`;
    return {
      footer: {
        kind: "footer",
        label: "tip",
        commands: [
          `…/runs/run-${state.runId ? shortHubId(state.runId) : "pending"}/`,
          summaryLine,
        ],
      },
      extraFooters: [
        {
          kind: "footer",
          label: "next",
          command: "archloop tasks list",
        },
      ],
    };
  }
  return { footer: logsTipFooter(state) };
};

export const buildRunCardSectionModel = (
  input: BuildRunCardSectionModelInput,
): RunCardSectionModel => {
  const elapsedMs = input.nowMs - input.startedAtMs;
  const { footer, extraFooters } = buildFooter(input);
  const spinnerText = buildSpinnerText(input);
  const batches =
    input.kind === "run.started"
      ? []
      : appendTaskDetailBlocks(input, buildBatchViews(input));
  return {
    kind: input.kind,
    header: buildHeader(input.state, input.kind, elapsedMs),
    batches,
    footer,
    ...(extraFooters ? { extraFooters } : {}),
    ...(spinnerText !== undefined ? { spinnerText } : {}),
  };
};

export const runCardModelToBlocks = (
  model: RunCardSectionModel,
): readonly SectionBlock[] => {
  const blocks: SectionBlock[] = [model.header];
  for (const batch of model.batches) {
    if (batch.kind === "collapsed") {
      const match = /^(✓|✗)\s+batch\s+(\S+)\s+(\d+)\s+tasks?\s+(.+)$/.exec(
        batch.summary,
      );
      if (match) {
        blocks.push({
          kind: "group",
          symbol: match[1] as "✓" | "✗",
          severity: match[1] === "✓" ? "success" : "error",
          name: `batch ${match[2]}`,
          count: Number(match[3]),
          rightHint: match[4],
          items: [],
        });
      } else {
        blocks.push({
          kind: "prose",
          body: batch.summary,
        });
      }
      continue;
    }
    blocks.push(batch.line);
    if (batch.current) {
      blocks.push(batch.current);
    }
  }
  blocks.push(model.footer);
  if (model.extraFooters) {
    blocks.push(...model.extraFooters);
  }
  return blocks;
};

const appendTaskDetailBlocks = (
  input: BuildRunCardSectionModelInput,
  batches: readonly RunCardBatchView[],
): readonly RunCardBatchView[] => {
  const details = input.taskDetails;
  if (!details || details.length === 0) {
    return batches;
  }
  const views = [...batches];
  for (const detail of details) {
    const alreadyShown = views.some(
      (view) =>
        view.kind === "current" && view.current?.id === detail.taskId,
    );
    if (alreadyShown) {
      continue;
    }
    const subLines = [
      `! ${detail.diagnostic}`,
      ...(detail.recoveryCommand ? [detail.recoveryCommand] : []),
    ];
    views.push({
      kind: "current",
      line: {
        kind: "group",
        symbol: "✗",
        severity: "error",
        name: detail.stage,
        count: 1,
        items: [],
      },
      current: {
        kind: "indented-block",
        leading: "✗",
        leadingSeverity: "error",
        id: detail.taskId,
        title: detail.stage,
        subLines,
      },
    });
  }
  return views;
};

export const renderRunCardSectionText = (
  model: RunCardSectionModel,
  options?: RenderSectionOptions,
): readonly string[] =>
  renderSection("", runCardModelToBlocks(model), options);

const CROSS_PHASE_STATUSES = new Set([
  "implementing",
  "reviewing",
  "waiting_for_merge",
  "merging",
  "done",
  "failed",
  "blocked",
]);

export type RunCardTransitionDetection =
  | { readonly kind: RunCardTransitionKind; readonly activeTaskId?: string }
  | { readonly kind: "subphase"; readonly activeTaskId?: string }
  | undefined;

/**
 * Classify the primary run-card transition between two display states.
 * Sub-phase ticks (same status, stage text change) do not emit a section.
 */
export const detectRunCardTransition = (
  prev: HubRunDisplayState | undefined,
  next: HubRunDisplayState,
): RunCardTransitionDetection => {
  if (
    next.status === "failed" &&
    prev?.status !== "failed"
  ) {
    const failedTask = Object.values(next.tasks).find(
      (task) => task.status === "failed",
    );
    return { kind: "run.failed", activeTaskId: failedTask?.taskId };
  }
  if (
    (next.status === "completed" ||
      next.status === "completed_with_failures") &&
    prev?.status !== "completed" &&
    prev?.status !== "completed_with_failures"
  ) {
    return { kind: "run.completed" };
  }

  if (prev) {
    for (const batch of Object.values(next.batches)) {
      const before = prev.batches[batch.batchId];
      if (
        before &&
        before.status !== "done" &&
        before.status !== "partial_failed" &&
        (batch.status === "done" || batch.status === "partial_failed")
      ) {
        return { kind: "batch.completed" };
      }
    }

    for (const task of Object.values(next.tasks)) {
      const before = prev.tasks[task.taskId];
      if (before && before.status !== "failed" && task.status === "failed") {
        return { kind: "task.failed", activeTaskId: task.taskId };
      }
      if (before && before.status !== "done" && task.status === "done") {
        return { kind: "task.completed", activeTaskId: task.taskId };
      }
      if (
        before &&
        before.status !== task.status &&
        CROSS_PHASE_STATUSES.has(before.status) &&
        CROSS_PHASE_STATUSES.has(task.status)
      ) {
        return { kind: "task.phase-changed", activeTaskId: task.taskId };
      }
      if (
        before &&
        before.status === task.status &&
        before.stage !== task.stage
      ) {
        return { kind: "subphase", activeTaskId: task.taskId };
      }
      if (!before && CROSS_PHASE_STATUSES.has(task.status)) {
        return { kind: "task.started", activeTaskId: task.taskId };
      }
    }

    for (const batch of Object.values(next.batches)) {
      if (!prev.batches[batch.batchId]) {
        return { kind: "batch.started" };
      }
    }
  }

  if (next.runId && (!prev?.runId || prev.status === "starting")) {
    if (Object.keys(next.batches).length === 0) {
      return { kind: "run.started" };
    }
  }

  if (!prev) {
    if (next.runId) {
      if (Object.keys(next.batches).length === 0) {
        return { kind: "run.started" };
      }
      const active = currentBatch(next);
      const activeTask = active
        ? active.selectedTaskIds
            .map((taskId) => next.tasks[taskId])
            .find(
              (task) =>
                task &&
                CROSS_PHASE_STATUSES.has(task.status) &&
                task.status !== "done" &&
                task.status !== "failed",
            )
        : undefined;
      if (activeTask) {
        return { kind: "task.started", activeTaskId: activeTask.taskId };
      }
      if (active) {
        return { kind: "batch.started" };
      }
      return { kind: "run.started" };
    }
  }

  return undefined;
};

/** Refresh spinner text for an in-progress model without changing section content. */
export const refreshRunCardSpinnerText = (
  model: RunCardSectionModel,
  phaseElapsedMs: number,
): string | undefined => {
  if (model.spinnerText === undefined) {
    return undefined;
  }
  // Replace the third ` · `-delimited field (phase-elapsed).
  const parts = model.spinnerText.split(" · ");
  if (parts.length < 4) {
    return model.spinnerText;
  }
  parts[2] = formatPhaseElapsed(phaseElapsedMs);
  return parts.join(" · ");
};
