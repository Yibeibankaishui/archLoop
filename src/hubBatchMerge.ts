import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { assertAgentCredentialsConfigured } from "./agentAuthGuidance.js";
import { isAllowlistedBeadsRuntimePath } from "./hubBeadsRuntimePaths.js";
import {
  appendHubBatchEvent,
  appendHubTaskEvent,
  resolveHubRunEventsPaths,
  type HubTaskEvent,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import { readHubAgentConfig } from "./hubAgentConfig.js";
import {
  evaluateHubManagedBranchCleanup,
  findHubManagedBranchCleanupCandidate,
  type HubManagedBranchCleanupCandidate,
  type HubManagedBranchCleanupSkipDetail,
} from "./hubManagedBranchCleanup.js";
import { resolveHubAgentProvider } from "./hubProposalAgent.js";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import {
  bindHubLandingVerification,
  cleanupHubLandingCandidate,
  commitHubLandingTarget,
  computeHubVerifierFingerprint,
  createHubLandingCandidate,
  HubLandingWorktreeError,
  recordHubLandingTaskClosed,
  snapshotHubLandingCandidateGeneration,
  type HubLandingCandidate,
} from "./hubLanding.js";
import {
  computeHubLandingMergeInputFingerprint,
  isTransientHubLandingError,
  recordHubLandingRepairAttempt,
  remainingHubLandingRepairAttempts,
} from "./hubLandingRepair.js";
import {
  enterMergePhase,
  recordCloseFailure,
  recordMergeFailure,
  recordRepairExhaustion,
  recordTaskClosure,
  recordTaskMergeStarted,
  revertTaskToWaitingForMerge,
  type CloseHubTaskInput,
  type HubLandingRepairExhaustionReason,
  type HubTaskCloser,
  type HubTaskLifecycleContext,
} from "./hubTaskLifecycle.js";
import {
  isCompletedHubStatus,
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
  readonly hubProjectDir?: string;
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
  readonly integration?: HubMergeIntegration;
}

export interface HubMergeIntegration {
  readonly cwd: string;
  readonly finalize: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
  readonly transactionId?: string;
  readonly sourceOid?: string;
  readonly baseOid?: string;
  readonly candidateOid?: string;
  readonly bindVerification?: (fingerprint: string) => Promise<void> | void;
  readonly snapshotCandidate?: () => Promise<HubLandingCandidate>;
  readonly filteredBeadsRuntimePaths?: readonly string[];
}

export interface HubBranchCleanupResult {
  readonly outcome: "deleted" | "skipped" | "failed";
  readonly reasonCodes?: readonly string[];
  readonly diagnosticSummary?: string;
  readonly diagnostics?: HubMergeDiagnostics;
}

export type HubTaskBranchCleanup = (input: {
  readonly cwd: string;
  readonly runDir: string;
  readonly branch: string;
  readonly env?: NodeJS.ProcessEnv;
}) => Promise<HubBranchCleanupResult>;

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

export interface HubCandidateRepairInput extends HubVerifyTaskInput {
  readonly diagnosticSummary?: string;
}

export interface HubCandidateRepairResult {
  readonly outcome: "success" | "failed";
  readonly message?: string;
}

export type HubCandidateRepairer = (
  input: HubCandidateRepairInput,
) => Promise<HubCandidateRepairResult>;

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
  | "task_store_dirty"
  | "state_inconsistent";

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
  readonly blockingPaths?: readonly string[];
  readonly observedProjectedStatus?: HubTaskStatus;
  readonly missingClaimFields?: readonly string[];
  readonly staleClaimFields?: Readonly<Record<string, string>>;
  readonly suggestedRecovery?: string;
  readonly mergeReadyEventType?: string;
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
  readonly branchCleanup?: HubTaskBranchCleanup;
  readonly branchInspector?: HubMergeBranchInspector;
  readonly worktreeInspector?: HubMergeWorktreeInspector;
  readonly conflictResolver?: HubMergeConflictResolver;
  readonly candidateRepairer?: HubCandidateRepairer;
  readonly env?: NodeJS.ProcessEnv;
  readonly hubProjectDir?: string;
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
    | "pending"
    | "skipped";
  readonly hubStatus: HubTaskStatus;
  readonly failureReason?: HubFailureReason;
  readonly reason?: HubLandingRepairExhaustionReason | "unshipped_prerequisite";
  readonly diagnosticSummary?: string;
  readonly diagnostics?: HubMergeDiagnostics;
  readonly logPath?: string;
  readonly cleanup?: HubBranchCleanupResult;
  readonly transactionId?: string;
  readonly sourceOid?: string;
  readonly baseOid?: string;
  readonly candidateOid?: string;
  readonly filteredBeadsRuntimePaths?: readonly string[];
}

export interface RunHubBatchMergeResult {
  readonly runId: string;
  readonly batchId: string;
  readonly selectedTaskIds: readonly string[];
  readonly selectionDiagnostics: readonly HubBatchMergeSelectionDiagnostic[];
  readonly batchStatus: "done" | "partial_failed" | "skipped";
  readonly results: readonly HubBatchMergeTaskResult[];
}

type HubManagedBranchCleanupEvaluation = Awaited<
  ReturnType<typeof evaluateHubManagedBranchCleanup>
>;

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
  | "integration_candidate_created"
  | "verification_started"
  | "candidate_verification_passed"
  | "target_landing_succeeded"
  | "task_close_started"
  | "task_close_succeeded";

const appendMergeProgressEvent = (
  input: RunHubBatchMergeInput,
  event: {
    readonly type: MergeProgressEventType;
    readonly taskId: string;
    readonly branch: string;
    readonly claim: HubTaskProjection["claim"];
    readonly createdAt: string;
    readonly transactionId?: string;
    readonly sourceOid?: string;
    readonly baseOid?: string;
    readonly candidateOid?: string;
    readonly publishTargetOid?: string;
    readonly verifierFingerprint?: string;
    readonly filteredBeadsRuntimePaths?: readonly string[];
    readonly status?: string;
  },
): void => {
  appendHubTaskEvent(input.runDir, {
    type: event.type,
    runId: input.runId,
    batchId: input.batchId,
    taskId: event.taskId,
    branch: event.branch,
    createdAt: event.createdAt,
    status: event.status ?? "merging",
    claim: event.claim,
    transactionId: event.transactionId,
    sourceOid: event.sourceOid,
    baseOid: event.baseOid,
    candidateOid: event.candidateOid,
    publishTargetOid: event.publishTargetOid,
    verifierFingerprint: event.verifierFingerprint,
    filteredBeadsRuntimePaths: event.filteredBeadsRuntimePaths,
  });
};

