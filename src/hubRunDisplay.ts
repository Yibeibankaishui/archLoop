import { join } from "node:path";

import type { HubRunEvent, HubRunStopReason } from "./hubExecution.js";
import type { RunHubFlowResult } from "./hubFlowExecution.js";

export type HubRunOutcome =
  | "completed"
  | "completed_with_failures"
  | "failed"
  | "cancelled";

export interface HubRunTaskDetail {
  readonly taskId: string;
  readonly stage: string;
  readonly diagnostic: string;
  readonly logPath?: string;
  readonly recoveryCommand?: string;
  readonly blockingPaths?: readonly string[];
}

export interface HubRunOutcomeProjection {
  readonly outcome: HubRunOutcome;
  readonly summary: string;
  readonly counts: {
    readonly completed: number;
    readonly failed: number;
    readonly blocked: number;
    readonly skipped: number;
    readonly readyToMerge: number;
  };
  readonly taskDetails: readonly HubRunTaskDetail[];
  readonly exitCode: number;
}

export const resolveHubRunExitCode = (outcome: HubRunOutcome): number =>
  outcome === "completed" ? 0 : outcome === "cancelled" ? 130 : 1;

const classifyHubRunTasks = (
  result: RunHubFlowResult,
): HubRunOutcomeProjection["counts"] => {
  const completed = new Set(
    result.batchResults.flatMap((batch) =>
      batch.batchStatus === "completed" ? batch.selectedTaskIds : [],
    ),
  );
  const failed = new Set<string>();
  const blocked = new Set<string>();
  const skipped = new Set<string>();
  const readyToMerge = new Set<string>();

  for (const task of result.results) {
    if (completed.has(task.taskId)) {
      continue;
    }
    if (
      task.outcome === "agent_failed" ||
      task.outcome === "sandbox_failed" ||
      task.hubStatus === "failed"
    ) {
      failed.add(task.taskId);
    } else if (task.outcome === "active_execution") {
      blocked.add(task.taskId);
    } else if (task.outcome === "claim_skipped") {
      skipped.add(task.taskId);
    } else if (task.hubStatus === "waiting_for_merge") {
      readyToMerge.add(task.taskId);
    }
  }

  for (const diagnostic of result.mergeResult?.selectionDiagnostics ?? []) {
    if (completed.has(diagnostic.taskId) || failed.has(diagnostic.taskId)) {
      continue;
    }
    if (diagnostic.decision === "blocked") {
      blocked.add(diagnostic.taskId);
      skipped.delete(diagnostic.taskId);
      readyToMerge.delete(diagnostic.taskId);
    } else if (diagnostic.decision === "skipped") {
      skipped.add(diagnostic.taskId);
      readyToMerge.delete(diagnostic.taskId);
    }
  }

  for (const task of result.mergeResult?.results ?? []) {
    blocked.delete(task.taskId);
    skipped.delete(task.taskId);
    readyToMerge.delete(task.taskId);
    if (task.outcome === "merged") {
      completed.add(task.taskId);
      failed.delete(task.taskId);
    } else if (task.outcome === "skipped") {
      if (task.hubStatus === "waiting_for_merge") {
        readyToMerge.add(task.taskId);
      } else {
        skipped.add(task.taskId);
      }
    } else {
      failed.add(task.taskId);
    }
  }

  return {
    completed: completed.size,
    failed: failed.size,
    blocked: blocked.size,
    skipped: skipped.size,
    readyToMerge: readyToMerge.size,
  };
};

const conciseDiagnostic = (
  value: string | undefined,
  fallback: string,
): string => {
  const firstLine = value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return fallback;
  }
  return firstLine.length <= 240 ? firstLine : `${firstLine.slice(0, 237)}...`;
};

