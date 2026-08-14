import {
  appendHubTaskEvent,
  recordHubTaskStatusAdvanced,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  claimHubTask,
  closeHubTask,
  HUB_COLLABORATION_LABELS_TO_CLEAR,
  isCompletedHubStatus,
  loadHubTask,
  updateHubTaskStatus,
  type ClaimHubTaskInput,
  type ClaimHubTaskResult,
  type HubFailureReason,
  type HubTaskProjection,
  type HubTaskStatus,
} from "./taskBoard.js";

export interface HubTaskLifecycleContext {
  readonly runId: string;
  readonly batchId: string;
  readonly runDir: string;
}

export interface HubTaskLifecycleResult {
  readonly task: HubTaskProjection;
  readonly hubStatus: HubTaskStatus;
  readonly failureReason?: HubFailureReason;
}

const toHubTaskLifecycleResult = (
  task: HubTaskProjection,
): HubTaskLifecycleResult => ({
  task,
  hubStatus: task.hubStatus,
});

type ImplementationFailureReason = Extract<
  HubFailureReason,
  "agent_failed" | "sandbox_failed"
>;

export const claimHubTaskForImplementation = (
  input: ClaimHubTaskInput,
): ClaimHubTaskResult => claimHubTask(input);

export interface RecordImplementationStartedInput {
  readonly context: HubTaskLifecycleContext;
  readonly taskId: string;
  readonly branch: string;
  readonly hubStatus: HubTaskStatus;
  readonly claim: HubTaskClaimMetadata;
  readonly createdAt: string;
}

export const recordImplementationStarted = (
  input: RecordImplementationStartedInput,
): void => {
  appendHubTaskEvent(input.context.runDir, {
    type: "task_implementation_started",
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: input.hubStatus,
    claim: input.claim,
  });
};

export interface RecordImplementationSuccessInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly context: HubTaskLifecycleContext;
  readonly taskId: string;
  readonly branch: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly claim: HubTaskClaimMetadata;
  readonly commitCount: number;
  readonly hasReviewer: boolean;
  readonly branchHasUnmergedWork?: boolean;
  readonly implementationWork?: "new_commits" | "existing_unmerged_work";
  readonly createdAt: string;
}

export interface RecordImplementationFailureInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly context: HubTaskLifecycleContext;
  readonly taskId: string;
  readonly branch: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly claim: HubTaskClaimMetadata;
  readonly failureReason: ImplementationFailureReason;
  readonly commitCount: number;
  readonly createdAt: string;
}

export interface RecordHubTaskSyncConflictInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly reason: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RecordHubTaskSyncConflictResult {
  readonly hubStatus: HubTaskProjection["hubStatus"];
  readonly preservedCompletion: boolean;
  readonly task: HubTaskProjection;
}

export interface HubTaskLifecycleRunContext {
  readonly cwd: string;
  readonly runDir: string;
  readonly runId: string;
  readonly batchId: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface RecordHubTaskReviewBaseInput extends HubTaskLifecycleRunContext {
  readonly taskId: string;
  readonly branch: string;
  readonly taskMetadata: Readonly<Record<string, unknown>>;
  readonly claim: HubTaskClaimMetadata;
  readonly commitCount: number;
  readonly createdAt: string;
}

export interface RecordHubTaskReviewSuccessInput extends RecordHubTaskReviewBaseInput {}

export interface RecordHubTaskReviewSuccessResult {
  readonly hubStatus: HubTaskProjection["hubStatus"];
  readonly outcome: "reviewed";
  readonly task: HubTaskProjection;
}

export interface RecordHubTaskReviewFailureInput extends RecordHubTaskReviewBaseInput {
  readonly failureReason: HubFailureReason;
}

export interface RecordHubTaskReviewFailureResult {
  readonly hubStatus: HubTaskProjection["hubStatus"];
  readonly failureReason: HubFailureReason;
  readonly outcome: "agent_failed" | "sandbox_failed";
  readonly task: HubTaskProjection;
}
export interface EnterMergePhaseInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tasks: readonly HubTaskProjection[];
}

export interface RecordTaskMergeStartedInput {
  readonly context: HubTaskLifecycleContext;
  readonly taskId: string;
  readonly branch: string;
  readonly claim?: HubTaskClaimMetadata;
  readonly createdAt: string;
}

export interface RecordMergePhaseFailureInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly context: HubTaskLifecycleContext;
  readonly taskId: string;
  readonly branch: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly claim?: HubTaskClaimMetadata;
  readonly createdAt: string;
  readonly diagnosticSummary?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export interface RecordMergeFailureInput extends RecordMergePhaseFailureInput {
  readonly failureReason: Extract<
    HubFailureReason,
    "merge_conflict" | "merge_failed" | "unknown"
  >;
  readonly diagnosticSummary?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export type HubLandingRepairExhaustionReason =
  | "merge_conflict_unresolved"
  | "verification_failed";

export interface RecordRepairExhaustionInput extends RecordMergePhaseFailureInput {
  readonly reason: HubLandingRepairExhaustionReason;
}

export interface CloseHubTaskInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}

export type HubTaskCloser = (
  input: CloseHubTaskInput,
) => Promise<HubTaskProjection>;

export interface RecordTaskClosureInput extends RecordMergePhaseFailureInput {
  readonly closer?: HubTaskCloser;
}

export interface RevertTaskToWaitingForMergeInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly task: HubTaskProjection;
}

type RecordImplementationOutcomeInput = Readonly<{
  cwd: string;
  env?: NodeJS.ProcessEnv;
  context: HubTaskLifecycleContext;
  taskId: string;
  branch: string;
  metadata: Readonly<Record<string, unknown>>;
  claim: HubTaskClaimMetadata;
  commitCount: number;
  branchHasUnmergedWork?: boolean;
  implementationWork?: "new_commits" | "existing_unmerged_work";
  createdAt: string;
}>;

type ImplementationOutcomeEvent =
  | {
      readonly type: "task_implementation_succeeded";
      readonly hubStatus: HubTaskStatus;
    }
  | {
      readonly type: "task_implementation_failed";
      readonly hubStatus: "failed";
      readonly failureReason: ImplementationFailureReason;
    };

const resolvePostImplementationStatus = (
  hasReviewer: boolean,
): HubTaskStatus => (hasReviewer ? "reviewing" : "waiting_for_merge");

const reviewFailureOutcome = (
  failureReason: HubFailureReason,
): RecordHubTaskReviewFailureResult["outcome"] => {
  if (failureReason === "sandbox_failed") {
    return "sandbox_failed";
  }
  return "agent_failed";
};

const materializeClaimMetadata = (
  claim: HubTaskClaimMetadata,
): Readonly<Record<string, unknown>> =>
  Object.keys(claim.raw).length > 0
    ? claim.raw
    : {
        runId: claim.runId,
        batchId: claim.batchId,
        branch: claim.branch,
        claimedAt: claim.claimedAt,
      };

const recordImplementationOutcome = (
  input: RecordImplementationOutcomeInput,
  outcome: ImplementationOutcomeEvent,
): HubTaskLifecycleResult => {
  const failureReason =
    outcome.type === "task_implementation_failed"
      ? outcome.failureReason
      : undefined;

  appendHubTaskEvent(input.context.runDir, {
    type: outcome.type,
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: outcome.hubStatus,
    failureReason,
    commitCount: input.commitCount,
    ...(input.branchHasUnmergedWork === undefined
      ? {}
      : { branchHasUnmergedWork: input.branchHasUnmergedWork }),
    ...(input.implementationWork === undefined
      ? {}
      : { implementationWork: input.implementationWork }),
    claim: input.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: outcome.hubStatus,
    metadata: {
      ...input.metadata,
      claim: materializeClaimMetadata(input.claim),
    },
    ...(failureReason ? { failureReason } : {}),
    env: input.env,
  });

  recordHubTaskStatusAdvanced(input.context.runDir, {
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
    failureReason,
    commitCount: input.commitCount,
    ...(input.branchHasUnmergedWork === undefined
      ? {}
      : { branchHasUnmergedWork: input.branchHasUnmergedWork }),
    ...(input.implementationWork === undefined
      ? {}
      : { implementationWork: input.implementationWork }),
  });

  return toHubTaskLifecycleResult(updatedTask);
};

export const recordImplementationSuccess = (
  input: RecordImplementationSuccessInput,
): HubTaskLifecycleResult => {
  const postImplementationStatus = resolvePostImplementationStatus(
    input.hasReviewer,
  );

  return recordImplementationOutcome(input, {
    type: "task_implementation_succeeded",
    hubStatus: postImplementationStatus,
  });
};

export const recordImplementationFailure = (
  input: RecordImplementationFailureInput,
): HubTaskLifecycleResult =>
  recordImplementationOutcome(input, {
    type: "task_implementation_failed",
    hubStatus: "failed",
    failureReason: input.failureReason,
  });