type HubLandingIdentity = {
  readonly transactionId?: string;
  readonly sourceOid?: string;
  readonly baseOid?: string;
  readonly candidateOid?: string;
  readonly filteredBeadsRuntimePaths?: readonly string[];
};

type HubBatchMergeTaskResultExtras = {
  readonly failureReason?: HubFailureReason;
  readonly diagnosticSummary?: string;
  readonly diagnostics?: HubMergeDiagnostics;
  readonly cleanup?: HubBranchCleanupResult;
  readonly logPath?: string;
  readonly reason?: HubBatchMergeTaskResult["reason"];
} & HubLandingIdentity;

const toBatchMergeTaskResult = (
  task: HubTaskProjection,
  branch: string,
  outcome: HubBatchMergeTaskResult["outcome"],
  hubStatus: HubTaskStatus,
  extras: HubBatchMergeTaskResultExtras = {},
): HubBatchMergeTaskResult => ({
  taskId: task.id,
  title: task.title,
  branch,
  outcome,
  hubStatus,
  ...(extras.failureReason === undefined ? {} : { failureReason: extras.failureReason }),
  ...(extras.diagnosticSummary === undefined
    ? {}
    : { diagnosticSummary: extras.diagnosticSummary }),
  ...(extras.diagnostics === undefined ? {} : { diagnostics: extras.diagnostics }),
  ...(extras.cleanup === undefined ? {} : { cleanup: extras.cleanup }),
  ...(extras.logPath === undefined ? {} : { logPath: extras.logPath }),
  ...(extras.reason === undefined ? {} : { reason: extras.reason }),
  ...(extras.transactionId === undefined
    ? {}
    : { transactionId: extras.transactionId }),
  ...(extras.sourceOid === undefined ? {} : { sourceOid: extras.sourceOid }),
  ...(extras.baseOid === undefined ? {} : { baseOid: extras.baseOid }),
  ...(extras.candidateOid === undefined
    ? {}
    : { candidateOid: extras.candidateOid }),
  ...(extras.filteredBeadsRuntimePaths === undefined
    ? {}
    : { filteredBeadsRuntimePaths: extras.filteredBeadsRuntimePaths }),
});

const toLandingIdentity = (
  integration:
    | Pick<
        HubMergeIntegration,
        | "transactionId"
        | "sourceOid"
        | "baseOid"
        | "candidateOid"
        | "filteredBeadsRuntimePaths"
      >
    | undefined,
): HubLandingIdentity => ({
  transactionId: integration?.transactionId,
  sourceOid: integration?.sourceOid,
  baseOid: integration?.baseOid,
  candidateOid: integration?.candidateOid,
  filteredBeadsRuntimePaths: integration?.filteredBeadsRuntimePaths,
});

const recordBatchMergeCompleted = (
  input: RunHubBatchMergeInput,
  selectedTaskIds: readonly string[],
  batchStatus: "done" | "partial_failed",
  results: readonly HubBatchMergeTaskResult[],
): void => {
  const failedResult = results.find((result) => result.outcome !== "merged");
  appendHubBatchEvent(input.runDir, {
    type: "batch_merge_completed",
    runId: input.runId,
    batchId: input.batchId,
    createdAt: new Date().toISOString(),
    taskIds: selectedTaskIds,
    batchStatus,
    taskResults: results.map((result) => ({
      taskId: result.taskId,
      outcome: result.outcome,
      hubStatus: result.hubStatus,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(result.transactionId
        ? { transactionId: result.transactionId }
        : {}),
      ...(result.sourceOid ? { sourceOid: result.sourceOid } : {}),
      ...(result.baseOid ? { baseOid: result.baseOid } : {}),
      ...(result.candidateOid ? { candidateOid: result.candidateOid } : {}),
    })),
    ...(failedResult
      ? {
          failedTaskId: failedResult.taskId,
          failureReason: failedResult.reason ?? failedResult.failureReason,
          failureSummary: `${failedResult.taskId} ${failedResult.outcome}: ${
            failedResult.diagnosticSummary ??
            failedResult.reason ??
            failedResult.failureReason ??
            failedResult.outcome
          }`,
          diagnostics: failedResult.diagnostics,
        }
      : {}),
  });
};

const cleanupReasonCodes = (
  reasons: readonly HubManagedBranchCleanupSkipDetail[],
): readonly string[] => reasons.map((reason) => reason.reason);

const skippedCleanupResult = (
  evaluation: HubManagedBranchCleanupEvaluation,
  branch: string,
): HubBranchCleanupResult => {
  const candidate = findHubManagedBranchCleanupCandidate(evaluation, branch);
  return {
    outcome: "skipped",
    reasonCodes: candidate
      ? cleanupReasonCodes(candidate.skipReasons)
      : ["branch_not_tracked"],
  };
};

