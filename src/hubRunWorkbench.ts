import { HUB_DESKTOP_LAYOUT } from "./hubDesktopShell.js";
import type {
  HubRunEventRecord,
  HubRuntimePreviewAction,
} from "./hubRuntimeBridge.js";
import type {
  HubProjectBatchSummary,
  HubProjectRunSummary,
  HubProjectStatus,
} from "./projectStatus.js";
import type { HubWorktreeLeaseDiagnostic } from "./hubWorktreeLeaseDiagnostics.js";

export type HubRunWorkbenchPhase =
  | "loading"
  | "runtime_unavailable"
  | "empty"
  | "ready";

export type HubRunWorkbenchStageId =
  | "run_start"
  | "task_claim"
  | "implementation"
  | "review"
  | "verification"
  | "merge"
  | "close"
  | "failure"
  | "recovery";

export type HubRunWorkbenchStageState =
  | "pending"
  | "active"
  | "complete"
  | "failed"
  | "skipped";

export type HubRunWorkbenchTerminalPhase =
  | "no_events"
  | "running"
  | "passed"
  | "failed"
  | "completed";

export type HubRunWorkbenchGateKind =
  | "verification_failed"
  | "merge_conflict"
  | "close_failed"
  | "stale_claim"
  | "dirty_source";

export type HubRunWorkbenchActionKind = "bridge_preview" | "cli_only";

export type HubRunWorkbenchActionPriority = "primary" | "secondary" | "danger";

export interface HubRunWorkbenchGate {
  readonly kind: HubRunWorkbenchGateKind;
  readonly title: string;
  readonly message: string;
  readonly nextStep: string;
  readonly cliFallback: string;
}

export interface HubRunWorkbenchStage {
  readonly id: HubRunWorkbenchStageId;
  readonly label: string;
  readonly state: HubRunWorkbenchStageState;
  readonly detail?: string;
  readonly timestamp?: string;
}

export interface HubRunWorkbenchBatchMetadata {
  readonly runId: string;
  readonly batchId: string;
  readonly runDir: string;
  readonly flowId?: string;
  readonly branch?: string;
  readonly startedAt?: string;
  readonly batchStatus: HubProjectBatchSummary["status"];
  readonly batchStrategy?: string;
  readonly rationale?: string;
  readonly relatedCommits: readonly string[];
  readonly selectedTaskIds: readonly string[];
  readonly deferredTasks: readonly {
    readonly taskId: string;
    readonly reason: string;
  }[];
  readonly worktreeLeases: readonly {
    readonly taskId: string;
    readonly branch: string;
    readonly claimState?: string;
  }[];
}

export interface HubRunWorkbenchAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: HubRunWorkbenchActionKind;
  readonly priority: HubRunWorkbenchActionPriority;
  readonly bridgeAction?: HubRuntimePreviewAction;
  readonly bridgeParams?: Record<string, unknown>;
  readonly cliFallback: string;
  readonly disabledReason?: string;
}

export interface HubRunWorkbenchRunOption {
  readonly runId: string;
  readonly batchId: string;
  readonly label: string;
  readonly active: boolean;
}

export interface HubRunWorkbenchModel {
  readonly phase: HubRunWorkbenchPhase;
  readonly runtimeError?: string;
  readonly cliFallback?: string;
  readonly selectedRunId?: string;
  readonly selectedBatchId?: string;
  readonly runOptions: readonly HubRunWorkbenchRunOption[];
  readonly metadata?: HubRunWorkbenchBatchMetadata;
  readonly stages: readonly HubRunWorkbenchStage[];
  readonly gates: readonly HubRunWorkbenchGate[];
  readonly terminalPhase: HubRunWorkbenchTerminalPhase;
  readonly terminalLines: readonly string[];
  readonly actions: readonly HubRunWorkbenchAction[];
}

export interface HubRunEventsSnapshot {
  readonly runDir: string;
  readonly events: readonly HubRunEventRecord[];
}

