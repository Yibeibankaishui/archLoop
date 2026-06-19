import {
  appendHubTaskEvent,
  recordHubTaskStatusAdvanced,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  claimHubTask,
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

export interface RecordImplementationOutcomeResult {
  readonly task: HubTaskProjection;
  readonly hubStatus: HubTaskStatus;
}

export interface RecordImplementationFailureInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly context: HubTaskLifecycleContext;
  readonly taskId: string;
  readonly branch: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly claim: HubTaskClaimMetadata;
  readonly failureReason: Extract<
    HubFailureReason,
    "agent_failed" | "sandbox_failed"
  >;
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
      readonly status: HubTaskStatus;
      readonly hubStatus: HubTaskStatus;
    }
  | {
      readonly type: "task_implementation_failed";
      readonly status: "failed";
      readonly hubStatus: "failed";
      readonly failureReason: Extract<
        HubFailureReason,
        "agent_failed" | "sandbox_failed"
      >;
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

const recordImplementationOutcome = (
  input: RecordImplementationOutcomeInput,
  outcome: ImplementationOutcomeEvent,
): RecordImplementationOutcomeResult => {
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
    status: outcome.status,
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
    metadata: input.metadata,
    ...(failureReason === undefined ? {} : { failureReason }),
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

  return {
    task: updatedTask,
    hubStatus: updatedTask.hubStatus,
  };
};

export const recordImplementationSuccess = (
  input: RecordImplementationSuccessInput,
): RecordImplementationOutcomeResult => {
  const postImplementationStatus = resolvePostImplementationStatus(
    input.hasReviewer,
  );

  return recordImplementationOutcome(input, {
    type: "task_implementation_succeeded",
    status: postImplementationStatus,
    hubStatus: postImplementationStatus,
  });
};

export const recordImplementationFailure = (
  input: RecordImplementationFailureInput,
): RecordImplementationOutcomeResult =>
  recordImplementationOutcome(input, {
    type: "task_implementation_failed",
    status: "failed",
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
    metadata: input.taskMetadata,
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