const deleteTaskBranch = async (input: {
  readonly cwd: string;
  readonly branch: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<HubBranchCleanupResult> => {
  try {
    await execFileAsync("git", ["branch", "-d", input.branch], {
      cwd: input.cwd,
      ...(input.env ? { env: input.env } : {}),
    });
    return { outcome: "deleted" };
  } catch (error) {
    const diagnostics = compactDiagnostics(extractErrorDiagnostics(error));
    return {
      outcome: "failed",
      reasonCodes: ["git_delete_failed"],
      diagnosticSummary:
        formatMergeDiagnosticSummary(diagnostics) ??
        errorMessage(error) ??
        `Failed to delete ${input.branch}`,
      ...(diagnostics ? { diagnostics } : {}),
    };
  }
};

const defaultHubTaskBranchCleanup: HubTaskBranchCleanup = async (input) => {
  const hubProjectDir = join(input.runDir, "..", "..");
  const evaluation = await evaluateHubManagedBranchCleanup({
    cwd: input.cwd,
    env: input.env,
    hubProjectDir,
  });
  const safeCandidate = evaluation.managedSafeCandidates.find(
    (candidate) => candidate.branch === input.branch,
  );
  if (!safeCandidate) {
    return skippedCleanupResult(evaluation, input.branch);
  }

  return deleteTaskBranch(input);
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

const recordTaskBranchCleanup = (
  input: RunHubBatchMergeInput,
  task: HubTaskProjection,
  branch: string,
  cleanup: HubBranchCleanupResult,
  createdAt: string,
): void => {
  appendHubTaskEvent(input.runDir, {
    type: "task_branch_cleanup",
    runId: input.runId,
    batchId: input.batchId,
    taskId: task.id,
    branch,
    createdAt,
    status: "done",
    claim: task.claim,
    cleanup: {
      policy: "safe_managed",
      outcome: cleanup.outcome,
      ...(cleanup.reasonCodes === undefined
        ? {}
        : { reasonCodes: cleanup.reasonCodes }),
      ...(cleanup.diagnosticSummary === undefined
        ? {}
        : { diagnosticSummary: cleanup.diagnosticSummary }),
      ...(cleanup.diagnostics === undefined
        ? {}
        : { diagnostics: cleanup.diagnostics }),
    },
  });
};

const runTaskBranchCleanup = async (
  input: RunHubBatchMergeInput,
  branch: string,
): Promise<HubBranchCleanupResult> => {
  try {
    return await (input.branchCleanup ?? defaultHubTaskBranchCleanup)({
      cwd: input.cwd,
      runDir: input.runDir,
      branch,
      env: input.env,
    });
  } catch (error) {
    return {
      outcome: "failed",
      reasonCodes: ["cleanup_executor_threw"],
      diagnosticSummary: errorMessage(error),
      diagnostics: compactDiagnostics(extractErrorDiagnostics(error)),
    };
  }
};

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

const isTaskStoreRuntimePath = (path: string): boolean =>
  isAllowlistedBeadsRuntimePath(normalizeGitPath(path));

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

export const inspectHubMergeWorktreeState = defaultWorktreeInspector;

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
    | "blockingPaths"
    | "observedProjectedStatus"
    | "missingClaimFields"
    | "staleClaimFields"
    | "suggestedRecovery"
    | "mergeReadyEventType"
  >,
): HubBatchMergeSelectionDiagnostic => ({
  taskId: task.id,
  title: task.title,
  hubStatus: task.hubStatus,
  batchId: task.claim?.batchId,
  ...input,
});

const parseHubTaskEvents = (runDir: string): readonly HubTaskEvent[] => {
  const { taskEventsPath } = resolveHubRunEventsPaths(runDir);
  if (!existsSync(taskEventsPath)) {
    return [];
  }

  return readFileSync(taskEventsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HubTaskEvent];
      } catch {
        return [];
      }
    });
};

const isMergeReadyTaskEvent = (event: HubTaskEvent): boolean =>
  event.type === "task_review_succeeded" ||
  (event.type === "task_implementation_succeeded" &&
    event.status === "waiting_for_merge");

const resolveMergeReadyEventsByTask = (
  runDir: string,
  batchId: string,
): ReadonlyMap<string, HubTaskEvent> => {
  const eventsByTask = new Map<string, HubTaskEvent>();

  for (const event of parseHubTaskEvents(runDir)) {
    if (event.batchId !== batchId || !isMergeReadyTaskEvent(event)) {
      continue;
    }
    eventsByTask.set(event.taskId, event);
  }

  return eventsByTask;
};

const collectMissingClaimFields = (
  task: HubTaskProjection,
): readonly string[] => {
  if (!task.claim) {
    return ["runId", "batchId", "branch"];
  }

  return (["runId", "batchId", "branch"] as const).filter(
    (field) => !task.claim?.[field],
  );
};

const collectStaleClaimFields = (
  task: HubTaskProjection,
  event: HubTaskEvent,
): Readonly<Record<string, string>> | undefined => {
  if (!task.claim) {
    return undefined;
  }

  const stale: Record<string, string> = {};
  const expected = {
    runId: event.runId,
    batchId: event.batchId,
    branch: event.branch,
  };

  for (const field of ["runId", "batchId", "branch"] as const) {
    const actualValue = task.claim[field];
    const expectedValue = expected[field];
    if (actualValue && expectedValue && actualValue !== expectedValue) {
      stale[field] = `${actualValue} != ${expectedValue}`;
    }
  }

  return Object.keys(stale).length > 0 ? stale : undefined;
};

const hasClaimDriftFromEvent = (
  task: HubTaskProjection,
  event: HubTaskEvent | undefined,
): boolean =>
  event !== undefined &&
  (collectMissingClaimFields(task).length > 0 ||
    collectStaleClaimFields(task, event) !== undefined);

const maybeBuildStateInconsistentDiagnostic = async (input: {
  readonly cwd: string;
  readonly task: HubTaskProjection;
  readonly event: HubTaskEvent | undefined;
  readonly branchInspector: HubMergeBranchInspector;
}): Promise<HubBatchMergeSelectionDiagnostic | undefined> => {
  const event = input.event;
  if (!event) {
    return undefined;
  }
  if (
    isCompletedHubStatus(input.task.hubStatus) ||
    input.task.beadsStatus === "closed"
  ) {
    return undefined;
  }

  const branch = event.branch;
  const branchState = await input.branchInspector(branch, input.cwd);
  if (!branchState.exists || !branchState.hasUnmergedWork) {
    return undefined;
  }
  const missingClaimFields = collectMissingClaimFields(input.task);
  const staleClaimFields = collectStaleClaimFields(input.task, event);

  return buildSelectionDiagnostic(input.task, {
    decision: "blocked",
    reason: "state_inconsistent",
    branch,
    observedProjectedStatus: input.task.hubStatus,
    missingClaimFields:
      missingClaimFields.length > 0 ? missingClaimFields : undefined,
    staleClaimFields,
    suggestedRecovery: `archloop tasks repair-state ${input.task.id}`,
    mergeReadyEventType: event.type,
    message: `Hub run events show ${event.type} for ${branch}, but the projected task status is ${input.task.hubStatus}. Repair Beads labels/metadata before merging: archloop tasks repair-state ${input.task.id}. If the task is failed or has stale execution state, archloop tasks recover ${input.task.id} may also apply.`,
  });
};