export interface BuildHubRunWorkbenchModelInput {
  readonly loading?: boolean;
  readonly runtimeError?: string;
  readonly runSummaries?: readonly HubProjectRunSummary[];
  readonly eventsSnapshot?: HubRunEventsSnapshot;
  readonly projectStatus?: HubProjectStatus;
  readonly selectedRunId?: string;
  readonly selectedBatchId?: string;
}

const RUN_WORKBENCH_CLI_FALLBACK = "archloop run . --flow <id>";

const createEmptyRunWorkbenchContent = (): Pick<
  HubRunWorkbenchModel,
  | "runOptions"
  | "stages"
  | "gates"
  | "terminalPhase"
  | "terminalLines"
  | "actions"
> => ({
  runOptions: [],
  stages: [],
  gates: [],
  terminalPhase: "no_events",
  terminalLines: [],
  actions: [],
});

const createRunFlowCliFallback = (flowId?: string): string =>
  `archloop run . --flow ${flowId ?? "<id>"}`;

const STAGE_DEFINITIONS: readonly {
  readonly id: HubRunWorkbenchStageId;
  readonly label: string;
}[] = [
  { id: "run_start", label: "Run start" },
  { id: "task_claim", label: "Task claim" },
  { id: "implementation", label: "Implementation" },
  { id: "review", label: "Review" },
  { id: "verification", label: "Verification" },
  { id: "merge", label: "Merge" },
  { id: "close", label: "Close" },
  { id: "failure", label: "Failure" },
  { id: "recovery", label: "Recovery" },
];

const STAGE_TIMESTAMP_EVENT_TYPES: Readonly<
  Record<HubRunWorkbenchStageId, readonly string[]>
> = {
  run_start: ["run_started", "batch_started"],
  task_claim: ["task_claimed", "task_claim_skipped"],
  implementation: [
    "task_implementation_started",
    "task_implementation_succeeded",
    "task_implementation_failed",
  ],
  review: [
    "task_review_started",
    "task_review_succeeded",
    "task_review_failed",
  ],
  verification: [
    "verification_started",
    "verification_passed",
    "verification_failed",
  ],
  merge: [
    "batch_merge_started",
    "merge_started",
    "batch_merge_completed",
    "merge_failed",
    "merge_conflict_resolution_failed",
  ],
  close: ["task_close_started", "task_closed", "task_close_failed"],
  failure: [
    "task_implementation_failed",
    "verification_failed",
    "merge_failed",
    "merge_conflict_resolution_failed",
    "task_close_failed",
    "batch_merge_completed",
  ],
  recovery: ["task_recovered", "recover_started", "recover_completed"],
};

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readFirstString = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

const readStringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

const readCommitList = (value: unknown): readonly string[] => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      return readFirstString(readObject(entry), ["sha", "commitSha", "commit"]);
    })
    .filter(
      (entry): entry is string => entry !== undefined && entry.length > 0,
    );
};

const readEventTimestamp = (
  record: Readonly<Record<string, unknown>>,
): string | undefined =>
  readFirstString(record, ["createdAt", "startedAt", "timestamp"]);

const eventMatchesBatch = (
  record: Readonly<Record<string, unknown>>,
  batchId: string,
): boolean => {
  const eventBatchId = readFirstString(record, ["batchId", "batch_id"]);
  return eventBatchId === undefined || eventBatchId === batchId;
};

const filterBatchEvents = (
  events: readonly HubRunEventRecord[],
  batchId: string,
): readonly Record<string, unknown>[] =>
  events
    .map((entry) => readObject(entry.event))
    .filter((record) => eventMatchesBatch(record, batchId));

const hasEventType = (
  records: readonly Record<string, unknown>[],
  type: string,
): boolean => records.some((record) => record.type === type);

const hasAnyEventType = (
  records: readonly Record<string, unknown>[],
  types: readonly string[],
): boolean => types.some((type) => hasEventType(records, type));

