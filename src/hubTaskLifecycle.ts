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

export interface HubTaskLifecycleResult {
  readonly task: HubTaskProjection;
  readonly hubStatus: HubTaskStatus;
}

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
      readonly failureReason: ImplementationFailureReason;
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
    status: outcome.status,
    failureReason,
    commitCount: input.commitCount,
    claim: input.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: outcome.hubStatus,
    metadata: input.metadata,
    ...(failureReason ? { failureReason } : {}),
    env: input.env,
  });

  recordTaskStatusAdvanced(input.context.runDir, {
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
    failureReason,
    commitCount: input.commitCount,
  });

  return {
    task: updatedTask,
    hubStatus: updatedTask.hubStatus,
  };
};

export const recordImplementationSuccess = (
  input: RecordImplementationSuccessInput,
): HubTaskLifecycleResult => {
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
): HubTaskLifecycleResult =>
  recordImplementationOutcome(input, {
    type: "task_implementation_failed",
    status: "failed",
    hubStatus: "failed",
    failureReason: input.failureReason,
  });

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
    replaceMetadata: true,
    env: input.env,
  });

  return {
    task: updatedTask,
    hubStatus: updatedTask.hubStatus,
  };
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
    metadata: stripClaimMetadata(input.metadata),
    env: input.env,
  });

  return {
    task: closedTask,
    hubStatus: closedTask.hubStatus,
  };
};