const evaluateHubBatchMergeSelection = async (input: {
  readonly cwd: string;
  readonly runDir: string;
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
  const mergeReadyEvents = resolveMergeReadyEventsByTask(
    input.runDir,
    input.batchId,
  );

  for (const task of input.tasks) {
    const mergeReadyEvent = mergeReadyEvents.get(task.id);
    if (task.hubStatus !== "waiting_for_merge") {
      const stateInconsistentDiagnostic =
        await maybeBuildStateInconsistentDiagnostic({
          cwd: input.cwd,
          task,
          event: mergeReadyEvent,
          branchInspector: input.branchInspector,
        });
      if (stateInconsistentDiagnostic) {
        diagnostics.push(stateInconsistentDiagnostic);
        continue;
      }

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

    if (hasClaimDriftFromEvent(task, mergeReadyEvent)) {
      const stateInconsistentDiagnostic =
        await maybeBuildStateInconsistentDiagnostic({
          cwd: input.cwd,
          task,
          event: mergeReadyEvent,
          branchInspector: input.branchInspector,
        });
      if (stateInconsistentDiagnostic) {
        diagnostics.push(stateInconsistentDiagnostic);
        continue;
      }
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
    if (input.worktreeState.dirtySourceFiles.length > 0) {
      selectedTasks.push(task);
      diagnostics.push(
        buildSelectionDiagnostic(task, {
          decision: "selected",
          reason: "selected",
          branch,
          message:
            taskStoreBranchFiles.length > 0
              ? `Branch ${branch} has unmerged work. Source worktree is dirty (${input.worktreeState.dirtySourceFiles.join(", ")}); Hub lands onto a Hub-owned publish target without mutating the checkout. Allowlisted Beads runtime/export files will be stripped from the landing candidate: ${taskStoreBranchFiles.join(", ")}.`
              : `Branch ${branch} has unmerged work. Source worktree is dirty (${input.worktreeState.dirtySourceFiles.join(", ")}); Hub lands onto a Hub-owned publish target without mutating the checkout.`,
          taskStoreBranchFiles:
            taskStoreBranchFiles.length > 0 ? taskStoreBranchFiles : undefined,
        }),
      );
      continue;
    }

    selectedTasks.push(task);
    const taskStoreDirtyFiles = input.worktreeState.dirtyTaskStoreFiles;
    const runtimeNotes = [
      taskStoreDirtyFiles.length > 0
        ? `task-store dirty: ${taskStoreDirtyFiles.join(", ")}. Hub merge preflight ignores local Beads runtime/export dirtiness.`
        : undefined,
      taskStoreBranchFiles.length > 0
        ? `Allowlisted Beads runtime/export files will be stripped from the landing candidate: ${taskStoreBranchFiles.join(", ")}.`
        : undefined,
    ].filter((note): note is string => note !== undefined);
    diagnostics.push(
      buildSelectionDiagnostic(task, {
        decision: "selected",
        reason: "selected",
        branch,
        message:
          runtimeNotes.length > 0
            ? `Branch ${branch} has unmerged work; ${runtimeNotes.join(" ")}`
            : `Branch ${branch} has unmerged work.`,
        taskStoreDirtyFiles:
          taskStoreDirtyFiles.length > 0 ? taskStoreDirtyFiles : undefined,
        taskStoreBranchFiles:
          taskStoreBranchFiles.length > 0 ? taskStoreBranchFiles : undefined,
      }),
    );
  }

  return { selectedTasks, diagnostics };
};

const readTaskBlockers = (
  task: HubTaskProjection,
): readonly string[] => {
  const metadata = task.metadata ?? {};
  for (const key of ["blockers", "blocked_by", "blockedBy"]) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      return value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      );
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
  }
  return [];
};

const orderTasksByDependencies = (
  tasks: readonly HubTaskProjection[],
): HubTaskProjection[] => {
  const selectedIds = new Set(tasks.map((task) => task.id));
  const remaining = [...tasks];
  const ordered: HubTaskProjection[] = [];
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((task) =>
      readTaskBlockers(task).every(
        (blockerId) =>
          !selectedIds.has(blockerId) ||
          ordered.some((ready) => ready.id === blockerId),
      ),
    );
    if (readyIndex >= 0) {
      const [next] = remaining.splice(readyIndex, 1);
      ordered.push(next!);
    } else {
      ordered.push(remaining.shift()!);
    }
  }
  return ordered;
};

const resolveMergeHubProjectDir = (input: RunHubBatchMergeInput): string =>
  input.hubProjectDir ?? join(input.runDir, "..", "..");

type MergeTaskSession = {
  readonly input: RunHubBatchMergeInput;
  readonly task: HubTaskProjection;
  readonly branch: string;
  readonly claim: HubTaskProjection["claim"];
  readonly lifecycleBase: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly context: HubTaskLifecycleContext;
    readonly taskId: string;
    readonly branch: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly claim: HubTaskProjection["claim"];
  };
  readonly hubProjectDir: string;
};

const toPendingMergeTaskResult = (
  session: MergeTaskSession,
  diagnosticSummary: string | undefined,
  diagnostics: HubMergeDiagnostics | undefined,
  landing: HubLandingIdentity,
): HubBatchMergeTaskResult => {
  const pendingTask = revertTaskToWaitingForMerge({
    cwd: session.input.cwd,
    env: session.input.env,
    task: session.task,
  });
  return toBatchMergeTaskResult(
    session.task,
    session.branch,
    "pending",
    pendingTask.hubStatus,
    { diagnosticSummary, diagnostics, ...landing },
  );
};