const collectRelatedCommits = (
  batchEvents: readonly Record<string, unknown>[],
): readonly string[] => {
  const commits = new Set<string>();
  for (const record of batchEvents) {
    for (const value of [
      record.commits,
      record.commitShas,
      record.commitHashes,
      record.commitSha,
    ]) {
      for (const commit of readCommitList(value)) {
        commits.add(commit);
      }
    }
  }
  return [...commits];
};

const resolveStageTimestamp = (
  batchEvents: readonly Record<string, unknown>[],
  stageId: HubRunWorkbenchStageId,
): string | undefined => {
  for (const record of batchEvents) {
    const type = readFirstString(record, ["type"]);
    if (!type || !STAGE_TIMESTAMP_EVENT_TYPES[stageId].includes(type)) {
      continue;
    }
    const timestamp = readEventTimestamp(record);
    if (timestamp) {
      return timestamp;
    }
  }

  return undefined;
};

export const selectDefaultRunFocus = (
  runSummaries: readonly HubProjectRunSummary[],
  projectStatus?: HubProjectStatus,
): { readonly runId?: string; readonly batchId?: string } => {
  const activeFromStatus = projectStatus?.activeBatches.find(
    (batch) => batch.active,
  );
  if (activeFromStatus) {
    return {
      runId: activeFromStatus.runId,
      batchId: activeFromStatus.batchId,
    };
  }

  for (let index = runSummaries.length - 1; index >= 0; index -= 1) {
    const run = runSummaries[index];
    if (!run) {
      continue;
    }
    const activeBatch = [...run.batches]
      .reverse()
      .find((batch) => batch.active);
    if (activeBatch) {
      return { runId: run.runId, batchId: activeBatch.batchId };
    }
  }

  const latestRun = runSummaries[runSummaries.length - 1];
  const latestBatch = latestRun?.batches[latestRun.batches.length - 1];
  if (latestRun && latestBatch) {
    return { runId: latestRun.runId, batchId: latestBatch.batchId };
  }

  return {};
};

export const formatHubRunEventLine = (record: HubRunEventRecord): string => {
  const event = readObject(record.event);
  const type = readFirstString(event, ["type"]) ?? "event";
  const createdAt = readFirstString(event, ["createdAt", "startedAt"]) ?? "";
  const taskId = readFirstString(event, ["taskId", "task_id"]);
  const batchId = readFirstString(event, ["batchId", "batch_id"]);
  const status = readFirstString(event, ["status", "batchStatus"]);
  const message = readFirstString(event, ["message", "failureSummary"]);

  const parts = [
    createdAt,
    `[${record.file}:${record.lineNumber}]`,
    type,
    taskId ? `task=${taskId}` : undefined,
    batchId ? `batch=${batchId}` : undefined,
    status ? `status=${status}` : undefined,
    message,
  ].filter((part) => part !== undefined && part.length > 0);

  return parts.join(" ");
};

export const resolveHubRunWorkbenchGridClass = (
  viewportWidth: number,
): string =>
  viewportWidth < HUB_DESKTOP_LAYOUT.narrowBreakpointPx
    ? "hub-run-grid hub-run-grid-narrow"
    : "hub-run-grid";

const buildRunOptions = (
  runSummaries: readonly HubProjectRunSummary[],
): readonly HubRunWorkbenchRunOption[] =>
  runSummaries.flatMap((run) =>
    run.batches.map((batch) => ({
      runId: run.runId,
      batchId: batch.batchId,
      active: batch.active,
      label: `${run.runId}/${batch.batchId}${batch.flowId ? ` · ${batch.flowId}` : ""}`,
    })),
  );

const findSelectedBatch = (
  runSummaries: readonly HubProjectRunSummary[],
  runId: string,
  batchId: string,
):
  | {
      readonly run: HubProjectRunSummary;
      readonly batch: HubProjectBatchSummary;
    }
  | undefined => {
  const run = runSummaries.find((entry) => entry.runId === runId);
  const batch = run?.batches.find((entry) => entry.batchId === batchId);
  if (!run || !batch) {
    return undefined;
  }
  return { run, batch };
};

