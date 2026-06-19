import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { assertAgentCredentialsConfigured } from "./agentAuthGuidance.js";
import {
  appendHubBatchEvent,
  appendHubTaskEvent,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import { readHubAgentConfig } from "./hubAgentConfig.js";
import { resolveHubAgentProvider } from "./hubProposalAgent.js";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import {
  enterMergePhase,
  recordCloseFailure,
  recordMergeFailure,
  recordTaskClosure,
  recordTaskMergeStarted,
  recordVerificationFailure,
  revertTaskToWaitingForMerge,
  type CloseHubTaskInput,
  type HubTaskCloser,
  type HubTaskLifecycleContext,
} from "./hubTaskLifecycle.js";
import {
  loadHubTaskBoard,
  resolveHubTaskBranch,
  type HubFailureReason,
  type HubTaskProjection,
  type HubTaskStatus,
} from "./taskBoard.js";

const execFileAsync = promisify(execFile);

export interface HubMergeTaskInput {
  readonly flowId: string;
  readonly runId: string;
  readonly batchId: string;
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

export interface HubMergeConflictResolutionInput extends HubMergeTaskInput {
  readonly diagnostics: HubMergeDiagnostics | undefined;
  readonly conflictedFiles: readonly string[];
  readonly gitStatus: string;
  readonly baseBranch: string | undefined;
}

export interface HubMergeConflictResolutionResult {
  readonly outcome: "success" | "failed";
  readonly message?: string;
  readonly diagnostics?: HubMergeDiagnostics;
}

export type HubMergeConflictResolver = (
  input: HubMergeConflictResolutionInput,
) => Promise<HubMergeConflictResolutionResult>;

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

export type { CloseHubTaskInput as CloseHubTaskAttemptInput, HubTaskCloser };

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
  readonly hubStatus: HubTaskStatus;
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
  readonly hubStatus: HubTaskStatus;
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

const toLifecycleContext = (
  input: RunHubBatchMergeInput,
): HubTaskLifecycleContext => ({
  runId: input.runId,
  batchId: input.batchId,
  runDir: input.runDir,
});

type MergeProgressEventType =
  | "merge_succeeded"
  | "verification_started"
  | "verification_passed"
  | "task_close_started";

const appendMergeProgressEvent = (
  input: RunHubBatchMergeInput,
  event: {
    readonly type: MergeProgressEventType;
    readonly taskId: string;
    readonly branch: string;
    readonly claim: HubTaskProjection["claim"];
    readonly createdAt: string;
  },
): void => {
  appendHubTaskEvent(input.runDir, {
    type: event.type,
    runId: input.runId,
    batchId: input.batchId,
    taskId: event.taskId,
    branch: event.branch,
    createdAt: event.createdAt,
    status: "merging",
    claim: event.claim,
  });
};

const toBatchMergeTaskResult = (
  task: HubTaskProjection,
  branch: string,
  outcome: HubBatchMergeTaskResult["outcome"],
  hubStatus: HubTaskStatus,
  failureReason?: HubFailureReason,
  diagnosticSummary?: string,
  diagnostics?: HubMergeDiagnostics,
): HubBatchMergeTaskResult => ({
  taskId: task.id,
  title: task.title,
  branch,
  outcome,
  hubStatus,
  ...(failureReason === undefined ? {} : { failureReason }),
  ...(diagnosticSummary === undefined ? {} : { diagnosticSummary }),
  ...(diagnostics === undefined ? {} : { diagnostics }),
});

const recordBatchMergeCompleted = (
  input: RunHubBatchMergeInput,
  selectedTaskIds: readonly string[],
  batchStatus: "done" | "partial_failed",
  failedResult?: HubBatchMergeTaskResult,
): void => {
  appendHubBatchEvent(input.runDir, {
    type: "batch_merge_completed",
    runId: input.runId,
    batchId: input.batchId,
    createdAt: new Date().toISOString(),
    taskIds: selectedTaskIds,
    batchStatus,
    ...(failedResult
      ? {
          failedTaskId: failedResult.taskId,
          failureReason: failedResult.failureReason,
          failureSummary: `${failedResult.taskId} ${failedResult.outcome}: ${
            failedResult.diagnosticSummary ??
            failedResult.failureReason ??
            failedResult.outcome
          }`,
          diagnostics: failedResult.diagnostics,
        }
      : {}),
  });
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
};

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
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    title: task.title,
    branch,
    cwd: input.cwd,
    runDir: input.runDir,
  });
  const mergeFinishedAt = new Date().toISOString();

  if (mergeResult.outcome !== "success") {
    const isMergeConflict = mergeResult.outcome === "merge_conflict";
    const failureReason: HubFailureReason = isMergeConflict
      ? "merge_conflict"
      : "merge_failed";
    const diagnostics = buildMergeDiagnostics(mergeResult);
    const diagnosticSummary = formatMergeDiagnosticSummary(diagnostics);
    const lifecycleResult = recordMergeFailure({
      ...lifecycleBase,
      failureReason,
      createdAt: mergeFinishedAt,
      diagnosticSummary,
      diagnostics,
    });

    return toBatchMergeTaskResult(
      task,
      branch,
      isMergeConflict ? "merge_conflict" : "merge_failed",
      lifecycleResult.hubStatus,
      failureReason,
      diagnosticSummary,
      diagnostics,
    );
  }

  appendMergeProgressEvent(input, {
    type: "merge_succeeded",
    taskId: task.id,
    branch,
    claim,
    createdAt: mergeFinishedAt,
  });

  appendMergeProgressEvent(input, {
    type: "verification_started",
    taskId: task.id,
    branch,
    claim,
    createdAt: mergeFinishedAt,
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

    return toBatchMergeTaskResult(
      task,
      branch,
      "verification_failed",
      lifecycleResult.hubStatus,
      lifecycleResult.failureReason,
    );
  }

  appendMergeProgressEvent(input, {
    type: "verification_passed",
    taskId: task.id,
    branch,
    claim,
    createdAt: verifyFinishedAt,
  });

  appendMergeProgressEvent(input, {
    type: "task_close_started",
    taskId: task.id,
    branch,
    claim,
    createdAt: verifyFinishedAt,
  });

  try {
    const lifecycleResult = await recordTaskClosure({
      ...lifecycleBase,
      createdAt: verifyFinishedAt,
      closer: input.closer,
    });

    return toBatchMergeTaskResult(
      task,
      branch,
      "merged",
      lifecycleResult.hubStatus,
    );
  } catch {
    const closeFailedAt = new Date().toISOString();
    const lifecycleResult = recordCloseFailure({
      ...lifecycleBase,
      createdAt: closeFailedAt,
    });

    return toBatchMergeTaskResult(
      task,
      branch,
      "close_failed",
      lifecycleResult.hubStatus,
      lifecycleResult.failureReason,
    );
  }
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
        results.push(
          toBatchMergeTaskResult(
            skippedTask,
            resolveBranch(skippedTask),
            "skipped",
            "waiting_for_merge",
          ),
        );
      }

      recordBatchMergeCompleted(
        input,
        selectedTaskIds,
        "partial_failed",
        result,
      );

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

  recordBatchMergeCompleted(input, selectedTaskIds, "done");

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