const settleUnsuccessfulMerge = (
  session: MergeTaskSession,
  mergeResult: HubMergeTaskResult,
  createdAt: string,
): HubBatchMergeTaskResult => {
  const diagnostics = buildMergeDiagnostics(mergeResult);
  const diagnosticSummary = formatMergeDiagnosticSummary(diagnostics);
  const landing = toLandingIdentity(mergeResult.integration);
  if (
    isTransientHubLandingError(mergeResult.diagnostics) ||
    isTransientHubLandingError(mergeResult.message)
  ) {
    return toPendingMergeTaskResult(
      session,
      diagnosticSummary,
      diagnostics,
      landing,
    );
  }
  if (mergeResult.outcome === "merge_conflict") {
    const lifecycleResult = recordRepairExhaustion({
      ...session.lifecycleBase,
      reason: "merge_conflict_unresolved",
      createdAt,
      diagnosticSummary,
      diagnostics,
    });
    return toBatchMergeTaskResult(
      session.task,
      session.branch,
      "merge_conflict",
      lifecycleResult.hubStatus,
      {
        diagnosticSummary,
        diagnostics,
        ...landing,
        reason: "merge_conflict_unresolved",
      },
    );
  }
  const lifecycleResult = recordMergeFailure({
    ...session.lifecycleBase,
    failureReason: "merge_failed",
    createdAt,
    diagnosticSummary,
    diagnostics,
  });
  return toBatchMergeTaskResult(
    session.task,
    session.branch,
    "merge_failed",
    lifecycleResult.hubStatus,
    {
      failureReason: "merge_failed",
      diagnosticSummary,
      diagnostics,
      ...landing,
    },
  );
};

const applyCandidateSnapshot = (
  mergeIntegration: HubMergeIntegration,
  snapshot: {
    readonly transactionId: string;
    readonly sourceOid: string;
    readonly baseOid: string;
    readonly candidateOid: string;
    readonly worktreeDir: string;
  },
): {
  readonly mergeIntegration: HubMergeIntegration;
  readonly landingIdentity: HubLandingIdentity;
} => {
  const landingIdentity = toLandingIdentity(snapshot);
  return {
    mergeIntegration: {
      ...mergeIntegration,
      ...landingIdentity,
      cwd: snapshot.worktreeDir,
    },
    landingIdentity,
  };
};

const remainingVerificationRepairs = (
  hubProjectDir: string,
  taskId: string,
  sourceOid: string | undefined,
): number => {
  if (sourceOid === undefined) {
    return 0;
  }
  return remainingHubLandingRepairAttempts({
    hubProjectDir,
    taskId,
    sourceOid,
    kind: "verification",
  });
};

const exhaustVerificationRepair = async (
  session: MergeTaskSession,
  mergeIntegration: HubMergeIntegration | undefined,
  landingIdentity: HubLandingIdentity,
  createdAt: string,
  diagnosticSummary: string | undefined,
): Promise<HubBatchMergeTaskResult> => {
  await mergeIntegration?.cleanup().catch(() => undefined);
  const lifecycleResult = recordRepairExhaustion({
    ...session.lifecycleBase,
    reason: "verification_failed",
    createdAt,
    diagnosticSummary,
  });
  return toBatchMergeTaskResult(
    session.task,
    session.branch,
    "verification_failed",
    lifecycleResult.hubStatus,
    {
      diagnosticSummary,
      logPath: resolveHubRunEventsPaths(session.input.runDir).taskEventsPath,
      ...landingIdentity,
      reason: "verification_failed",
    },
  );
};

const verifyWithBoundedRepair = async (
  session: MergeTaskSession,
  mergeIntegration: HubMergeIntegration | undefined,
  landingIdentity: HubLandingIdentity,
  mergeFinishedAt: string,
): Promise<
  | {
      readonly outcome: "verified";
      readonly mergeIntegration: HubMergeIntegration | undefined;
      readonly landingIdentity: HubLandingIdentity;
      readonly verifyFinishedAt: string;
    }
  | { readonly outcome: "failed"; readonly result: HubBatchMergeTaskResult }
> => {
  const { input, task, branch, claim, hubProjectDir } = session;
  const verifyInput = {
    flowId: input.flowId,
    taskId: task.id,
    title: task.title,
    branch,
    cwd: mergeIntegration?.cwd ?? input.cwd,
    runDir: input.runDir,
  };

  appendMergeProgressEvent(input, {
    type: "verification_started",
    taskId: task.id,
    branch,
    claim,
    createdAt: mergeFinishedAt,
    ...landingIdentity,
  });

  let activeIntegration = mergeIntegration;
  let activeLanding = landingIdentity;
  let verifyResult = await input.verifier(verifyInput);
  let verifyFinishedAt = new Date().toISOString();
  let candidateGeneration = 1;

  while (verifyResult.outcome !== "success") {
    const sourceOid = activeLanding.sourceOid;
    const remaining = remainingVerificationRepairs(
      hubProjectDir,
      task.id,
      sourceOid,
    );
    if (
      !sourceOid ||
      remaining <= 0 ||
      !input.candidateRepairer ||
      !activeIntegration
    ) {
      return {
        outcome: "failed",
        result: await exhaustVerificationRepair(
          session,
          activeIntegration,
          activeLanding,
          verifyFinishedAt,
          verifyResult.message,
        ),
      };
    }

    candidateGeneration += 1;
    recordHubLandingRepairAttempt({
      hubProjectDir,
      taskId: task.id,
      sourceOid,
      kind: "verification",
      fingerprint: activeLanding.candidateOid ?? sourceOid,
      candidateOid: activeLanding.candidateOid,
      candidateGeneration,
    });
    const repair = await input.candidateRepairer({
      ...verifyInput,
      cwd: activeIntegration.cwd,
      diagnosticSummary: verifyResult.message,
    });
    if (repair.outcome !== "success") {
      continue;
    }
    if (activeIntegration.snapshotCandidate) {
      const snapshot = await activeIntegration.snapshotCandidate();
      const applied = applyCandidateSnapshot(activeIntegration, snapshot);
      activeIntegration = applied.mergeIntegration;
      activeLanding = applied.landingIdentity;
    }
    appendMergeProgressEvent(input, {
      type: "verification_started",
      taskId: task.id,
      branch,
      claim,
      createdAt: new Date().toISOString(),
      ...activeLanding,
    });
    verifyResult = await input.verifier({
      ...verifyInput,
      cwd: activeIntegration.cwd,
    });
    verifyFinishedAt = new Date().toISOString();
  }

  return {
    outcome: "verified",
    mergeIntegration: activeIntegration,
    landingIdentity: activeLanding,
    verifyFinishedAt,
  };
};

