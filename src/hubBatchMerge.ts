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

export type HubBatchMergeSelectionDecision = "selected" | "skipped" | "blocked";

export type HubBatchMergeSelectionReason =
  | "selected"
  | "status_mismatch"
  | "batch_mismatch"
  | "missing_claim"
  | "missing_branch"
  | "no_unmerged_work"
  | "dirty_worktree"
  | "task_store_dirty";

export interface HubBatchMergeSelectionDiagnostic {
  readonly taskId: string;
  readonly title: string;
  readonly hubStatus: string;
  readonly decision: HubBatchMergeSelectionDecision;
  readonly reason: HubBatchMergeSelectionReason;
  readonly branch?: string;
  readonly batchId?: string;
  readonly message?: string;
  readonly taskStoreDirtyFiles?: readonly string[];
  readonly taskStoreBranchFiles?: readonly string[];
}

export interface HubMergeBranchState {
  readonly exists: boolean;
  readonly hasUnmergedWork: boolean;
  readonly changedFiles?: readonly string[];
}

export type HubMergeBranchInspector = (
  branch: string,
  cwd: string,
) => Promise<HubMergeBranchState>;

export interface HubMergeWorktreeState {
  readonly dirtySourceFiles: readonly string[];
  readonly dirtyTaskStoreFiles: readonly string[];
}

export type HubMergeWorktreeInspector = (
  cwd: string,
) => Promise<HubMergeWorktreeState>;

export interface RunHubBatchMergeInput {
  readonly flowId: string;
  readonly cwd: string;
  readonly runDir: string;
  readonly runId: string;
  readonly batchId: string;
  readonly merger: HubFlowMerger;
  readonly verifier: HubFlowVerifier;
  readonly closer?: HubTaskCloser;
  readonly branchInspector?: HubMergeBranchInspector;
  readonly worktreeInspector?: HubMergeWorktreeInspector;
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
  readonly selectionDiagnostics: readonly HubBatchMergeSelectionDiagnostic[];
  readonly batchStatus: "done" | "partial_failed" | "skipped";
  readonly results: readonly HubBatchMergeTaskResult[];
}

const resolveBranch = (task: HubTaskProjection): string =>
  task.claim?.branch ?? resolveHubTaskBranch(task.id, task.title);

const resolveClaimBranch = (task: HubTaskProjection): string | undefined =>
  task.claim?.branch && task.claim.branch.trim().length > 0
    ? task.claim.branch
    : undefined;

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

const defaultBranchInspector: HubMergeBranchInspector = async (branch, cwd) => {
  try {
    await execFileAsync(
      "git",
      ["rev-parse", "--verify", `${branch}^{commit}`],
      {
        cwd,
      },
    );
  } catch {
    return { exists: false, hasUnmergedWork: false };
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", `HEAD..${branch}`],
      { cwd, encoding: "utf8" },
    );
    const diff = await execFileAsync(
      "git",
      ["diff", "--name-only", `HEAD...${branch}`],
      { cwd, encoding: "utf8" },
    ).catch(() => ({ stdout: "" }));
    return {
      exists: true,
      hasUnmergedWork: Number(String(stdout).trim()) > 0,
      changedFiles: String(diff.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    };
  } catch {
    return { exists: true, hasUnmergedWork: false };
  }
};

const normalizeGitPath = (path: string): string => path.replace(/\\/g, "/");

const isTaskStoreRuntimePath = (path: string): boolean => {
  const normalized = normalizeGitPath(path);
  return normalized === ".beads" || normalized.startsWith(".beads/");
};

const parseGitStatusPorcelain = (stdout: string): string[] => {
  const entries = stdout.split("\0").filter((entry) => entry.length > 0);
  const paths: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length > 0) {
      paths.push(path);
    }

    if (status.includes("R") || status.includes("C")) {
      index += 1;
      const renamedPath = entries[index];
      if (renamedPath && renamedPath.length > 0) {
        paths.push(renamedPath);
      }
    }
  }

  return paths;
};

const defaultWorktreeInspector: HubMergeWorktreeInspector = async (cwd) => {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd, encoding: "utf8" },
  );
  const dirtyFiles = parseGitStatusPorcelain(String(stdout));
  return {
    dirtySourceFiles: dirtyFiles.filter(
      (path) => !isTaskStoreRuntimePath(path),
    ),
    dirtyTaskStoreFiles: dirtyFiles.filter(isTaskStoreRuntimePath),
  };
};

const buildSelectionDiagnostic = (
  task: HubTaskProjection,
  input: Pick<
    HubBatchMergeSelectionDiagnostic,
    | "decision"
    | "reason"
    | "branch"
    | "message"
    | "taskStoreDirtyFiles"
    | "taskStoreBranchFiles"
  >,
): HubBatchMergeSelectionDiagnostic => ({
  taskId: task.id,
  title: task.title,
  hubStatus: task.hubStatus,
  batchId: task.claim?.batchId,
  ...input,
});