const projectFailedTaskDetails = (
  result: RunHubFlowResult,
): readonly HubRunTaskDetail[] =>
  result.results.flatMap((task) => {
    if (task.outcome !== "agent_failed" && task.outcome !== "sandbox_failed") {
      return [];
    }

    const failureStage =
      task.failureStage ??
      (task.hubStatus === "failed" ? "implementation" : undefined);
    const canRecover = [
      "failed",
      "implementing",
      "reviewing",
      "merging",
    ].includes(task.hubStatus);
    return [
      {
        taskId: task.taskId,
        stage:
          failureStage === "review"
            ? "Review failed"
            : failureStage === "implementation"
              ? "Implementation failed"
              : "Execution blocked",
        diagnostic: conciseDiagnostic(
          task.diagnosticSummary,
          task.outcome === "sandbox_failed"
            ? "Sandbox execution failed."
            : "Agent execution failed.",
        ),
        logPath:
          task.logPath ??
          (failureStage
            ? join(
                result.runDir,
                "logs",
                failureStage === "review"
                  ? `${task.taskId}-review.log`
                  : `${task.taskId}.log`,
              )
            : result.runDir),
        ...(canRecover
          ? { recoveryCommand: `archloop tasks recover ${task.taskId}` }
          : {}),
      },
    ];
  });

const projectMergeSelectionDetails = (
  result: RunHubFlowResult,
): readonly HubRunTaskDetail[] =>
  (result.mergeResult?.selectionDiagnostics ?? []).flatMap((diagnostic) => {
    if (
      diagnostic.reason !== "state_inconsistent" &&
      diagnostic.reason !== "dirty_worktree"
    ) {
      return [];
    }

    const isStateInconsistent = diagnostic.reason === "state_inconsistent";
    return [
      {
        taskId: diagnostic.taskId,
        stage: "Merge blocked",
        diagnostic:
          diagnostic.message ??
          (isStateInconsistent
            ? "Task projection state is inconsistent."
            : "Dirty source files overlap this task branch. Commit, stash, or discard them, then rerun the same flow."),
        ...(isStateInconsistent
          ? {
              recoveryCommand:
                diagnostic.suggestedRecovery ??
                `archloop tasks repair-state ${diagnostic.taskId}`,
            }
          : {}),
        ...(diagnostic.blockingPaths
          ? { blockingPaths: diagnostic.blockingPaths }
          : {}),
      },
    ];
  });

const projectWaitingMergeDetails = (
  result: RunHubFlowResult,
): readonly HubRunTaskDetail[] => {
  const completedTaskIds = new Set(
    result.batchResults.flatMap((batch) =>
      batch.batchStatus === "completed" ? batch.selectedTaskIds : [],
    ),
  );
  const failedMergeTaskIds = new Set(
    (result.mergeResult?.results ?? []).flatMap((task) =>
      task.outcome === "merged" || task.outcome === "skipped"
        ? []
        : [task.taskId],
    ),
  );
  const mergedTaskIds = new Set(
    (result.mergeResult?.results ?? []).flatMap((task) =>
      task.outcome === "merged" ? [task.taskId] : [],
    ),
  );
  const nonSelectedTaskIds = new Set(
    (result.mergeResult?.selectionDiagnostics ?? []).flatMap((diagnostic) =>
      diagnostic.decision !== "selected" ? [diagnostic.taskId] : [],
    ),
  );

  return result.results.flatMap((task) =>
    task.hubStatus === "waiting_for_merge" &&
    !completedTaskIds.has(task.taskId) &&
    !failedMergeTaskIds.has(task.taskId) &&
    !mergedTaskIds.has(task.taskId) &&
    !nonSelectedTaskIds.has(task.taskId)
      ? [
          {
            taskId: task.taskId,
            stage: "Waiting for merge",
            diagnostic:
              "Work is ready to merge. Rerun the same flow to resume this batch.",
            recoveryCommand: `archloop run --flow ${result.flowId}`,
          },
        ]
      : [],
  );
};

const MERGE_FAILURE_STAGE: Readonly<Record<string, string>> = {
  merge_conflict: "Merge conflict",
  merge_failed: "Merge failed",
  verification_failed: "Verification failed",
  close_failed: "Task close failed",
};

const projectMergeFailureDetails = (
  result: RunHubFlowResult,
): readonly HubRunTaskDetail[] =>
  (result.mergeResult?.results ?? []).flatMap((task) => {
    const stage = MERGE_FAILURE_STAGE[task.outcome];
    if (!stage) {
      return [];
    }

    return [
      {
        taskId: task.taskId,
        stage,
        diagnostic:
          task.diagnosticSummary ??
          task.failureReason ??
          "The merge phase failed.",
        logPath:
          task.logPath ??
          (task.outcome === "merge_conflict"
            ? join(result.runDir, "logs", `${task.taskId}-merge.log`)
            : result.runDir),
        recoveryCommand: `archloop tasks recover ${task.taskId}`,
      },
    ];
  });