const finalizeLandedCandidate = async (
  session: MergeTaskSession,
  mergeIntegration: HubMergeIntegration,
  landingIdentity: HubLandingIdentity,
): Promise<HubBatchMergeTaskResult | undefined> => {
  try {
    await mergeIntegration.finalize();
  } catch (error) {
    await mergeIntegration.cleanup().catch(() => undefined);
    const diagnostics = compactDiagnostics(extractErrorDiagnostics(error));
    const diagnosticSummary = formatMergeDiagnosticSummary(diagnostics);
    if (
      isTransientHubLandingError(error) ||
      isTransientHubLandingError(diagnostics)
    ) {
      return toPendingMergeTaskResult(
        session,
        diagnosticSummary,
        diagnostics,
        landingIdentity,
      );
    }
    const lifecycleResult = recordMergeFailure({
      ...session.lifecycleBase,
      failureReason: "merge_failed",
      createdAt: new Date().toISOString(),
      diagnosticSummary,
      diagnostics,
    });
    return toBatchMergeTaskResult(
      session.task,
      session.branch,
      "merge_failed",
      lifecycleResult.hubStatus,
      {
        failureReason: "merge_failed",
        diagnosticSummary,
        diagnostics,
        ...landingIdentity,
      },
    );
  }
  await mergeIntegration.cleanup().catch(() => undefined);
  return undefined;
};

const closeLandedTask = async (
  session: MergeTaskSession,
  landingIdentity: HubLandingIdentity,
  verifyFinishedAt: string,
): Promise<HubBatchMergeTaskResult> => {
  const { input, task, branch, claim, lifecycleBase, hubProjectDir } = session;
  try {
    const lifecycleResult = await recordTaskClosure({
      ...lifecycleBase,
      metadata: {
        ...lifecycleBase.metadata,
        ...(landingIdentity.transactionId
          ? {
              landingTransactionId: landingIdentity.transactionId,
              landingCandidateOid: landingIdentity.candidateOid,
              landingSourceOid: landingIdentity.sourceOid,
              landingBaseOid: landingIdentity.baseOid,
            }
          : {}),
      },
      createdAt: verifyFinishedAt,
      closer: input.closer,
    });
    appendMergeProgressEvent(input, {
      type: "task_close_succeeded",
      taskId: task.id,
      branch,
      claim,
      createdAt: new Date().toISOString(),
      status: lifecycleResult.hubStatus,
      ...landingIdentity,
      publishTargetOid: landingIdentity.candidateOid,
    });
    if (landingIdentity.transactionId && landingIdentity.candidateOid) {
      recordHubLandingTaskClosed({
        hubProjectDir,
        transactionId: landingIdentity.transactionId,
        taskId: task.id,
        candidateOid: landingIdentity.candidateOid,
      });
    }
    const cleanupResult = await runTaskBranchCleanup(input, branch);
    recordTaskBranchCleanup(
      input,
      task,
      branch,
      cleanupResult,
      new Date().toISOString(),
    );
    return toBatchMergeTaskResult(
      task,
      branch,
      "merged",
      lifecycleResult.hubStatus,
      { cleanup: cleanupResult, ...landingIdentity },
    );
  } catch {
    const lifecycleResult = recordCloseFailure({
      ...lifecycleBase,
      createdAt: new Date().toISOString(),
    });
    return toBatchMergeTaskResult(
      task,
      branch,
      "close_failed",
      lifecycleResult.hubStatus,
      {
        failureReason: lifecycleResult.failureReason,
        ...landingIdentity,
      },
    );
  }
};