export const resolveRunBatchRunDir = (
  runSummaries: readonly HubProjectRunSummary[],
  runId: string,
  batchId: string,
): string | undefined =>
  findSelectedBatch(runSummaries, runId, batchId)?.batch.runDir;

const readDeferredTasks = (
  plannedRecord: Readonly<Record<string, unknown>>,
): readonly { taskId: string; reason: string }[] => {
  const deferred = plannedRecord.deferredTasks;
  if (!Array.isArray(deferred)) {
    return [];
  }
  return deferred
    .map((entry) => readObject(entry))
    .map((entry) => ({
      taskId: readFirstString(entry, ["taskId", "task_id"]) ?? "",
      reason: readFirstString(entry, ["reason"]) ?? "deferred",
    }))
    .filter((entry) => entry.taskId.length > 0);
};

const buildMetadata = (
  run: HubProjectRunSummary,
  batch: HubProjectBatchSummary,
  batchEvents: readonly Record<string, unknown>[],
  worktreeLeases: HubRunWorkbenchBatchMetadata["worktreeLeases"],
): HubRunWorkbenchBatchMetadata => {
  const plannedEvent = batchEvents.find(
    (record) => record.type === "batch_planned",
  );
  const plannedRecord = readObject(plannedEvent);
  const relatedCommits = collectRelatedCommits(batchEvents);
  const plannedCommits = readCommitList(
    plannedRecord.commits ??
      plannedRecord.commitShas ??
      plannedRecord.commitHashes,
  );
  const startedEvent = batchEvents.find(
    (record) =>
      record.type === "batch_started" || record.type === "run_started",
  );
  const startedRecord = readObject(startedEvent);

  return {
    runId: run.runId,
    batchId: batch.batchId,
    runDir: batch.runDir,
    flowId: batch.flowId,
    branch: run.branch ?? readFirstString(startedRecord, ["branch"]),
    startedAt: run.startedAt ?? readFirstString(startedRecord, ["startedAt"]),
    batchStatus: batch.status,
    batchStrategy:
      readFirstString(plannedRecord, [
        "batchStrategyUsed",
        "batchStrategyRequested",
        "batch_strategy_used",
      ]) ?? undefined,
    rationale: readFirstString(plannedRecord, ["rationale"]),
    relatedCommits: relatedCommits.length > 0 ? relatedCommits : plannedCommits,
    selectedTaskIds: readStringArray(plannedRecord.taskIds),
    deferredTasks: readDeferredTasks(plannedRecord),
    worktreeLeases,
  };
};

const resolveReviewStageState = (
  batchEvents: readonly Record<string, unknown>[],
  flowId: string | undefined,
): HubRunWorkbenchStageState => {
  if (flowId?.includes("no-review")) {
    return "skipped";
  }
  if (hasEventType(batchEvents, "task_review_failed")) {
    return "failed";
  }
  if (hasEventType(batchEvents, "task_review_succeeded")) {
    return "complete";
  }
  if (hasEventType(batchEvents, "task_review_started")) {
    return "active";
  }
  return "pending";
};