export const projectHubRunOutcome = (
  result: RunHubFlowResult,
  options: { readonly cancelled?: boolean } = {},
): HubRunOutcomeProjection => {
  const counts = classifyHubRunTasks(result);
  const hasPartialProgress = counts.completed > 0 || counts.readyToMerge > 0;
  const outcome: HubRunOutcome =
    options.cancelled === true
      ? "cancelled"
      : result.stopReason !== "batch_failed"
        ? "completed"
        : hasPartialProgress
          ? "completed_with_failures"
          : "failed";

  return {
    outcome,
    summary:
      outcome === "cancelled"
        ? "Run cancelled"
        : outcome === "completed_with_failures"
          ? "Run completed with failures"
          : outcome === "failed"
            ? "Run failed"
            : result.stopReason === "no_ready_tasks" &&
                result.completedBatchCount === 0
              ? "Nothing to run"
              : result.stopReason === "max_batches_reached"
                ? "Reached configured flow-batch limit"
                : "Run completed",
    counts,
    taskDetails: [
      ...projectFailedTaskDetails(result),
      ...projectMergeSelectionDetails(result),
      ...projectMergeFailureDetails(result),
      ...projectWaitingMergeDetails(result),
    ],
    exitCode: resolveHubRunExitCode(outcome),
  };
};

export interface HubRunDisplayState {
  readonly hubProjectName: string;
  readonly flowId: string;
  readonly runId?: string;
  readonly runDir?: string;
  readonly status:
    | "starting"
    | "running"
    | "completed"
    | "completed_with_failures"
    | "failed"
    | "cancelled";
  readonly completedBatchCount: number;
  readonly completedTaskCount: number;
  readonly stopReason?: HubRunStopReason;
  readonly batches: Readonly<
    Record<
      string,
      {
        readonly batchId: string;
        readonly selectedTaskIds: readonly string[];
        readonly taskTitles?: Readonly<Record<string, string>>;
        readonly status: "planning" | "merging" | "done" | "partial_failed";
        readonly stage: string;
      }
    >
  >;
  readonly tasks: Readonly<
    Record<
      string,
      {
        readonly taskId: string;
        readonly batchId: string;
        readonly status: string;
        readonly stage: string;
        readonly skipped?: boolean;
        readonly detail?: HubRunTaskDetail;
      }
    >
  >;
  readonly seenEventIds: ReadonlySet<string>;
  readonly eventSequences: {
    readonly run?: number;
    readonly batches: Readonly<Record<string, number>>;
    readonly tasks: Readonly<Record<string, number>>;
  };
}

export const createHubRunDisplayState = (input: {
  readonly hubProjectName: string;
  readonly flowId: string;
}): HubRunDisplayState => ({
  ...input,
  status: "starting",
  completedBatchCount: 0,
  completedTaskCount: 0,
  batches: {},
  tasks: {},
  seenEventIds: new Set(),
  eventSequences: { batches: {}, tasks: {} },
});

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

const resolveTaskStage = (event: Extract<HubRunEvent, { taskId: string }>) => {
  switch (event.type) {
    case "merge_conflict_resolution_started":
      return "Resolving merge conflict";
    case "verification_started":
      return "Verifying";
    case "integration_candidate_created":
      return "Creating landing candidate";
    case "candidate_verification_passed":
    case "verification_passed":
      return "Landing";
    case "target_landing_succeeded":
    case "task_close_started":
      return "Closing";
    case "task_close_succeeded":
    case "task_closed":
      return "Completed";
    default:
      return TASK_STAGE_BY_STATUS[event.status] ?? "In progress";
  }
};

