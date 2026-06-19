import {
  appendHubTaskEvent,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  loadHubTask,
  updateHubTaskStatus,
  type HubFailureReason,
  type HubTaskProjection,
} from "./taskBoard.js";

const COLLABORATION_LABELS_TO_CLEAR_ON_SYNC_CONFLICT = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "blocked",
  "wontfix",
  "sync-conflict",
] as const;

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

export const recordHubTaskSyncConflict = (
  input: RecordHubTaskSyncConflictInput,
): RecordHubTaskSyncConflictResult => {
  const task = loadHubTask(input.cwd, input.taskId, input.env);
  const preservedCompletion =
    task.hubStatus === "done" || task.hubStatus === "wontfix";
  const metadata = {
    sync_state: "conflict" as const,
    sync_conflict_reason: input.reason,
  };

  if (preservedCompletion) {
    const updatedTask = updateHubTaskStatus({
      cwd: input.cwd,
      taskId: input.taskId,
      hubStatus: task.hubStatus,
      metadata,
      env: input.env,
    });
    return {
      hubStatus: updatedTask.hubStatus,
      preservedCompletion: true,
      task: updatedTask,
    };
  }

  const labelsToRemove = COLLABORATION_LABELS_TO_CLEAR_ON_SYNC_CONFLICT.filter(
    (label) => task.labels.includes(label),
  );
  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: "sync_conflict",
    metadata,
    labelsToRemove,
    env: input.env,
  });

  return {
    hubStatus: updatedTask.hubStatus,
    preservedCompletion: false,
    task: updatedTask,
  };
};
