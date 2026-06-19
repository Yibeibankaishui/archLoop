import {
  appendHubTaskEvent,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  claimHubTask,
  closeHubTask,
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
  readonly createdAt: string;
}

export interface RecordImplementationOutcomeResult {
  readonly task: HubTaskProjection;
  readonly hubStatus: HubTaskStatus;
}

export interface HubTaskLifecycleResult {
  readonly task: HubTaskProjection;
  readonly hubStatus: HubTaskStatus;
  readonly failureReason?: HubFailureReason;
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
}

export interface RecordMergeFailureInput extends RecordMergePhaseFailureInput {
  readonly failureReason: Extract<
    HubFailureReason,
    "merge_conflict" | "unknown"
  >;
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

type RecordImplementationOutcomeInput = Readonly<{
  cwd: string;
  env?: NodeJS.ProcessEnv;
  context: HubTaskLifecycleContext;
  taskId: string;
  branch: string;
  metadata: Readonly<Record<string, unknown>>;
  claim: HubTaskClaimMetadata;
  commitCount: number;
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

const recordTaskStatusAdvanced = (
  runDir: string,
  input: {
    readonly runId: string;
    readonly batchId: string;
    readonly taskId: string;
    readonly branch: string;
    readonly createdAt: string;
    readonly status: string;
    readonly failureReason?: string;
    readonly commitCount?: number;
  },
): void => {
  appendHubTaskEvent(runDir, {
    type: "task_status_advanced",
    runId: input.runId,
    batchId: input.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: input.status,
    failureReason: input.failureReason,
    commitCount: input.commitCount,
  });
};

const resolvePostImplementationStatus = (
  hasReviewer: boolean,
): HubTaskStatus => (hasReviewer ? "reviewing" : "waiting_for_merge");

const recordImplementationOutcome = (
  input: RecordImplementationOutcomeInput,
  outcome: ImplementationOutcomeEvent,
): RecordImplementationOutcomeResult => {
  appendHubTaskEvent(input.context.runDir, {
    type: outcome.type,
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: outcome.status,
    failureReason:
      outcome.type === "task_implementation_failed"
        ? outcome.failureReason
        : undefined,
    commitCount: input.commitCount,
    claim: input.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: outcome.hubStatus,
    metadata: input.metadata,
    ...(outcome.type === "task_implementation_failed"
      ? { failureReason: outcome.failureReason }
      : {}),
    env: input.env,
  });

  recordTaskStatusAdvanced(input.context.runDir, {
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
    failureReason:
      outcome.type === "task_implementation_failed"
        ? outcome.failureReason
        : undefined,
    commitCount: input.commitCount,
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

type MergePhaseFailureEvent =
  | {
      readonly type: "merge_failed";
      readonly failureReason: Extract<
        HubFailureReason,
        "merge_conflict" | "unknown"
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

  recordTaskStatusAdvanced(input.context.runDir, {
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
  recordMergePhaseFailure(input, {
    type: "merge_failed",
    failureReason: input.failureReason,
  });

export const recordVerificationFailure = (
  input: RecordMergePhaseFailureInput,
): HubTaskLifecycleResult =>
  recordMergePhaseFailure(input, {
    type: "verification_failed",
    failureReason: "verification_failure",
  });

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

  recordTaskStatusAdvanced(input.context.runDir, {
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