export const recordHubTaskReviewSuccess = (
  input: RecordHubTaskReviewSuccessInput,
): RecordHubTaskReviewSuccessResult => {
  appendHubTaskEvent(input.runDir, {
    type: "task_review_succeeded",
    runId: input.runId,
    batchId: input.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: "waiting_for_merge",
    commitCount: input.commitCount,
    claim: input.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: "waiting_for_merge",
    metadata: {
      ...input.taskMetadata,
      claim: materializeClaimMetadata(input.claim),
    },
    env: input.env,
  });
  recordHubTaskStatusAdvanced(input.runDir, {
    runId: input.runId,
    batchId: input.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
    commitCount: input.commitCount,
  });

  return {
    hubStatus: updatedTask.hubStatus,
    outcome: "reviewed",
    task: updatedTask,
  };
};

export const recordHubTaskReviewFailure = (
  input: RecordHubTaskReviewFailureInput,
): RecordHubTaskReviewFailureResult => {
  appendHubTaskEvent(input.runDir, {
    type: "task_review_failed",
    runId: input.runId,
    batchId: input.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: "failed",
    failureReason: input.failureReason,
    commitCount: input.commitCount,
    claim: input.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: "failed",
    metadata: input.taskMetadata,
    failureReason: input.failureReason,
    env: input.env,
  });
  recordHubTaskStatusAdvanced(input.runDir, {
    runId: input.runId,
    batchId: input.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
    failureReason: input.failureReason,
    commitCount: input.commitCount,
  });

  return {
    hubStatus: updatedTask.hubStatus,
    failureReason: input.failureReason,
    outcome: reviewFailureOutcome(input.failureReason),
    task: updatedTask,
  };
};

type MergePhaseFailureEvent =
  | {
      readonly type: "merge_failed";
      readonly failureReason: Extract<
        HubFailureReason,
        "merge_conflict" | "merge_failed" | "unknown"
      >;
    }
  | {
      readonly type: "verification_failed";
      readonly failureReason: "verification_failure";
    }
  | {
      readonly type: "task_close_failed";
      readonly failureReason: "close_failed";
    };

const recordMergePhaseFailure = (
  input: RecordMergePhaseFailureInput,
  outcome: MergePhaseFailureEvent,
  diagnostics?: {
    readonly diagnosticSummary?: string;
    readonly diagnostics?: Readonly<Record<string, unknown>>;
  },
): HubTaskLifecycleResult => {
  appendHubTaskEvent(input.context.runDir, {
    type: outcome.type,
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: "failed",
    failureReason: outcome.failureReason,
    diagnosticSummary: diagnostics?.diagnosticSummary,
    diagnostics: diagnostics?.diagnostics,
    claim: input.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: "failed",
    metadata: input.metadata,
    failureReason: outcome.failureReason,
    env: input.env,
  });

  recordHubTaskStatusAdvanced(input.context.runDir, {
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
    failureReason: outcome.failureReason,
  });

  return {
    task: updatedTask,
    hubStatus: updatedTask.hubStatus,
    failureReason: outcome.failureReason,
  };
};

export const enterMergePhase = (input: EnterMergePhaseInput): void => {
  for (const task of input.tasks) {
    updateHubTaskStatus({
      cwd: input.cwd,
      taskId: task.id,
      hubStatus: "merging",
      metadata: task.metadata,
      env: input.env,
    });
  }
};

export const recordTaskMergeStarted = (
  input: RecordTaskMergeStartedInput,
): void => {
  appendHubTaskEvent(input.context.runDir, {
    type: "merge_started",
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: "merging",
    claim: input.claim,
  });
};

export const recordMergeFailure = (
  input: RecordMergeFailureInput,
): HubTaskLifecycleResult =>
  recordMergePhaseFailure(
    input,
    {
      type: "merge_failed",
      failureReason: input.failureReason,
    },
    {
      diagnosticSummary: input.diagnosticSummary,
      diagnostics: input.diagnostics,
    },
  );

export const recordVerificationFailure = (
  input: RecordMergePhaseFailureInput,
): HubTaskLifecycleResult =>
  recordMergePhaseFailure(
    input,
    {
      type: "verification_failed",
      failureReason: "verification_failure",
    },
    {
      diagnosticSummary: input.diagnosticSummary,
      diagnostics: input.diagnostics,
    },
  );

