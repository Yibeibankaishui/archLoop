import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  appendHubTaskEvent,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  claimHubTask,
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
  readonly hubStatus: string;
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

const ensureLifecycleRunDir = (runDir: string): void => {
  mkdirSync(join(runDir, "events"), { recursive: true });
};

export const recordImplementationSuccess = (
  input: RecordImplementationSuccessInput,
): RecordImplementationOutcomeResult => {
  const postImplementationStatus: HubTaskStatus = input.hasReviewer
    ? "reviewing"
    : "waiting_for_merge";

  ensureLifecycleRunDir(input.context.runDir);

  appendHubTaskEvent(input.context.runDir, {
    type: "task_implementation_succeeded",
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: postImplementationStatus,
    commitCount: input.commitCount,
    claim: input.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: postImplementationStatus,
    metadata: input.metadata,
    env: input.env,
  });
  recordTaskStatusAdvanced(input.context.runDir, {
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
    commitCount: input.commitCount,
  });

  return {
    task: updatedTask,
    hubStatus: updatedTask.hubStatus,
  };
};

export const recordImplementationFailure = (
  input: RecordImplementationFailureInput,
): RecordImplementationOutcomeResult => {
  ensureLifecycleRunDir(input.context.runDir);

  appendHubTaskEvent(input.context.runDir, {
    type: "task_implementation_failed",
    runId: input.context.runId,
    batchId: input.context.batchId,
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
    metadata: input.metadata,
    failureReason: input.failureReason,
    env: input.env,
  });
  recordTaskStatusAdvanced(input.context.runDir, {
    runId: input.context.runId,
    batchId: input.context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: updatedTask.hubStatus,
    failureReason: input.failureReason,
    commitCount: input.commitCount,
  });

  return {
    task: updatedTask,
    hubStatus: updatedTask.hubStatus,
  };
};