const readGitStdout = async (
  cwd: string,
  args: readonly string[],
): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
  });
  return String(stdout);
};

const listUnmergedFiles = async (cwd: string): Promise<readonly string[]> =>
  (await readGitStdout(cwd, ["diff", "--name-only", "--diff-filter=U"]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const readGitStatusShort = async (cwd: string): Promise<string> =>
  readGitStdout(cwd, ["status", "--short"]);

const readCurrentBranch = async (cwd: string): Promise<string | undefined> => {
  const branch = (
    await readGitStdout(cwd, ["branch", "--show-current"])
  ).trim();
  return branch.length > 0 ? branch : undefined;
};

const isMergeInProgress = async (cwd: string): Promise<boolean> => {
  try {
    await execFileAsync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
};

const formatPromptBlock = (value: string | undefined): string =>
  value && value.trim().length > 0 ? value.trim() : "(none)";

const buildMergeConflictPrompt = (
  input: HubMergeConflictResolutionInput,
): string => `# Hub merge conflict resolution

You are Sandcastle's Hub merge agent. A deterministic merge already ran and left this repository in a merge-conflict state.

## Task

- Task id: ${input.taskId}
- Title: ${input.title}
- Branch being merged: ${input.branch}
- Current base branch: ${input.baseBranch ?? "(unknown)"}
- Flow: ${input.flowId}

## Conflicted files

${input.conflictedFiles.map((file) => `- ${file}`).join("\n") || "(none reported)"}

## Git status

\`\`\`
${formatPromptBlock(input.gitStatus)}
\`\`\`

## Merge diagnostics

\`\`\`
${formatPromptBlock(input.diagnostics?.stderr ?? input.diagnostics?.stdout ?? input.diagnostics?.message)}
\`\`\`

## Required behavior

1. Inspect the conflicted files and understand both sides of the merge.
2. Resolve conflicts intelligently, preserving behavior from both the base branch and ${input.branch} where appropriate.
3. Do not close tasks, update Beads directly, create unrelated branches, or stash/delete Sandcastle runtime files.
4. After resolving conflicts, run \`git status --short\` and ensure there are no unmerged files.
5. Complete the merge commit with the existing merge message, for example \`git commit --no-edit\` after staging resolved files.
6. Run the repository verification command if one is obvious from project docs or scripts. If verification is not available, explain that in your final response.
7. Output \`<promise>COMPLETE</promise>\` only after the merge conflict is resolved and the merge commit is complete.
`;

export const createHubMergeConflictResolver = (options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): HubMergeConflictResolver => {
  return async (input) => {
    const config = readHubAgentConfig({
      env: options.env,
      homeDir: options.homeDir,
    });
    const roleEntry = config.roles.merge;
    if (!roleEntry) {
      return {
        outcome: "failed",
        message:
          "Missing Hub agent role config: merge. Run `sandcastle agent-config set-role merge --provider <provider> --model <model>`.",
      };
    }

    const agent = resolveHubAgentProvider(roleEntry);
    try {
      await assertAgentCredentialsConfigured({
        providerName: agent.name,
        cwd: options.cwd,
        env: options.env,
      });

      const logDir = join(input.runDir, "logs");
      mkdirSync(logDir, { recursive: true });
      const result = await run({
        agent,
        sandbox: noSandbox(),
        cwd: options.cwd,
        prompt: buildMergeConflictPrompt(input),
        branchStrategy: { type: "head" },
        name: `merge-${input.taskId}`,
        logging: {
          type: "file",
          path: join(logDir, `${input.taskId}-merge.log`),
        },
      });

      if (!result.completionSignal) {
        return {
          outcome: "failed",
          message: "Merge agent finished without completion signal",
        };
      }

      const remainingConflicts = await listUnmergedFiles(options.cwd);
      if (remainingConflicts.length > 0) {
        return {
          outcome: "failed",
          message: `Merge agent left unresolved conflicts: ${remainingConflicts.join(", ")}`,
          diagnostics: {
            details: { remainingConflicts },
          },
        };
      }

      if (await isMergeInProgress(options.cwd)) {
        return {
          outcome: "failed",
          message:
            "Merge agent resolved files but left the merge commit unfinished.",
        };
      }

      return { outcome: "success" };
    } catch (error) {
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
        diagnostics: compactDiagnostics(extractErrorDiagnostics(error)),
      };
    }
  };
};

export const createHubFlowRunMerger = (options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly conflictResolver?: HubMergeConflictResolver;
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
        const conflictedFiles = await listUnmergedFiles(options.cwd);
        const gitStatus = await readGitStatusShort(options.cwd);
        const baseBranch = await readCurrentBranch(options.cwd);
        const conflictStartedAt = new Date().toISOString();
        appendHubTaskEvent(input.runDir, {
          type: "merge_conflict_resolution_started",
          runId: input.runId,
          batchId: input.batchId,
          taskId: input.taskId,
          branch: input.branch,
          createdAt: conflictStartedAt,
          status: "merging",
          diagnostics: {
            ...diagnostics,
            details: {
              ...diagnostics?.details,
              conflictedFiles,
              gitStatus,
              baseBranch,
            },
          },
        });

        const resolver =
          options.conflictResolver ??
          createHubMergeConflictResolver({
            cwd: options.cwd,
            env: options.env,
          });
        const resolution = await resolver({
          ...input,
          diagnostics,
          conflictedFiles,
          gitStatus,
          baseBranch,
        });
        const conflictFinishedAt = new Date().toISOString();

        const remainingConflicts = await listUnmergedFiles(options.cwd);
        const mergeStillInProgress = await isMergeInProgress(options.cwd);

        if (
          resolution.outcome === "success" &&
          remainingConflicts.length === 0 &&
          !mergeStillInProgress
        ) {
          appendHubTaskEvent(input.runDir, {
            type: "merge_conflict_resolution_succeeded",
            runId: input.runId,
            batchId: input.batchId,
            taskId: input.taskId,
            branch: input.branch,
            createdAt: conflictFinishedAt,
            status: "merging",
          });
          return { outcome: "success" };
        }

        const guardMessage =
          resolution.outcome === "success" && remainingConflicts.length > 0
            ? `Merge agent left unresolved conflicts: ${remainingConflicts.join(", ")}`
            : resolution.outcome === "success" && mergeStillInProgress
              ? "Merge agent resolved files but left the merge commit unfinished."
              : resolution.message;
        const resolutionDiagnostics = compactDiagnostics({
          ...diagnostics,
          ...resolution.diagnostics,
          message: guardMessage ?? resolution.diagnostics?.message,
          details: {
            ...diagnostics?.details,
            ...resolution.diagnostics?.details,
            conflictedFiles,
            gitStatus,
            baseBranch,
            ...(remainingConflicts.length > 0 ? { remainingConflicts } : {}),
            ...(mergeStillInProgress ? { mergeStillInProgress } : {}),
          },
        });
        appendHubTaskEvent(input.runDir, {
          type: "merge_conflict_resolution_failed",
          runId: input.runId,
          batchId: input.batchId,
          taskId: input.taskId,
          branch: input.branch,
          createdAt: conflictFinishedAt,
          status: "failed",
          failureReason: "merge_conflict",
          diagnostics: resolutionDiagnostics,
          diagnosticSummary: formatMergeDiagnosticSummary(
            resolutionDiagnostics,
          ),
        });

        return {
          outcome: "merge_conflict",
          message:
            guardMessage ??
            (error instanceof Error ? error.message : String(error)),
          diagnostics: resolutionDiagnostics,
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
        message: errorMessage(error),
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