export const recordRepairExhaustion = (
  input: RecordRepairExhaustionInput,
): HubTaskLifecycleResult => {
  const eventType =
    input.reason === "merge_conflict_unresolved"
      ? "merge_failed"
      : "verification_failed";
  appendHubTaskEvent(input.context.runDir, {
    type: eventType,
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: "blocked",
    reason: input.reason,
    diagnosticSummary: input.diagnosticSummary,
    diagnostics: input.diagnostics,
    claim: input.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: "blocked",
    metadata: {
      ...input.metadata,
      blocked: true,
      blocked_reason: input.reason,
      blockedReason: input.reason,
    },
    env: input.env,
  });

  recordHubTaskStatusAdvanced(input.context.runDir, {
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
  });

  return {
    task: updatedTask,
    hubStatus: updatedTask.hubStatus,
  };
};

export const recordCloseFailure = (
  input: RecordMergePhaseFailureInput,
): HubTaskLifecycleResult =>
  recordMergePhaseFailure(input, {
    type: "task_close_failed",
    failureReason: "close_failed",
  });

const defaultCloseHubTask: HubTaskCloser = async (closeInput) =>
  closeHubTask({
    cwd: closeInput.cwd,
    taskId: closeInput.taskId,
    metadata: closeInput.metadata,
    env: closeInput.env,
  });

export const recordTaskClosure = async (
  input: RecordTaskClosureInput,
): Promise<HubTaskLifecycleResult> => {
  const closer = input.closer ?? defaultCloseHubTask;

  const closedTask = await closer({
    cwd: input.cwd,
    taskId: input.taskId,
    metadata: input.metadata,
    env: input.env,
  });

  appendHubTaskEvent(input.context.runDir, {
    type: "task_closed",
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: closedTask.hubStatus,
    claim: input.claim,
  });

  recordHubTaskStatusAdvanced(input.context.runDir, {
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: closedTask.hubStatus,
  });

  return {
    task: closedTask,
    hubStatus: closedTask.hubStatus,
  };
};

export const revertTaskToWaitingForMerge = (
  input: RevertTaskToWaitingForMergeInput,
): HubTaskProjection =>
  updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.task.id,
    hubStatus: "waiting_for_merge",
    metadata: input.task.metadata,
    env: input.env,
  });

export const recordHubTaskSyncConflict = (
  input: RecordHubTaskSyncConflictInput,
): RecordHubTaskSyncConflictResult => {
  const task = loadHubTask(input.cwd, input.taskId, input.env);
  const preservedCompletion = isCompletedHubStatus(task.hubStatus);
  const metadata = {
    sync_state: "conflict" as const,
    sync_conflict_reason: input.reason,
  };
  const labelsToRemove = preservedCompletion
    ? undefined
    : HUB_COLLABORATION_LABELS_TO_CLEAR.filter((label) =>
        task.labels.includes(label),
      );

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: preservedCompletion ? task.hubStatus : "sync_conflict",
    metadata,
    labelsToRemove,
    env: input.env,
  });

  return {
    hubStatus: updatedTask.hubStatus,
    preservedCompletion,
    task: updatedTask,
  };
};

const stripClaimMetadata = (
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const next = { ...metadata };
  delete next.claim;
  return next;
};

export interface ReleaseStaleHubTaskClaimInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly hubStatus: HubTaskStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}

const persistHubTaskWithStrippedClaim = (input: {
  readonly cwd: string;
  readonly taskId: string;
  readonly hubStatus: HubTaskStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}): HubTaskLifecycleResult => {
  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: input.hubStatus,
    metadata: stripClaimMetadata(input.metadata),
    env: input.env,
  });

  return toHubTaskLifecycleResult(updatedTask);
};

export const releaseStaleHubTaskClaim = (
  input: ReleaseStaleHubTaskClaimInput,
): HubTaskLifecycleResult =>
  persistHubTaskWithStrippedClaim({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: input.hubStatus,
    metadata: input.metadata,
    env: input.env,
  });

export interface RecoverFailedHubTaskInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly targetStatus: HubTaskStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}

export const recoverFailedHubTask = (
  input: RecoverFailedHubTaskInput,
): HubTaskLifecycleResult =>
  persistHubTaskWithStrippedClaim({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: input.targetStatus,
    metadata: input.metadata,
    env: input.env,
  });

export interface CompleteCloseFailedRecoveryInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}

export const completeCloseFailedRecovery = (
  input: CompleteCloseFailedRecoveryInput,
): HubTaskLifecycleResult => {
  const closedTask = closeHubTask({
    cwd: input.cwd,
    taskId: input.taskId,
    metadata: input.metadata,
    env: input.env,
  });

  return toHubTaskLifecycleResult(closedTask);
};