const projectEventTaskDetail = (
  state: HubRunDisplayState,
  event: Extract<HubRunEvent, { taskId: string }>,
): HubRunTaskDetail | undefined => {
  const isBlocked =
    event.type === "task_retry_blocked" || event.status === "blocked";
  const isFailed = event.type.endsWith("_failed") || event.status === "failed";
  if (!isBlocked && !isFailed) {
    return undefined;
  }
  const stage =
    event.type === "task_implementation_failed"
      ? "Implementation failed"
      : event.type === "task_review_failed"
        ? "Review failed"
        : isBlocked
          ? "Execution blocked"
          : resolveTaskStage(event);
  const diagnostics = event.diagnostics;
  const explicitLogPath =
    typeof diagnostics?.path === "string"
      ? diagnostics.path
      : typeof diagnostics?.logPath === "string"
        ? diagnostics.logPath
        : undefined;
  const fallbackLogPath = state.runDir
    ? event.type === "task_implementation_failed"
      ? join(state.runDir, "logs", `${event.taskId}.log`)
      : event.type === "task_review_failed"
        ? join(state.runDir, "logs", `${event.taskId}-review.log`)
        : state.runDir
    : undefined;
  return {
    taskId: event.taskId,
    stage,
    diagnostic: conciseDiagnostic(
      event.diagnosticSummary ??
        event.message ??
        event.reason ??
        event.failureReason,
      isBlocked ? "Task execution is blocked." : "Task failed.",
    ),
    ...((explicitLogPath ?? fallbackLogPath)
      ? { logPath: explicitLogPath ?? fallbackLogPath }
      : {}),
    recoveryCommand: `archloop tasks recover ${event.taskId}`,
  };
};

export const projectHubRunStateOutcome = (
  state: HubRunDisplayState,
  input: {
    readonly outcome: HubRunOutcome;
    readonly summary: string;
    readonly exitCode: number;
  },
): HubRunOutcomeProjection => {
  const tasks = Object.values(state.tasks);
  const countStatus = (status: string): number =>
    tasks.filter((task) => task.status === status && !task.skipped).length;
  return {
    ...input,
    counts: {
      completed: countStatus("done"),
      failed: countStatus("failed"),
      blocked: countStatus("blocked"),
      skipped: tasks.filter((task) => task.skipped).length,
      readyToMerge: countStatus("waiting_for_merge"),
    },
    taskDetails: tasks.flatMap((task) => (task.detail ? [task.detail] : [])),
  };
};

const reduceBatchEvent = (
  state: HubRunDisplayState,
  event: Extract<HubRunEvent, { batchId: string }>,
): HubRunDisplayState["batches"][string] | undefined => {
  const current = state.batches[event.batchId];
  switch (event.type) {
    case "batch_started":
      return {
        batchId: event.batchId,
        selectedTaskIds: current?.selectedTaskIds ?? [],
        taskTitles: current?.taskTitles,
        status: "planning",
        stage: "Planning",
      };
    case "batch_planned":
      return {
        batchId: event.batchId,
        selectedTaskIds: event.taskIds,
        taskTitles: event.tasks
          ? Object.fromEntries(
              event.tasks.map((task) => [task.taskId, task.title]),
            )
          : current?.taskTitles,
        status: "planning",
        stage: "Planning",
      };
    case "batch_merge_selection":
      return {
        batchId: event.batchId,
        selectedTaskIds: event.selectedTaskIds,
        taskTitles: current?.taskTitles,
        status: "merging",
        stage: "Preparing to merge",
      };
    case "batch_merge_started":
      return {
        batchId: event.batchId,
        selectedTaskIds: event.taskIds,
        taskTitles: current?.taskTitles,
        status: "merging",
        stage: "Merging",
      };
    case "batch_merge_completed":
      return {
        batchId: event.batchId,
        selectedTaskIds: event.taskIds,
        taskTitles: current?.taskTitles,
        status: event.batchStatus,
        stage:
          event.batchStatus === "done"
            ? "Completed"
            : "Completed with failures",
      };
    default:
      return current;
  }
};