const evaluateHubBatchMergeSelection = async (input: {
  readonly cwd: string;
  readonly batchId: string;
  readonly tasks: readonly HubTaskProjection[];
  readonly branchInspector: HubMergeBranchInspector;
  readonly worktreeState: HubMergeWorktreeState;
}): Promise<{
  readonly selectedTasks: readonly HubTaskProjection[];
  readonly diagnostics: readonly HubBatchMergeSelectionDiagnostic[];
}> => {
  const selectedTasks: HubTaskProjection[] = [];
  const diagnostics: HubBatchMergeSelectionDiagnostic[] = [];

  for (const task of input.tasks) {
    if (task.hubStatus !== "waiting_for_merge") {
      if (task.claim?.batchId === input.batchId) {
        diagnostics.push(
          buildSelectionDiagnostic(task, {
            decision: "skipped",
            reason: "status_mismatch",
            branch: resolveClaimBranch(task),
            message: `Task is ${task.hubStatus}, not waiting_for_merge.`,
          }),
        );
      }
      continue;
    }

    if (!task.claim) {
      diagnostics.push(
        buildSelectionDiagnostic(task, {
          decision: "skipped",
          reason: "missing_claim",
          message: "Task is waiting_for_merge without claim metadata.",
        }),
      );
      continue;
    }

    if (task.claim.batchId !== input.batchId) {
      diagnostics.push(
        buildSelectionDiagnostic(task, {
          decision: "skipped",
          reason: "batch_mismatch",
          branch: resolveClaimBranch(task),
          message: `Task belongs to batch ${task.claim.batchId ?? "<missing>"}, not ${input.batchId}.`,
        }),
      );
      continue;
    }

    const branch = resolveClaimBranch(task);
    if (!branch) {
      diagnostics.push(
        buildSelectionDiagnostic(task, {
          decision: "skipped",
          reason: "missing_branch",
          message: "Task claim does not include a branch.",
        }),
      );
      continue;
    }

    const branchState = await input.branchInspector(branch, input.cwd);
    if (!branchState.exists) {
      diagnostics.push(
        buildSelectionDiagnostic(task, {
          decision: "skipped",
          reason: "missing_branch",
          branch,
          message: `Branch ${branch} does not exist.`,
        }),
      );
      continue;
    }

    if (!branchState.hasUnmergedWork) {
      diagnostics.push(
        buildSelectionDiagnostic(task, {
          decision: "skipped",
          reason: "no_unmerged_work",
          branch,
          message: `Branch ${branch} has no commits ahead of HEAD.`,
        }),
      );
      continue;
    }

    const taskStoreBranchFiles = (branchState.changedFiles ?? []).filter(
      isTaskStoreRuntimePath,
    );
    if (taskStoreBranchFiles.length > 0) {
      diagnostics.push(
        buildSelectionDiagnostic(task, {
          decision: "blocked",
          reason: "task_store_dirty",
          branch,
          message: `Task branch changes Beads runtime/export files (${taskStoreBranchFiles.join(", ")}). Keep local task-store state out of normal Hub merges; remove those files from the branch or sync task state through Sandcastle task sync before retrying.`,
          taskStoreBranchFiles,
        }),
      );
      continue;
    }

    if (input.worktreeState.dirtySourceFiles.length > 0) {
      diagnostics.push(
        buildSelectionDiagnostic(task, {
          decision: "blocked",
          reason: "dirty_worktree",
          branch,
          message: `Clean or stash dirty source files before merging: ${input.worktreeState.dirtySourceFiles.join(", ")}`,
        }),
      );
      continue;
    }

    selectedTasks.push(task);
    const taskStoreDirtyFiles = input.worktreeState.dirtyTaskStoreFiles;
    diagnostics.push(
      buildSelectionDiagnostic(task, {
        decision: "selected",
        reason: "selected",
        branch,
        message:
          taskStoreDirtyFiles.length > 0
            ? `Branch ${branch} has unmerged work; task-store dirty: ${taskStoreDirtyFiles.join(", ")}. Hub merge preflight ignores local Beads runtime/export dirtiness unless the task branch also changes those files.`
            : `Branch ${branch} has unmerged work.`,
        taskStoreDirtyFiles:
          taskStoreDirtyFiles.length > 0 ? taskStoreDirtyFiles : undefined,
      }),
    );
  }

  return { selectedTasks, diagnostics };
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
  const worktreeState = await (
    input.worktreeInspector ?? defaultWorktreeInspector
  )(input.cwd);
  const selection = await evaluateHubBatchMergeSelection({
    cwd: input.cwd,
    batchId: input.batchId,
    tasks: board.tasks,
    branchInspector: input.branchInspector ?? defaultBranchInspector,
    worktreeState,
  });
  const selectedTasks = selection.selectedTasks;
  const selectedTaskIds = selectedTasks.map((task) => task.id);
  const selectionCreatedAt = new Date().toISOString();

  appendHubBatchEvent(input.runDir, {
    type: "batch_merge_selection",
    runId: input.runId,
    batchId: input.batchId,
    createdAt: selectionCreatedAt,
    selectedTaskIds,
    diagnostics: selection.diagnostics,
  });

  if (selectedTasks.length === 0) {
    return {
      runId: input.runId,
      batchId: input.batchId,
      selectedTaskIds,
      selectionDiagnostics: selection.diagnostics,
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
        selectionDiagnostics: selection.diagnostics,
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
    selectionDiagnostics: selection.diagnostics,
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

  if (result.selectionDiagnostics.length > 0) {
    lines.push("Selection diagnostics:");
    for (const diagnostic of result.selectionDiagnostics) {
      const branchSuffix = diagnostic.branch ? ` ${diagnostic.branch}` : "";
      const messageSuffix = diagnostic.message ? `; ${diagnostic.message}` : "";
      const decisionSummary =
        diagnostic.decision === "selected"
          ? `selected${branchSuffix}`
          : `${diagnostic.decision} ${diagnostic.reason}${branchSuffix}`;
      lines.push(`  ${diagnostic.taskId}: ${decisionSummary}${messageSuffix}`);
    }
  }

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