const buildStages = (
  batchEvents: readonly Record<string, unknown>[],
  metadata: HubRunWorkbenchBatchMetadata,
  hasRecoverableFailure: boolean,
): readonly HubRunWorkbenchStage[] => {
  const implementationFailed = hasEventType(
    batchEvents,
    "task_implementation_failed",
  );
  const verificationFailed = hasEventType(batchEvents, "verification_failed");
  const mergeFailed = hasAnyEventType(batchEvents, [
    "merge_failed",
    "merge_conflict_resolution_failed",
    "batch_merge_completed",
  ]);
  const closeFailed = hasEventType(batchEvents, "task_close_failed");
  const batchDone =
    metadata.batchStatus === "done" ||
    hasEventType(batchEvents, "batch_merge_completed");

  const stageState = (
    id: HubRunWorkbenchStageId,
  ): { state: HubRunWorkbenchStageState; detail?: string } => {
    switch (id) {
      case "run_start":
        if (hasAnyEventType(batchEvents, ["run_started", "batch_started"])) {
          return { state: "complete" };
        }
        return metadata.batchStatus === "started"
          ? { state: "active" }
          : { state: "pending" };
      case "task_claim":
        if (hasEventType(batchEvents, "task_claim_skipped")) {
          return {
            state: "failed",
            detail: "One or more task claims were skipped",
          };
        }
        if (
          metadata.selectedTaskIds.length > 0 &&
          hasEventType(batchEvents, "task_claimed")
        ) {
          return { state: "complete" };
        }
        return hasEventType(batchEvents, "batch_planned")
          ? { state: "active" }
          : { state: "pending" };
      case "implementation":
        if (implementationFailed) {
          return { state: "failed", detail: "Implementation failed" };
        }
        if (hasEventType(batchEvents, "task_implementation_succeeded")) {
          return { state: "complete" };
        }
        if (hasEventType(batchEvents, "task_implementation_started")) {
          return { state: "active" };
        }
        return { state: "pending" };
      case "review": {
        const state = resolveReviewStageState(batchEvents, metadata.flowId);
        return { state };
      }
      case "verification":
        if (verificationFailed) {
          return { state: "failed", detail: "Verification failed" };
        }
        if (hasEventType(batchEvents, "verification_passed")) {
          return { state: "complete" };
        }
        if (hasEventType(batchEvents, "verification_started")) {
          return { state: "active" };
        }
        return { state: "pending" };
      case "merge":
        if (
          hasAnyEventType(batchEvents, [
            "merge_conflict_resolution_failed",
            "merge_failed",
          ])
        ) {
          return { state: "failed", detail: "Merge blocked" };
        }
        if (batchDone) {
          return { state: "complete" };
        }
        if (
          hasAnyEventType(batchEvents, ["batch_merge_started", "merge_started"])
        ) {
          return { state: "active" };
        }
        return { state: "pending" };
      case "close":
        if (closeFailed) {
          return { state: "failed", detail: "Task close failed" };
        }
        if (hasEventType(batchEvents, "task_closed")) {
          return { state: "complete" };
        }
        if (hasEventType(batchEvents, "task_close_started")) {
          return { state: "active" };
        }
        return { state: "pending" };
      case "failure": {
        const failed =
          implementationFailed ||
          verificationFailed ||
          mergeFailed ||
          closeFailed ||
          metadata.batchStatus === "partial_failed";
        if (!failed) {
          return { state: "pending" };
        }
        return batchDone
          ? { state: "complete", detail: "Failures recorded in run events" }
          : { state: "active", detail: "Run has failing stages" };
      }
      case "recovery":
        if (!hasRecoverableFailure) {
          return { state: "pending" };
        }
        return {
          state: "active",
          detail: "Recover failed tasks to continue",
        };
      default:
        return { state: "pending" };
    }
  };

  return STAGE_DEFINITIONS.map((definition) => {
    const resolved = stageState(definition.id);
    return {
      id: definition.id,
      label: definition.label,
      state: resolved.state,
      detail: resolved.detail,
      timestamp: resolveStageTimestamp(batchEvents, definition.id),
    };
  });
};