export const reduceHubRunDisplayState = (
  state: HubRunDisplayState,
  event: HubRunEvent,
): HubRunDisplayState => {
  if (state.seenEventIds.has(event.eventId)) {
    return state;
  }
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(event.eventId);
  const currentSequence =
    "taskId" in event
      ? state.eventSequences.tasks[event.taskId]
      : "batchId" in event
        ? state.eventSequences.batches[event.batchId]
        : state.eventSequences.run;
  if (currentSequence !== undefined && event.sequence <= currentSequence) {
    return { ...state, seenEventIds };
  }

  if ("taskId" in event) {
    const detail = projectEventTaskDetail(state, event);
    const skipped = event.type === "task_claim_skipped";
    return {
      ...state,
      tasks: {
        ...state.tasks,
        [event.taskId]: {
          taskId: event.taskId,
          batchId: event.batchId,
          status: event.status,
          stage: resolveTaskStage(event),
          ...(skipped ? { skipped: true } : {}),
          ...(detail ? { detail } : {}),
        },
      },
      seenEventIds,
      eventSequences: {
        ...state.eventSequences,
        tasks: {
          ...state.eventSequences.tasks,
          [event.taskId]: event.sequence,
        },
      },
    };
  }

  if ("batchId" in event) {
    const batch = reduceBatchEvent(state, event);
    return batch
      ? {
          ...state,
          batches: { ...state.batches, [event.batchId]: batch },
          seenEventIds,
          eventSequences: {
            ...state.eventSequences,
            batches: {
              ...state.eventSequences.batches,
              [event.batchId]: event.sequence,
            },
          },
        }
      : { ...state, seenEventIds };
  }

  switch (event.type) {
    case "run_started":
      return {
        ...state,
        runId: event.runId,
        runDir: join(event.hubProjectDir, "runs", event.runId),
        status: "running",
        seenEventIds,
        eventSequences: { ...state.eventSequences, run: event.sequence },
      };
    case "run_completed":
      return {
        ...state,
        runId: event.runId,
        status:
          event.stopReason === "batch_failed"
            ? "completed_with_failures"
            : "completed",
        completedBatchCount: event.completedBatchCount,
        completedTaskCount: event.completedTaskCount,
        stopReason: event.stopReason,
        seenEventIds,
        eventSequences: { ...state.eventSequences, run: event.sequence },
      };
    default:
      return { ...state, seenEventIds };
  }
};

const textField = (name: string, value: string): string =>
  `${name}=${JSON.stringify(value)}`;

const numberField = (name: string, value: number): string => `${name}=${value}`;

export const formatPlainHubRunOutcome = (
  result: RunHubFlowResult,
  projection: HubRunOutcomeProjection,
): readonly string[] => [
  ...projection.taskDetails.map((detail) =>
    [
      "event=task_attention",
      textField("run_id", result.runId),
      textField("task_id", detail.taskId),
      textField("stage", detail.stage),
      textField("diagnostic", detail.diagnostic),
      ...(detail.logPath ? [textField("log", detail.logPath)] : []),
      ...(detail.recoveryCommand
        ? [textField("recovery", detail.recoveryCommand)]
        : []),
      ...(detail.blockingPaths
        ? [`blocking_paths=${JSON.stringify(detail.blockingPaths)}`]
        : []),
    ].join(" "),
  ),
  [
    "event=run_completed",
    textField("outcome", projection.outcome),
    textField("summary", projection.summary),
    numberField("completed", projection.counts.completed),
    numberField("failed", projection.counts.failed),
    numberField("blocked", projection.counts.blocked),
    numberField("skipped", projection.counts.skipped),
    numberField("ready_to_merge", projection.counts.readyToMerge),
    numberField("completed_batches", result.completedBatchCount),
    textField("run_id", result.runId),
    textField("logs", result.runDir),
  ].join(" "),
];

export const formatPlainHubRunCancellation = (
  state: HubRunDisplayState,
): string => {
  const projection = projectHubRunStateOutcome(state, {
    outcome: "cancelled",
    summary: "Run cancelled",
    exitCode: 130,
  });
  return [
    "event=run_completed",
    textField("outcome", projection.outcome),
    textField("summary", projection.summary),
    numberField("completed", projection.counts.completed),
    numberField("failed", projection.counts.failed),
    numberField("blocked", projection.counts.blocked),
    numberField("skipped", projection.counts.skipped),
    numberField("ready_to_merge", projection.counts.readyToMerge),
    numberField(
      "completed_batches",
      Object.values(state.batches).filter((batch) => batch.status === "done")
        .length,
    ),
    textField("run_id", state.runId ?? ""),
    textField("logs", state.runDir ?? ""),
  ].join(" ");
};

