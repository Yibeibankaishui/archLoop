import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  appendHubBatchEvent,
  appendHubTaskEvent,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  closeHubTask,
  loadHubTaskBoard,
  resolveHubTaskBranch,
  selectHubBatchMergeTasks,
  updateHubTaskStatus,
  type HubFailureReason,
  type HubTaskProjection,
} from "./taskBoard.js";

const execFileAsync = promisify(execFile);

export interface HubMergeTaskInput {
  readonly flowId: string;
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly cwd: string;
  readonly runDir: string;
}

export interface HubMergeTaskResult {
  readonly outcome: "success" | "merge_conflict" | "failed";
  readonly message?: string;
}

export type HubFlowMerger = (
  input: HubMergeTaskInput,
) => Promise<HubMergeTaskResult>;

export interface HubVerifyTaskInput {
  readonly flowId: string;
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly cwd: string;
  readonly runDir: string;
}

export interface HubVerifyTaskResult {
  readonly outcome: "success" | "failed";
  readonly message?: string;
}

export type HubFlowVerifier = (
  input: HubVerifyTaskInput,
) => Promise<HubVerifyTaskResult>;

export interface CloseHubTaskAttemptInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}

export type HubTaskCloser = (
  input: CloseHubTaskAttemptInput,
) => Promise<HubTaskProjection>;

export interface RunHubBatchMergeInput {
  readonly flowId: string;
  readonly cwd: string;
  readonly runDir: string;
  readonly runId: string;
  readonly batchId: string;
  readonly merger: HubFlowMerger;
  readonly verifier: HubFlowVerifier;
  readonly closer?: HubTaskCloser;
  readonly env?: NodeJS.ProcessEnv;
}

export interface HubBatchMergeTaskResult {
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly outcome:
    | "merged"
    | "merge_conflict"
    | "merge_failed"
    | "verification_failed"
    | "close_failed"
    | "skipped";
  readonly hubStatus: string;
  readonly failureReason?: HubFailureReason;
}

export interface RunHubBatchMergeResult {
  readonly runId: string;
  readonly batchId: string;
  readonly selectedTaskIds: readonly string[];
  readonly batchStatus: "done" | "partial_failed" | "skipped";
  readonly results: readonly HubBatchMergeTaskResult[];
}

const resolveBranch = (task: HubTaskProjection): string =>
  task.claim?.branch ?? resolveHubTaskBranch(task.id, task.title);

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
  });
};

const recordTaskFailure = (
  input: RunHubBatchMergeInput,
  task: HubTaskProjection,
  branch: string,
  claim: HubTaskClaimMetadata | undefined,
  failureReason: HubFailureReason,
  eventType: "merge_failed" | "verification_failed" | "task_close_failed",
  createdAt: string,
  outcome: HubBatchMergeTaskResult["outcome"],
): HubBatchMergeTaskResult => {
  appendHubTaskEvent(input.runDir, {
    type: eventType,
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt,
    status: "failed",
    failureReason,
    claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: task.id,
    hubStatus: "failed",
    metadata: task.metadata,
    failureReason,
    env: input.env,
  });
  recordTaskStatusAdvanced(input.runDir, {
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt,
    status: updatedTask.hubStatus,
    failureReason,
  });

  return {
    taskId: task.id,
    title: task.title,
    branch,
    outcome,
    hubStatus: updatedTask.hubStatus,
    failureReason,
  };
};

const revertTasksToWaitingForMerge = (
  cwd: string,
  tasks: readonly HubTaskProjection[],
  env: NodeJS.ProcessEnv | undefined,
): void => {
  for (const task of tasks) {
    updateHubTaskStatus({
      cwd,
      taskId: task.id,
      hubStatus: "waiting_for_merge",
      metadata: task.metadata,
      env,
    });
  }
};

const defaultHubTaskCloser: HubTaskCloser = async (input) =>
  closeHubTask({
    cwd: input.cwd,
    taskId: input.taskId,
    metadata: input.metadata,
    env: input.env,
  });

const processMergeTask = async (
  input: RunHubBatchMergeInput,
  task: HubTaskProjection,
  claim: HubTaskClaimMetadata | undefined,
): Promise<HubBatchMergeTaskResult> => {
  const branch = resolveBranch(task);
  const startedAt = new Date().toISOString();

  appendHubTaskEvent(input.runDir, {
    type: "merge_started",
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt: startedAt,
    status: "merging",
    claim,
  });

  const mergeResult = await input.merger({
    flowId: input.flowId,
    taskId: task.id,
    title: task.title,
    branch,
    cwd: input.cwd,
    runDir: input.runDir,
  });
  const mergeFinishedAt = new Date().toISOString();

  if (mergeResult.outcome !== "success") {
    const failureReason: HubFailureReason =
      mergeResult.outcome === "merge_conflict" ? "merge_conflict" : "unknown";
    return recordTaskFailure(
      input,
      task,
      branch,
      claim,
      failureReason,
      "merge_failed",
      mergeFinishedAt,
      mergeResult.outcome === "merge_conflict"
        ? "merge_conflict"
        : "merge_failed",
    );
  }

  appendHubTaskEvent(input.runDir, {
    type: "merge_succeeded",
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt: mergeFinishedAt,
    status: "merging",
    claim,
  });

  appendHubTaskEvent(input.runDir, {
    type: "verification_started",
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt: mergeFinishedAt,
    status: "merging",
    claim,
  });

  const verifyResult = await input.verifier({
    flowId: input.flowId,
    taskId: task.id,
    title: task.title,
    branch,
    cwd: input.cwd,
    runDir: input.runDir,
  });
  const verifyFinishedAt = new Date().toISOString();

  if (verifyResult.outcome !== "success") {
    const failureReason: HubFailureReason = "verification_failure";
    return recordTaskFailure(
      input,
      task,
      branch,
      claim,
      failureReason,
      "verification_failed",
      verifyFinishedAt,
      "verification_failed",
    );
  }

  appendHubTaskEvent(input.runDir, {
    type: "verification_passed",
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt: verifyFinishedAt,
    status: "merging",
    claim,
  });

  appendHubTaskEvent(input.runDir, {
    type: "task_close_started",
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt: verifyFinishedAt,
    status: "merging",
    claim,
  });

  const closer = input.closer ?? defaultHubTaskCloser;
  let closedTask: HubTaskProjection;
  try {
    closedTask = await closer({
      cwd: input.cwd,
      taskId: task.id,
      metadata: task.metadata,
      env: input.env,
    });
  } catch (error) {
    const failureReason: HubFailureReason = "close_failed";
    const closeFailedAt = new Date().toISOString();
    return recordTaskFailure(
      input,
      task,
      branch,
      claim,
      failureReason,
      "task_close_failed",
      closeFailedAt,
      "close_failed",
    );
  }

  const closedAt = new Date().toISOString();
  appendHubTaskEvent(input.runDir, {
    type: "task_closed",
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt: closedAt,
    status: closedTask.hubStatus,
    claim,
  });
  recordTaskStatusAdvanced(input.runDir, {
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt: closedAt,
    status: closedTask.hubStatus,
  });

  return {
    taskId: task.id,
    title: task.title,
    branch,
    outcome: "merged",
    hubStatus: closedTask.hubStatus,
  };
};