const processMergeTask = async (
  input: RunHubBatchMergeInput,
  task: HubTaskProjection,
  claim: HubTaskProjection["claim"],
): Promise<HubBatchMergeTaskResult> => {
  const branch = resolveBranch(task);
  const context = toLifecycleContext(input);
  const startedAt = new Date().toISOString();
  const session: MergeTaskSession = {
    input,
    task,
    branch,
    claim,
    hubProjectDir: resolveMergeHubProjectDir(input),
    lifecycleBase: {
      cwd: input.cwd,
      env: input.env,
      context,
      taskId: task.id,
      branch,
      metadata: task.metadata,
      claim,
    },
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
    hubProjectDir: session.hubProjectDir,
  });
  const mergeFinishedAt = new Date().toISOString();
  if (mergeResult.outcome !== "success") {
    return settleUnsuccessfulMerge(session, mergeResult, mergeFinishedAt);
  }

  const mergeIntegration = mergeResult.integration;
  const landingIdentity = toLandingIdentity(mergeIntegration);

  appendMergeProgressEvent(input, {
    type: "integration_candidate_created",
    taskId: task.id,
    branch,
    claim,
    createdAt: mergeFinishedAt,
    ...landingIdentity,
  });

  const verified = await verifyWithBoundedRepair(
    session,
    mergeIntegration,
    landingIdentity,
    mergeFinishedAt,
  );
  if (verified.outcome === "failed") {
    return verified.result;
  }

  const verifierFingerprint = computeHubVerifierFingerprint(input.cwd);
  if (verified.mergeIntegration?.bindVerification) {
    await verified.mergeIntegration.bindVerification(verifierFingerprint);
  }

  appendMergeProgressEvent(input, {
    type: "candidate_verification_passed",
    taskId: task.id,
    branch,
    claim,
    createdAt: verified.verifyFinishedAt,
    ...verified.landingIdentity,
    verifierFingerprint,
  });

  if (verified.mergeIntegration) {
    const finalizeFailure = await finalizeLandedCandidate(
      session,
      verified.mergeIntegration,
      verified.landingIdentity,
    );
    if (finalizeFailure) {
      return finalizeFailure;
    }
  }

  appendMergeProgressEvent(input, {
    type: "target_landing_succeeded",
    taskId: task.id,
    branch,
    claim,
    createdAt: new Date().toISOString(),
    ...verified.landingIdentity,
    publishTargetOid: verified.landingIdentity.candidateOid,
    verifierFingerprint,
  });

  appendMergeProgressEvent(input, {
    type: "task_close_started",
    taskId: task.id,
    branch,
    claim,
    createdAt: verified.verifyFinishedAt,
    ...verified.landingIdentity,
  });

  return closeLandedTask(
    session,
    verified.landingIdentity,
    verified.verifyFinishedAt,
  );
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
    runDir: input.runDir,
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
  const shippedIds = new Set(
    board.tasks
      .filter((entry) => isCompletedHubStatus(entry.hubStatus))
      .map((entry) => entry.id),
  );
  const orderedTasks = orderTasksByDependencies(selectedTasks);
  for (const task of orderedTasks) {
    const claim = task.claim;
    const unshippedBlockers = readTaskBlockers(task).filter(
      (blockerId) => !shippedIds.has(blockerId),
    );
    if (unshippedBlockers.length > 0) {
      revertTaskToWaitingForMerge({
        cwd: input.cwd,
        env: input.env,
        task,
      });
      results.push(
        toBatchMergeTaskResult(
          task,
          resolveBranch(task),
          "skipped",
          "waiting_for_merge",
          {
            diagnosticSummary: `Waiting for unshipped prerequisite ${unshippedBlockers.join(", ")}.`,
            reason: "unshipped_prerequisite",
          },
        ),
      );
      continue;
    }

    const result = await processMergeTask(input, task, claim);
    results.push(result);
    if (result.outcome === "merged") {
      shippedIds.add(task.id);
    }
  }

  const batchStatus = results.every((result) => result.outcome === "merged")
    ? "done"
    : "partial_failed";
  recordBatchMergeCompleted(input, selectedTaskIds, batchStatus, results);

  return {
    runId: input.runId,
    batchId: input.batchId,
    selectedTaskIds,
    batchStatus,
    results,
    selectionDiagnostics: selection.diagnostics,
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

You are archLoop's Hub merge agent. A deterministic merge already ran and left this repository in a merge-conflict state.

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
3. Do not close tasks, update Beads directly, create unrelated branches, or stash/delete archLoop runtime files.
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
          "Missing Hub agent role config: merge. Run `archloop agent-config set-role merge --provider <provider> --model <model>`.",
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

const mergeConflictGuardMessage = (
  resolution: HubMergeConflictResolutionResult,
  remainingConflicts: readonly string[],
  mergeStillInProgress: boolean,
): string | undefined => {
  if (resolution.outcome !== "success") {
    return resolution.message;
  }
  if (remainingConflicts.length > 0) {
    return `Merge agent left unresolved conflicts: ${remainingConflicts.join(", ")}`;
  }
  if (mergeStillInProgress) {
    return "Merge agent resolved files but left the merge commit unfinished.";
  }
  return resolution.message;
};

const runGitMergeInCwd = async (options: {
  readonly input: HubMergeTaskInput;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly hubProjectDir?: string;
  readonly conflictResolver?: HubMergeConflictResolver;
}): Promise<HubMergeTaskResult> => {
  const { input } = options;
  try {
    await execFileAsync(
      "git",
      ["merge", "--no-ff", input.branch, "-m", `Merge ${input.branch}`],
      { cwd: options.cwd },
    );
    return { outcome: "success" };
  } catch (error) {
    const diagnostics = compactDiagnostics(extractErrorDiagnostics(error));
    if (
      isTransientHubLandingError(error) ||
      isTransientHubLandingError(diagnostics)
    ) {
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
        diagnostics,
      };
    }
    if (isMergeConflict(error, diagnostics)) {
      const conflictedFiles = await listUnmergedFiles(options.cwd);
      const gitStatus = await readGitStatusShort(options.cwd);
      const baseBranch = await readCurrentBranch(options.cwd);
      const sourceOid = (
        await readGitStdout(options.cwd, [
          "rev-parse",
          `${input.branch}^{commit}`,
        ])
      ).trim();
      const baseOid = (
        await readGitStdout(options.cwd, ["rev-parse", "HEAD"])
      ).trim();
      const fingerprint = computeHubLandingMergeInputFingerprint({
        sourceOid,
        baseOid,
      });
      const hubProjectDir =
        options.hubProjectDir ??
        input.hubProjectDir ??
        join(input.runDir, "..", "..");
      const resolver =
        options.conflictResolver ??
        createHubMergeConflictResolver({
          cwd: options.cwd,
          env: options.env,
        });

      let lastMessage =
        error instanceof Error ? error.message : String(error);
      let lastDiagnostics = diagnostics;
      while (
        remainingHubLandingRepairAttempts({
          hubProjectDir,
          taskId: input.taskId,
          sourceOid,
          kind: "merge_conflict",
          fingerprint,
        }) > 0
      ) {
        recordHubLandingRepairAttempt({
          hubProjectDir,
          taskId: input.taskId,
          sourceOid,
          kind: "merge_conflict",
          fingerprint,
        });
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
            ...lastDiagnostics,
            details: {
              ...lastDiagnostics?.details,
              conflictedFiles,
              gitStatus,
              baseBranch,
            },
          },
        });

        const resolution = await resolver({
          ...input,
          cwd: options.cwd,
          diagnostics: lastDiagnostics,
          conflictedFiles: await listUnmergedFiles(options.cwd),
          gitStatus: await readGitStatusShort(options.cwd),
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

        const guardMessage = mergeConflictGuardMessage(
          resolution,
          remainingConflicts,
          mergeStillInProgress,
        );
        lastMessage = guardMessage ?? lastMessage;
        lastDiagnostics = compactDiagnostics({
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
          status: "merging",
          failureReason: "merge_conflict",
          diagnostics: lastDiagnostics,
          diagnosticSummary: formatMergeDiagnosticSummary(lastDiagnostics),
        });
      }

      return {
        outcome: "merge_conflict",
        message: lastMessage,
        diagnostics: lastDiagnostics,
      };
    }

    return {
      outcome: "failed",
      message: error instanceof Error ? error.message : String(error),
      diagnostics,
    };
  }
};