const buildGates = (
  batchEvents: readonly Record<string, unknown>[],
  leaseDiagnostics: readonly HubWorktreeLeaseDiagnostic[],
  metadata: HubRunWorkbenchBatchMetadata,
): readonly HubRunWorkbenchGate[] => {
  const gates: HubRunWorkbenchGate[] = [];

  if (hasEventType(batchEvents, "verification_failed")) {
    gates.push({
      kind: "verification_failed",
      title: "Verification failed",
      message: "Hub verification did not pass for this batch.",
      nextStep:
        "Inspect verification output, fix the repo, then rerun the flow.",
      cliFallback: createRunFlowCliFallback(metadata.flowId),
    });
  }

  if (
    hasAnyEventType(batchEvents, [
      "merge_conflict_resolution_failed",
      "merge_failed",
    ])
  ) {
    gates.push({
      kind: "merge_conflict",
      title: "Merge conflict",
      message: "Merge selection or conflict resolution failed.",
      nextStep:
        "Resolve conflicts in the worktree, then resume merge with the same flow.",
      cliFallback: createRunFlowCliFallback(metadata.flowId),
    });
  }

  if (hasEventType(batchEvents, "task_close_failed")) {
    gates.push({
      kind: "close_failed",
      title: "Task close failed",
      message: "Hub could not close one or more tasks after merge.",
      nextStep: "Review task close events, repair task state, then recover.",
      cliFallback: "archloop tasks doctor",
    });
  }

  const dirtySkip = batchEvents.find((record) => {
    if (record.type !== "task_claim_skipped") {
      return false;
    }
    const reason = readFirstString(record, ["reason", "message"]) ?? "";
    return reason.toLowerCase().includes("dirty");
  });
  if (dirtySkip) {
    gates.push({
      kind: "dirty_source",
      title: "Dirty source gate",
      message:
        readFirstString(dirtySkip, ["message"]) ??
        "Dirty source files blocked task claim or merge.",
      nextStep:
        "Commit, stash, or revert dirty source files, then rerun the same flow.",
      cliFallback: createRunFlowCliFallback(metadata.flowId),
    });
  }

  for (const diagnostic of leaseDiagnostics) {
    if (
      diagnostic.reason === "worktree_lease_stale_with_failed_claim" ||
      diagnostic.claimState === "stale"
    ) {
      gates.push({
        kind: "stale_claim",
        title: "Stale claim metadata",
        message: diagnostic.message,
        nextStep: diagnostic.nextAction,
        cliFallback: `archloop tasks recover ${diagnostic.taskId}`,
      });
    }
  }

  return gates;
};

const resolveTerminalPhase = (
  batchEvents: readonly Record<string, unknown>[],
  batchStatus: HubProjectBatchSummary["status"],
  eventCount: number,
): HubRunWorkbenchTerminalPhase => {
  if (eventCount === 0) {
    return "no_events";
  }
  if (hasEventType(batchEvents, "verification_failed")) {
    return "failed";
  }
  if (
    hasAnyEventType(batchEvents, [
      "task_implementation_failed",
      "merge_failed",
      "task_close_failed",
    ])
  ) {
    return "failed";
  }
  if (
    batchStatus === "done" &&
    hasEventType(batchEvents, "verification_passed")
  ) {
    return "passed";
  }
  if (batchStatus === "done" || batchStatus === "partial_failed") {
    return "completed";
  }
  return "running";
};

const buildActions = (
  metadata: HubRunWorkbenchBatchMetadata,
  projectStatus: HubProjectStatus | undefined,
  hasRecoverableFailure: boolean,
): readonly HubRunWorkbenchAction[] => {
  const actions: HubRunWorkbenchAction[] = [];

  actions.push({
    id: "cancel-run",
    label: "Cancel Run",
    description:
      "Stop the active run and recover through the CLI if the batch must be abandoned.",
    kind: "cli_only",
    priority: "danger",
    cliFallback: "archloop run cancel <run-id>",
    disabledReason:
      "Run cancellation has no desktop preview/confirm path in v0. Use CLI or wait for the batch to finish.",
  });

  if (hasRecoverableFailure && projectStatus) {
    const selectedTaskIds = new Set(metadata.selectedTaskIds);
    const recoverableTask =
      projectStatus.failedTasks.find((task) => selectedTaskIds.has(task.id)) ??
      projectStatus.failedTasks[0];

    if (recoverableTask) {
      actions.push({
        id: "recover-task",
        label: "Recover Task",
        description: recoverableTask.nextAction,
        kind: "bridge_preview",
        priority: "primary",
        bridgeAction: "recover.preview",
        bridgeParams: { taskId: recoverableTask.id },
        cliFallback: `archloop tasks recover ${recoverableTask.id}`,
      });
    }
  }

  actions.push({
    id: "resume-merge",
    label: "Resume Merge",
    description:
      "Resume an unfinished merge-ready batch for this flow before claiming new tasks.",
    kind: "cli_only",
    priority: "secondary",
    cliFallback: createRunFlowCliFallback(metadata.flowId),
    disabledReason:
      metadata.batchStatus === "merging"
        ? undefined
        : "Resume merge is available when a batch is merge-ready. Re-run the same flow from the CLI in v0.",
  });

  return actions;
};