export const formatPlainHubRunFailure = (
  state: HubRunDisplayState,
  error: unknown,
): string => {
  const projection = projectHubRunStateOutcome(state, {
    outcome: "failed",
    summary: "Run failed",
    exitCode: 1,
  });
  const diagnostic = conciseDiagnostic(
    error instanceof Error ? error.message : String(error),
    "Run execution failed.",
  );
  return [
    "event=run_failed",
    textField("outcome", projection.outcome),
    textField("summary", projection.summary),
    textField("diagnostic", diagnostic),
    numberField("completed", projection.counts.completed),
    numberField("failed", projection.counts.failed),
    numberField("blocked", projection.counts.blocked),
    numberField("skipped", projection.counts.skipped),
    numberField("ready_to_merge", projection.counts.readyToMerge),
    numberField(
      "completed_batches",
      Object.values(state.batches).filter((batch) => batch.status === "done")
        .length,
    ),
    textField("run_id", state.runId ?? ""),
    textField("logs", state.runDir ?? ""),
    textField("recovery", `archloop run --flow ${state.flowId}`),
  ].join(" ");
};

const formatRunSummary = (state: HubRunDisplayState): string =>
  state.stopReason === "no_ready_tasks" && state.completedBatchCount === 0
    ? "Nothing to run"
    : "Run completed";

export const formatPlainHubRunEvent = (
  event: HubRunEvent,
  state: HubRunDisplayState,
): string => {
  if ("taskId" in event) {
    return [
      `event=${event.type}`,
      textField("run_id", event.runId),
      textField("batch_id", event.batchId),
      textField("task_id", event.taskId),
      textField("stage", resolveTaskStage(event)),
    ].join(" ");
  }

  if (event.type === "batch_merge_completed") {
    return [
      "event=batch_merge_completed",
      textField("run_id", event.runId),
      textField("batch_id", event.batchId),
      textField(
        "outcome",
        event.batchStatus === "done" ? "completed" : "completed_with_failures",
      ),
      numberField("completed_tasks", event.taskIds.length),
      textField(
        "stage",
        event.batchStatus === "done" ? "Completed" : "Completed with failures",
      ),
    ].join(" ");
  }

  switch (event.type) {
    case "run_started":
      return [
        "event=run_started",
        textField("hub_project", state.hubProjectName),
        textField("flow", state.flowId),
        textField("run_id", event.runId),
        textField("logs", join(event.hubProjectDir, "runs", event.runId)),
      ].join(" ");
    case "task_store_migration":
      return [
        "event=task_store_migration",
        textField("run_id", event.runId),
        textField("kind", event.kind),
        ...(event.reason ? [textField("reason", event.reason)] : []),
        textField("beads_dir", event.beadsDir),
        textField("message", event.message),
      ].join(" ");
    case "landing_reconciliation":
      return [
        "event=landing_reconciliation",
        textField("run_id", event.runId),
        textField("kind", event.kind),
        numberField("pending_count", event.pendingCount),
        ...(event.integrityIncident
          ? [textField("integrity_incident", event.integrityIncident)]
          : []),
        textField("message", event.message),
      ].join(" ");
    case "batch_started":
      return [
        "event=batch_started",
        textField("run_id", event.runId),
        textField("batch_id", event.batchId),
        textField("stage", "Planning"),
      ].join(" ");
    case "batch_planned":
      return [
        "event=batch_planned",
        textField("run_id", event.runId),
        textField("batch_id", event.batchId),
        `selected_tasks=${JSON.stringify(event.taskIds)}`,
      ].join(" ");
    case "run_completed":
      return [
        "event=run_completed",
        textField("outcome", state.status),
        textField("summary", formatRunSummary(state)),
        numberField("completed_batches", state.completedBatchCount),
        numberField("completed_tasks", state.completedTaskCount),
        textField("run_id", event.runId),
        textField("logs", state.runDir ?? ""),
      ].join(" ");
    default:
      return [`event=${event.type}`, textField("run_id", event.runId)].join(
        " ",
      );
  }
};