export const createHubCandidateRepairer = (options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): HubCandidateRepairer => {
  return async (input) => {
    const config = readHubAgentConfig({
      env: options.env,
      homeDir: options.homeDir,
    });
    const roleEntry = config.roles.implementation ?? config.roles.merge;
    if (!roleEntry) {
      return {
        outcome: "failed",
        message:
          "Missing Hub agent role config: implementation. Run `archloop agent-config set-role implementation --provider <provider> --model <model>`.",
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
        cwd: input.cwd,
        prompt: `Repair the Hub landing candidate so full verification succeeds.

Task: ${input.taskId} (${input.title})
Branch: ${input.branch}

Verification failure:
${input.diagnosticSummary ?? "verification failed"}

Required behavior:
1. Inspect the current worktree and fix the verification regression.
2. Do not close tasks, update Beads, or change unrelated files.
3. Leave a new commit on HEAD if files change.
4. Output <promise>COMPLETE</promise> only after the candidate is ready for full verification.
`,
        branchStrategy: { type: "head" },
        name: `candidate-repair-${input.taskId}`,
        logging: {
          type: "file",
          path: join(logDir, `${input.taskId}-candidate-repair.log`),
        },
      });
      if (!result.completionSignal) {
        return {
          outcome: "failed",
          message: "Candidate repair agent finished without completion signal",
        };
      }
      return { outcome: "success" };
    } catch (error) {
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
};

export const createHubFlowRunMerger = (options: {
  readonly cwd: string;
  readonly hubProjectDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly conflictResolver?: HubMergeConflictResolver;
}): HubFlowMerger => {
  return async (input) => {
    const hubProjectDir =
      options.hubProjectDir ??
      input.hubProjectDir ??
      join(input.runDir, "..", "..");
    try {
      const candidate = await createHubLandingCandidate({
        repoRoot: options.cwd,
        hubProjectDir,
        taskId: input.taskId,
        branch: input.branch,
        merge: async (worktreeDir) => {
          const mergeResult = await runGitMergeInCwd({
            input,
            cwd: worktreeDir,
            env: options.env,
            hubProjectDir,
            conflictResolver:
              options.conflictResolver ??
              createHubMergeConflictResolver({
                cwd: worktreeDir,
                env: options.env,
              }),
          });
          if (mergeResult.outcome !== "success") {
            const error = new Error(
              mergeResult.message ?? "Hub landing merge failed",
            ) as Error & { mergeResult: HubMergeTaskResult };
            error.mergeResult = mergeResult;
            throw error;
          }
        },
      });
      let activeCandidate = candidate;
      return {
        outcome: "success",
        integration: {
          cwd: activeCandidate.worktreeDir,
          transactionId: activeCandidate.transactionId,
          sourceOid: activeCandidate.sourceOid,
          baseOid: activeCandidate.baseOid,
          candidateOid: activeCandidate.candidateOid,
          filteredBeadsRuntimePaths: activeCandidate.filteredBeadsRuntimePaths,
          bindVerification: (fingerprint) => {
            bindHubLandingVerification({
              hubProjectDir,
              transactionId: activeCandidate.transactionId,
              taskId: activeCandidate.taskId,
              candidateOid: activeCandidate.candidateOid,
              verifierFingerprint: fingerprint,
              repoRoot: options.cwd,
            });
          },
          snapshotCandidate: async () => {
            activeCandidate = await snapshotHubLandingCandidateGeneration({
              repoRoot: options.cwd,
              hubProjectDir,
              candidate: activeCandidate,
            });
            return activeCandidate;
          },
          finalize: async () => {
            await commitHubLandingTarget({
              repoRoot: options.cwd,
              hubProjectDir,
              candidate: activeCandidate,
              verifierFingerprint: computeHubVerifierFingerprint(options.cwd),
            });
          },
          cleanup: async () => {
            await cleanupHubLandingCandidate({
              repoRoot: options.cwd,
              hubProjectDir,
              candidate: activeCandidate,
            });
          },
        },
      };
    } catch (error) {
      if (error instanceof HubLandingWorktreeError) {
        await execFileAsync(
          "git",
          ["worktree", "remove", "--force", error.worktreeDir],
          { cwd: options.cwd },
        ).catch(async () => {
          await rm(error.worktreeDir, { recursive: true, force: true });
        });
      }
      const mergeResult = (
        error instanceof HubLandingWorktreeError
          ? (error.details as { mergeResult?: HubMergeTaskResult } | undefined)
          : (error as { mergeResult?: HubMergeTaskResult })
      )?.mergeResult;
      if (mergeResult) {
        return mergeResult;
      }
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
        diagnostics: compactDiagnostics(extractErrorDiagnostics(error)),
      };
    }
  };
};

export const createHubFlowRunVerifier = (options: {
  readonly cwd: string;
}): HubFlowVerifier => {
  return async (input) => {
    const verifyScript = join(options.cwd, ".archloop", "verify.sh");
    if (!existsSync(verifyScript)) {
      return { outcome: "success" };
    }

    try {
      await execFileAsync(verifyScript, [], { cwd: input.cwd });
      return { outcome: "success" };
    } catch (error) {
      return {
        outcome: "failed",
        message: errorMessage(error),
      };
    }
  };
};

const formatCleanupResultSuffix = (
  cleanup: HubBranchCleanupResult | undefined,
): string => {
  if (!cleanup) {
    return "";
  }

  if (cleanup.outcome === "deleted") {
    return "; cleanup deleted";
  }

  if (cleanup.outcome === "skipped") {
    const reasons =
      cleanup.reasonCodes && cleanup.reasonCodes.length > 0
        ? ` (${cleanup.reasonCodes.join(", ")})`
        : "";
    return `; cleanup skipped${reasons}`;
  }

  const summary = cleanup.diagnosticSummary
    ? `: ${cleanup.diagnosticSummary}`
    : "";
  return `; cleanup failed${summary}`;
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
    const reasonSuffix = taskResult.reason ? `; reason=${taskResult.reason}` : "";
    const transactionSuffix = taskResult.transactionId
      ? `; transaction=${taskResult.transactionId}`
      : "";
    const oidSuffix = [
      taskResult.sourceOid ? `source=${taskResult.sourceOid}` : undefined,
      taskResult.baseOid ? `base=${taskResult.baseOid}` : undefined,
      taskResult.candidateOid ? `candidate=${taskResult.candidateOid}` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    const identitySuffix = oidSuffix.length > 0 ? `; ${oidSuffix}` : "";
    const cleanupSuffix = formatCleanupResultSuffix(taskResult.cleanup);
    lines.push(
      `  ${taskResult.taskId}: ${taskResult.outcome} -> ${taskResult.hubStatus}${diagnosticSuffix}${cleanupSuffix}${reasonSuffix}${transactionSuffix}${identitySuffix}`,
    );
  }

  return lines;
};