export const buildHubRunWorkbenchModel = (
  input: BuildHubRunWorkbenchModelInput,
): HubRunWorkbenchModel => {
  if (input.loading) {
    return {
      phase: "loading",
      ...createEmptyRunWorkbenchContent(),
    };
  }

  if (input.runtimeError) {
    return {
      phase: "runtime_unavailable",
      runtimeError: input.runtimeError,
      cliFallback: RUN_WORKBENCH_CLI_FALLBACK,
      ...createEmptyRunWorkbenchContent(),
    };
  }

  const runSummaries = input.runSummaries ?? [];
  const runOptions = buildRunOptions(runSummaries);
  if (runOptions.length === 0) {
    return {
      phase: "empty",
      cliFallback: RUN_WORKBENCH_CLI_FALLBACK,
      ...createEmptyRunWorkbenchContent(),
    };
  }

  const defaultFocus = selectDefaultRunFocus(runSummaries, input.projectStatus);
  const runId = input.selectedRunId ?? defaultFocus.runId;
  const batchId = input.selectedBatchId ?? defaultFocus.batchId;
  if (!runId || !batchId) {
    return {
      phase: "empty",
      cliFallback: RUN_WORKBENCH_CLI_FALLBACK,
      ...createEmptyRunWorkbenchContent(),
      runOptions,
    };
  }

  const selected = findSelectedBatch(runSummaries, runId, batchId);
  if (!selected) {
    return {
      phase: "empty",
      cliFallback: RUN_WORKBENCH_CLI_FALLBACK,
      ...createEmptyRunWorkbenchContent(),
      runOptions,
      selectedRunId: runId,
      selectedBatchId: batchId,
    };
  }

  const events = input.eventsSnapshot?.events ?? [];
  const batchEvents = filterBatchEvents(events, batchId);
  const worktreeLeases = (
    input.projectStatus?.worktreeLeaseDiagnostics ?? []
  ).map((diagnostic) => ({
    taskId: diagnostic.taskId,
    branch: diagnostic.branch,
    claimState: diagnostic.claimState,
  }));

  const metadata = buildMetadata(
    selected.run,
    selected.batch,
    batchEvents,
    worktreeLeases,
  );

  const hasRecoverableFailure =
    selected.batch.status === "partial_failed" ||
    batchEvents.some((record) => record.type?.toString().endsWith("_failed")) ||
    (input.projectStatus?.failedTasks.length ?? 0) > 0;

  const stages = buildStages(batchEvents, metadata, hasRecoverableFailure);
  const gates = buildGates(
    batchEvents,
    input.projectStatus?.worktreeLeaseDiagnostics ?? [],
    metadata,
  );
  const terminalLines = events.map(formatHubRunEventLine);
  const terminalPhase = resolveTerminalPhase(
    batchEvents,
    metadata.batchStatus,
    events.length,
  );
  const actions = buildActions(
    metadata,
    input.projectStatus,
    hasRecoverableFailure,
  );

  return {
    phase: "ready",
    cliFallback: RUN_WORKBENCH_CLI_FALLBACK,
    selectedRunId: runId,
    selectedBatchId: batchId,
    runOptions,
    metadata,
    stages,
    gates,
    terminalPhase,
    terminalLines,
    actions,
  };
};
