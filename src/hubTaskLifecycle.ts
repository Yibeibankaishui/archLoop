import {
  appendHubTaskEvent,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  updateHubTaskStatus,
  type HubFailureReason,
  type HubTaskProjection,
} from "./taskBoard.js";

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

const reviewFailureOutcome = (
  failureReason: HubFailureReason,
): RecordHubTaskReviewFailureResult["outcome"] => {
  if (failureReason === "sandbox_failed") {
    return "sandbox_failed";
  }
  return "agent_failed";
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
    readonly failureReason?: HubFailureReason;
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
  recordTaskStatusAdvanced(input.runDir, {
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
  recordTaskStatusAdvanced(input.runDir, {
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
