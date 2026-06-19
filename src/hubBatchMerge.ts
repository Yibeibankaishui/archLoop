import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { appendHubBatchEvent, appendHubTaskEvent } from "./hubExecution.js";
import {
  enterMergePhase,
  recordCloseFailure,
  recordMergeFailure,
  recordTaskClosure,
  recordTaskMergeStarted,
  recordVerificationFailure,
  revertTaskToWaitingForMerge,
  type HubTaskLifecycleContext,
} from "./hubTaskLifecycle.js";
import {
  loadHubTaskBoard,
  resolveHubTaskBranch,
  selectHubBatchMergeTasks,
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

const toLifecycleContext = (
  input: RunHubBatchMergeInput,
): HubTaskLifecycleContext => ({
  runId: input.runId,
  batchId: input.batchId,
  runDir: input.runDir,
});

const processMergeTask = async (
  input: RunHubBatchMergeInput,
  task: HubTaskProjection,
  claim: HubTaskProjection["claim"],
): Promise<HubBatchMergeTaskResult> => {
  const branch = resolveBranch(task);
  const context = toLifecycleContext(input);
  const startedAt = new Date().toISOString();
  const lifecycleBase = {
    cwd: input.cwd,
    env: input.env,
    context,
    taskId: task.id,
    branch,
    metadata: task.metadata,
    claim,
  };

  recordTaskMergeStarted({
    context,
    taskId: task.id,
    branch,
    claim,
    createdAt: startedAt,
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
    const lifecycleResult = recordMergeFailure({
      ...lifecycleBase,
      failureReason,
      createdAt: mergeFinishedAt,
    });

    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome:
        mergeResult.outcome === "merge_conflict"
          ? "merge_conflict"
          : "merge_failed",
      hubStatus: lifecycleResult.hubStatus,
      failureReason,
    };
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
    const lifecycleResult = recordVerificationFailure({
      ...lifecycleBase,
      createdAt: verifyFinishedAt,
    });

    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome: "verification_failed",
      hubStatus: lifecycleResult.hubStatus,
      failureReason: lifecycleResult.failureReason,
    };
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

  const closer = input.closer;
  try {
    const lifecycleResult = await recordTaskClosure({
      ...lifecycleBase,
      createdAt: verifyFinishedAt,
      ...(closer
        ? {
            closer: async (closeInput) =>
              closer({
                cwd: closeInput.cwd,
                taskId: closeInput.taskId,
                metadata: closeInput.metadata,
                env: closeInput.env,
              }),
          }
        : {}),
    });

    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome: "merged",
      hubStatus: lifecycleResult.hubStatus,
    };
  } catch {
    const closeFailedAt = new Date().toISOString();
    const lifecycleResult = recordCloseFailure({
      ...lifecycleBase,
      createdAt: closeFailedAt,
    });

    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome: "close_failed",
      hubStatus: lifecycleResult.hubStatus,
      failureReason: lifecycleResult.failureReason,
    };
  }
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
  enterMergePhase({
    cwd: input.cwd,
    env: input.env,
    tasks: selectedTasks,
  });

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
      for (const skippedTask of remainingTasks) {
        revertTaskToWaitingForMerge({
          cwd: input.cwd,
          env: input.env,
          task: skippedTask,
        });
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
