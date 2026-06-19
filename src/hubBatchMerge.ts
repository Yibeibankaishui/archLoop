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

export type HubMergeDiagnostics = Readonly<Record<string, unknown>> & {
  readonly message?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export interface HubMergeTaskResult {
  readonly outcome: "success" | "merge_conflict" | "failed";
  readonly message?: string;
  readonly diagnostics?: HubMergeDiagnostics;
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
  readonly diagnosticSummary?: string;
  readonly diagnostics?: HubMergeDiagnostics;
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

const readErrorProperty = (error: unknown, key: string): unknown | undefined =>
  error && typeof error === "object"
    ? (error as Record<string, unknown>)[key]
    : undefined;

const readStringProperty = (
  error: unknown,
  key: string,
): string | undefined => {
  const value = readErrorProperty(error, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const readExitCode = (error: unknown): number | undefined => {
  const code = readErrorProperty(error, "code");
  return typeof code === "number" ? code : undefined;
};

const compactDiagnostics = (
  diagnostics: HubMergeDiagnostics,
): HubMergeDiagnostics | undefined => {
  const compacted: HubMergeDiagnostics = {
    ...(diagnostics.message ? { message: diagnostics.message } : {}),
    ...(diagnostics.stdout ? { stdout: diagnostics.stdout } : {}),
    ...(diagnostics.stderr ? { stderr: diagnostics.stderr } : {}),
    ...(diagnostics.exitCode !== undefined
      ? { exitCode: diagnostics.exitCode }
      : {}),
    ...(diagnostics.signal ? { signal: diagnostics.signal } : {}),
    ...(diagnostics.details && Object.keys(diagnostics.details).length > 0
      ? { details: diagnostics.details }
      : {}),
  };

  return Object.keys(compacted).length > 0 ? compacted : undefined;
};

const buildMergeDiagnostics = (
  result: HubMergeTaskResult,
): HubMergeDiagnostics | undefined =>
  compactDiagnostics({
    ...result.diagnostics,
    message: result.diagnostics?.message ?? result.message,
  });

const firstDiagnosticLine = (value: string | undefined): string | undefined =>
  value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

const formatMergeDiagnosticSummary = (
  diagnostics: HubMergeDiagnostics | undefined,
): string | undefined => {
  if (!diagnostics) {
    return undefined;
  }

  const prefixParts = [
    diagnostics.message,
    diagnostics.exitCode !== undefined ? `exit ${diagnostics.exitCode}` : "",
    diagnostics.signal ? `signal ${diagnostics.signal}` : "",
  ].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const prefix =
    prefixParts.length > 0
      ? prefixParts.length === 1
        ? prefixParts[0]
        : `${prefixParts[0]} (${prefixParts.slice(1).join(", ")})`
      : undefined;
  const body =
    firstDiagnosticLine(diagnostics.stderr) ??
    firstDiagnosticLine(diagnostics.stdout);

  if (prefix && body && body !== prefix) {
    return `${prefix}: ${body}`;
  }
  return prefix ?? body;
};

const extractErrorDiagnostics = (error: unknown): HubMergeDiagnostics => {
  const details: Record<string, unknown> = {};
  const code = readErrorProperty(error, "code");
  const command = readStringProperty(error, "cmd");
  const path = readStringProperty(error, "path");
  const syscall = readStringProperty(error, "syscall");

  if (typeof code === "string" && code.length > 0) {
    details.code = code;
  }
  if (command) {
    details.command = command;
  }
  if (path) {
    details.path = path;
  }
  if (syscall) {
    details.syscall = syscall;
  }

  return {
    message: error instanceof Error ? error.message : String(error),
    stdout: readStringProperty(error, "stdout"),
    stderr: readStringProperty(error, "stderr"),
    exitCode: readExitCode(error),
    signal: readStringProperty(error, "signal"),
    details,
  };
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
    readonly diagnosticSummary?: string;
    readonly diagnostics?: HubMergeDiagnostics;
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
    diagnosticSummary: input.diagnosticSummary,
    diagnostics: input.diagnostics,
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
  diagnostics?: HubMergeDiagnostics,
  diagnosticSummary?: string,
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
    diagnosticSummary,
    diagnostics,
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
    diagnosticSummary,
    diagnostics,
  });

  return {
    taskId: task.id,
    title: task.title,
    branch,
    outcome,
    hubStatus: updatedTask.hubStatus,
    failureReason,
    diagnosticSummary,
    diagnostics,
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
      mergeResult.outcome === "merge_conflict"
        ? "merge_conflict"
        : "merge_failed";
    const diagnostics = buildMergeDiagnostics(mergeResult);
    const diagnosticSummary = formatMergeDiagnosticSummary(diagnostics);
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
      diagnostics,
      diagnosticSummary,
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
        failedTaskId: result.taskId,
        failureReason: result.failureReason,
        failureSummary: `${result.taskId} ${result.outcome}: ${
          result.diagnosticSummary ?? result.failureReason ?? result.outcome
        }`,
        diagnostics: result.diagnostics,
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

const isMergeConflict = (
  error: unknown,
  diagnostics?: HubMergeDiagnostics,
): boolean => {
  const message = [
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "",
    diagnostics?.stdout,
    diagnostics?.stderr,
  ].join("\n");
  return /CONFLICT|conflicts?/i.test(message);
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
      const diagnostics = compactDiagnostics(extractErrorDiagnostics(error));
      if (isMergeConflict(error, diagnostics)) {
        return {
          outcome: "merge_conflict",
          message: error instanceof Error ? error.message : String(error),
          diagnostics,
        };
      }

      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
        diagnostics,
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
    const diagnosticSuffix = taskResult.diagnosticSummary
      ? `; ${taskResult.diagnosticSummary}`
      : "";
    lines.push(
      `  ${taskResult.taskId}: ${taskResult.outcome} -> ${taskResult.hubStatus}${diagnosticSuffix}`,
    );
  }

  return lines;
};