export const runHubBatchMerge = async (
  input: RunHubBatchMergeInput,
): Promise<RunHubBatchMergeResult> => {
  const board = loadHubTaskBoard(input.cwd, input.env);
  const selectedTasks = selectHubBatchMergeTasks(board, input.batchId);
  const selectedTaskIds = selectedTasks.map((task) => task.id);

  if (selectedTasks.length === 0) {
    return {
      runId: input.runId,
      batchId: input.batchId,
      selectedTaskIds,
      batchStatus: "skipped",
      results: [],
    };
  }

  const mergeStartedAt = new Date().toISOString();
  for (const task of selectedTasks) {
    updateHubTaskStatus({
      cwd: input.cwd,
      taskId: task.id,
      hubStatus: "merging",
      metadata: task.metadata,
      env: input.env,
    });
  }

  appendHubBatchEvent(input.runDir, {
    type: "batch_merge_started",
    runId: input.runId,
    batchId: input.batchId,
    createdAt: mergeStartedAt,
    taskIds: selectedTaskIds,
  });

  const results: HubBatchMergeTaskResult[] = [];
  for (let index = 0; index < selectedTasks.length; index += 1) {
    const task = selectedTasks[index]!;
    const claim = task.claim;

    const result = await processMergeTask(input, task, claim);
    results.push(result);

    if (result.outcome !== "merged") {
      const remainingTasks = selectedTasks.slice(index + 1);
      revertTasksToWaitingForMerge(input.cwd, remainingTasks, input.env);
      for (const skippedTask of remainingTasks) {
        results.push({
          taskId: skippedTask.id,
          title: skippedTask.title,
          branch: resolveBranch(skippedTask),
          outcome: "skipped",
          hubStatus: "waiting_for_merge",
        });
      }

      appendHubBatchEvent(input.runDir, {
        type: "batch_merge_completed",
        runId: input.runId,
        batchId: input.batchId,
        createdAt: new Date().toISOString(),
        taskIds: selectedTaskIds,
        batchStatus: "partial_failed",
      });

      return {
        runId: input.runId,
        batchId: input.batchId,
        selectedTaskIds,
        batchStatus: "partial_failed",
        results,
      };
    }
  }

  appendHubBatchEvent(input.runDir, {
    type: "batch_merge_completed",
    runId: input.runId,
    batchId: input.batchId,
    createdAt: new Date().toISOString(),
    taskIds: selectedTaskIds,
    batchStatus: "done",
  });

  return {
    runId: input.runId,
    batchId: input.batchId,
    selectedTaskIds,
    batchStatus: "done",
    results,
  };
};

const isMergeConflict = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /CONFLICT|conflict|merge failed/i.test(message);
};

export const createHubFlowRunMerger = (options: {
  readonly cwd: string;
}): HubFlowMerger => {
  return async (input) => {
    try {
      await execFileAsync(
        "git",
        ["merge", "--no-ff", input.branch, "-m", `Merge ${input.branch}`],
        { cwd: options.cwd },
      );
      return { outcome: "success" };
    } catch (error) {
      if (isMergeConflict(error)) {
        return {
          outcome: "merge_conflict",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
};

export const createHubFlowRunVerifier = (options: {
  readonly cwd: string;
}): HubFlowVerifier => {
  return async () => {
    const verifyScript = join(options.cwd, ".sandcastle", "verify.sh");
    if (!existsSync(verifyScript)) {
      return { outcome: "success" };
    }

    try {
      await execFileAsync(verifyScript, [], { cwd: options.cwd });
      return { outcome: "success" };
    } catch (error) {
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
};

export const formatHubBatchMergeResultLines = (
  result: RunHubBatchMergeResult,
): readonly string[] => {
  const lines = [
    `Hub batch merge ${result.batchId}`,
    `Batch status: ${result.batchStatus}`,
    `Selected tasks: ${result.selectedTaskIds.length}`,
  ];

  if (result.selectedTaskIds.length === 0) {
    lines.push("No waiting_for_merge tasks selected for merge.");
    return lines;
  }

  for (const taskResult of result.results) {
    lines.push(
      `  ${taskResult.taskId}: ${taskResult.outcome} -> ${taskResult.hubStatus}`,
    );
  }

  return lines;
};
