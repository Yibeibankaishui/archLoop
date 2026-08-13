import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { assertAgentCredentialsConfigured } from "./agentAuthGuidance.js";
import { HubFlowError } from "./errors.js";
import type { AgentProvider } from "./AgentProvider.js";
import {
  appendHubRunEvent,
  appendHubBatchEvent,
  appendHubTaskEvent,
  createHubRunContext,
  createHubRunIdentifiers,
  observeHubRunEvents,
  type HubLandingReconciliationEvent,
  type HubRunCompletedBatchResult,
  type HubRunEventObserver,
  type HubRunStopReason,
  type HubTaskClaimMetadata,
  type HubTaskEvent,
  type HubTaskStoreMigrationEvent,
} from "./hubExecution.js";
import {
  createHubFlowRunMerger,
  createHubFlowRunVerifier,
  formatHubBatchMergeResultLines,
  inspectHubMergeWorktreeState,
  runHubBatchMerge,
  type HubFlowMerger,
  type HubFlowVerifier,
  type HubMergeWorktreeState,
  type RunHubBatchMergeResult,
} from "./hubBatchMerge.js";
import { getHubFlowDefinition, resolveHubFlowPromptPath } from "./hubFlows.js";
import {
  autoRecoverInterruptedHubTasks,
  formatHubRunAutoRecoverLines,
  type HubRunAutoRecoverSummary,
} from "./hubRunAutoRecover.js";
import { ensureHubLandingPolicy } from "./hubLandingPolicy.js";
import {
  beadsCloseEvidenceFromHubTask,
  formatHubLandingReconciliationMessage,
  reconcileHubLandingTransactions,
  type HubLandingReconciliationOutcome,
} from "./hubLandingReconciliation.js";
import type { HubLandingTaskCloser } from "./hubLanding.js";
import {
  ensureHubTaskStoreMigrated,
  formatHubTaskStoreMigrationMessage,
  throwIfHubTaskStoreSplitBrain,
  type HubTaskStoreMigrationOutcome,
} from "./hubTaskStoreMigration.js";
import {
  createHubProjectDirPhaseCompletionEventResolver,
  type RecoverHubTaskInput,
} from "./hubTaskRecover.js";
import {
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveArchloopUserDataDir,
} from "./projectStatus.js";
import {
  buildHubProjectDevelopmentContractPromptArgs,
  ensureHubProjectDevelopmentContractState,
  type EnsureHubProjectDevelopmentContractStateResult,
  type HubProjectDevelopmentContractState,
} from "./hubProjectDevelopmentContract.js";
import {
  claimHubTaskForImplementation,
  recordImplementationFailure,
  recordImplementationStarted,
  recordImplementationSuccess,
  recordHubTaskReviewFailure,
  recordHubTaskReviewSuccess,
  recordTaskClosure,
  type HubTaskLifecycleContext,
} from "./hubTaskLifecycle.js";
import {
  formatHubRetryPromptContext,
  prepareHubTaskRetry,
} from "./hubTaskRetry.js";
import { readTaskEvents } from "./hubRunEventLog.js";
import {
  readHubAgentConfig,
  type HubAgentRole,
  type HubAgentRoleEntry,
} from "./hubAgentConfig.js";
import {
  HUB_BATCH_DEFAULT_MAX_TASKS,
  HUB_BATCH_DEFAULT_STRATEGY,
  resolveEffectiveHubBatchSelection,
  selectHubFlowTasksWithBatchOptions,
  resolveFreshValidatedHubBatchSelection,
  type HubBatchPlannerResult,
  type HubBatchStrategy,
} from "./hubBatchPlanner.js";
import type { HubBatchPlannerInvoker } from "./hubBatchPlannerAgent.js";
import { resolveHubAgentProvider } from "./hubProposalAgent.js";
import {
  applyHubTaskNotes,
  cleanupHubTaskSnapshot,
  createHubTaskSnapshot,
  mergeHubAgentSandboxEnv,
} from "./hubTaskSnapshot.js";
import type { SandboxProvider } from "./SandboxProvider.js";
import {
  closeHubTask,
  loadHubTaskBoard,
  resolveHubTaskBranch,
  loadHubReadyQueue,
  type HubFailureReason,
  type HubTaskProjection,
} from "./taskBoard.js";

const execFileAsync = promisify(execFile);

export interface HubImplementTaskInput {
  readonly flowId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly promptFile: string;
  readonly cwd: string;
  readonly runDir: string;
  /**
   * The Hub project dir the run resolved to, so the default prior-merge
   * resolver reads the same event log the run writes. Optional: when omitted
   * (e.g. in unit tests that inject the resolver or lay out no run dir) the
   * default resolver derives it from `cwd` / `env`.
   */
  readonly hubProjectDir?: string;
  readonly projectDevelopmentContract: HubProjectDevelopmentContractState;
  readonly retryContext?: string;
  readonly preservedWorktreePath?: string;
  readonly signal?: AbortSignal;
}

export interface HubImplementTaskResult {
  readonly outcome: "success" | "agent_failed" | "sandbox_failed";
  readonly commits: readonly { readonly sha: string }[];
  readonly completionSignal?: string;
  readonly branchHasUnmergedWork?: boolean;
  /**
   * Set when the implementer observed a completion signal but no new branch
   * work because the task's implementation was already merged into the base
   * branch (a faithful re-run produces zero new commits). The per-task driver
   * closes the task as done instead of advancing it to review/merge (there is
   * nothing left to merge) or marking it agent_failed. See arch-d0c.
   */
  readonly alreadyMerged?: boolean;
  readonly message?: string;
}

export type HubFlowImplementer = (
  input: HubImplementTaskInput,
) => Promise<HubImplementTaskResult>;

export interface HubReviewTaskInput {
  readonly flowId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly promptFile: string;
  readonly cwd: string;
  readonly runDir: string;
  readonly implementCommitCount: number;
  readonly signal?: AbortSignal;
}

export interface HubReviewTaskResult {
  readonly outcome: "success" | "agent_failed" | "sandbox_failed";
  readonly commits: readonly { readonly sha: string }[];
  readonly completionSignal?: string;
  readonly message?: string;
}

export type HubFlowReviewer = (
  input: HubReviewTaskInput,
) => Promise<HubReviewTaskResult>;

export interface RunHubFlowInput {
  readonly flowId: string;
  readonly cwd?: string;
  readonly hubProjectDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly startedAt?: Date;
  readonly projectDevelopmentContract?: EnsureHubProjectDevelopmentContractStateResult;
  readonly implementer: HubFlowImplementer;
  readonly reviewer?: HubFlowReviewer;
  readonly merger?: HubFlowMerger;
  readonly verifier?: HubFlowVerifier;
  readonly runMergePhase?: boolean;
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
  readonly maxBatches?: number;
  readonly batchPlanner?: HubBatchPlannerInvoker;
  readonly onEvent?: HubRunEventObserver;
  readonly signal?: AbortSignal;
  /**
   * Disables the run-startup auto-recover step. Auto-recover is on by default;
   * tests that want to exercise the run without the startup recovery mutation
   * (or that pre-stage interrupted tasks they do not want recovered) pass
   * `false`.
   */
  readonly autoRecover?: boolean;
  /**
   * Forwarded to the startup auto-recover step's per-task recovery; resolves a
   * task's latest phase-completion event from the run event log. Injectable so
   * tests supply events without a real Hub run dir.
   */
  readonly resolveLatestPhaseCompletionEvent?: RecoverHubTaskInput["resolveLatestPhaseCompletionEvent"];
  /** Forwarded to the startup auto-recover step's per-task recovery. */
  readonly branchHasUnmergedWork?: RecoverHubTaskInput["branchHasUnmergedWork"];
}

export interface HubFlowTaskResult {
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly outcome:
    | "implemented"
    | "reviewed"
    | "claim_skipped"
    | "active_execution"
    | "agent_failed"
    | "sandbox_failed";
  readonly hubStatus: string;
  readonly failureReason?: HubFailureReason;
  readonly failureStage?: "implementation" | "review";
  readonly diagnosticSummary?: string;
  readonly logPath?: string;
  readonly commitCount: number;
  readonly implementationWork?: "new_commits" | "existing_unmerged_work";
}

export type HubFlowStopReason = HubRunStopReason;

export type HubFlowBatchResult = HubRunCompletedBatchResult;

export interface HubFlowWorktreeWarning {
  readonly dirtySourceFiles: readonly string[];
  readonly dirtyTaskStoreFiles: readonly string[];
}

export interface RunHubFlowResult {
  readonly flowId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly runDir: string;
  readonly mode: "new_batch" | "resumed_batch" | "no_ready";
  readonly completedBatchCount: number;
  readonly completedTaskCount: number;
  readonly stopReason: HubFlowStopReason;
  readonly batchResults: readonly HubFlowBatchResult[];
  readonly selectedTaskIds: readonly string[];
  readonly results: readonly HubFlowTaskResult[];
  readonly mergeResult?: RunHubBatchMergeResult;
  readonly resumedBatchId?: string;
  readonly unfinishedBatchIds: readonly string[];
  readonly batchSelection?: HubBatchPlannerResult;
  readonly fallbackReason?: string;
  readonly worktreeWarning?: HubFlowWorktreeWarning;
  readonly projectDevelopmentContractPath: string;
  readonly projectDevelopmentContractCreatedGenericFallback: boolean;
  /**
   * Summary of the run-startup auto-recover step: which interrupted tasks were
   * detected and where the event-aware router sent each one. Present on every
   * task-board run (zero recoveries when nothing was interrupted) so callers can
   * render the count unconditionally.
   */
  readonly autoRecoverSummary?: HubRunAutoRecoverSummary;
  readonly taskStoreMigration?: HubTaskStoreMigrationOutcome;
  readonly landingReconciliation?: HubLandingReconciliationOutcome;
}

type HubFlowLifecycleMutation = <T>(
  operation: () => T | Promise<T>,
) => Promise<T>;

interface ResumableHubFlowBatch {
  readonly runId: string;
  readonly batchId: string;
  readonly createdAt: string | undefined;
}

interface HubFlowBatchPlannedMetadata {
  readonly batchStrategyRequested?: HubBatchStrategy;
  readonly batchStrategyUsed?: HubBatchStrategy;
  readonly maxTasks?: number;
  readonly deferredTasks?: HubBatchPlannerResult["deferredTasks"];
  readonly fallbackReason?: string;
  readonly diagnosticReason?: string;
  readonly rationale?: string;
}

interface HubFlowBatchExecution {
  readonly selectedTaskIds: readonly string[];
  readonly results: readonly HubFlowTaskResult[];
  readonly batchSelection?: HubBatchPlannerResult;
  readonly fallbackReason?: string;
  readonly mergeResult?: RunHubBatchMergeResult;
  readonly batchResult?: HubFlowBatchResult;
}

const createHubFlowLifecycleMutationQueue = (): HubFlowLifecycleMutation => {
  let previous: Promise<void> = Promise.resolve();

  return async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = previous.then(operation, operation);
    previous = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
};

const resolveFailureReason = (
  outcome: HubImplementTaskResult["outcome"],
): Extract<HubFailureReason, "agent_failed" | "sandbox_failed"> =>
  outcome === "sandbox_failed" ? "sandbox_failed" : "agent_failed";

const resolveImplementationWork = (
  result: HubImplementTaskResult,
): HubFlowTaskResult["implementationWork"] => {
  if (result.commits.length > 0) {
    return "new_commits";
  }
  return result.branchHasUnmergedWork ? "existing_unmerged_work" : undefined;
};

const isSuccessfulImplementation = (result: HubImplementTaskResult): boolean =>
  result.outcome === "success" &&
  result.completionSignal !== undefined &&
  resolveImplementationWork(result) !== undefined;

const isSuccessfulReview = (result: HubReviewTaskResult): boolean =>
  result.outcome === "success" && result.completionSignal !== undefined;

const isSuccessfulHubTaskResult = (result: HubFlowTaskResult): boolean =>
  result.outcome === "implemented" || result.outcome === "reviewed";

const countSuccessfulHubTaskResults = (
  results: readonly HubFlowTaskResult[],
): number => results.filter(isSuccessfulHubTaskResult).length;

const countSuccessfulMergeResults = (
  result: RunHubBatchMergeResult | undefined,
): number => {
  if (!result) {
    return 0;
  }

  return result.results.filter((taskResult) => taskResult.outcome === "merged")
    .length;
};

const resolveHubFlowMode = (input: {
  readonly isResumingMergeBatch: boolean;
  readonly selectedTaskCount: number;
}): RunHubFlowResult["mode"] => {
  if (input.isResumingMergeBatch) {
    return "resumed_batch";
  }
  if (input.selectedTaskCount > 0) {
    return "new_batch";
  }
  return "no_ready";
};

export const parseHubFlowMaxBatches = (raw: string): number => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new HubFlowError({
      message: `Invalid --max-batches value "${raw}". Expected a positive integer.`,
    });
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1) {
    throw new HubFlowError({
      message: `Invalid --max-batches value "${raw}". Expected a positive integer.`,
    });
  }

  return parsed;
};

export const parseHubFlowIdleTimeoutSeconds = (raw: string): number => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new HubFlowError({
      message: `Invalid --idle-timeout value "${raw}". Expected a positive integer number of seconds.`,
    });
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1) {
    throw new HubFlowError({
      message: `Invalid --idle-timeout value "${raw}". Expected a positive integer number of seconds.`,
    });
  }

  return parsed;
};

const resolveHubFlowMaxBatches = (input: {
  readonly maxBatches?: number;
}): number => {
  if (input.maxBatches === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isInteger(input.maxBatches) || input.maxBatches < 1) {
    throw new HubFlowError({
      message: `Invalid --max-batches value "${input.maxBatches}". Expected a positive integer.`,
    });
  }

  return input.maxBatches;
};

const resolveHubFlowCompletedTaskCount = (input: {
  readonly taskResults: readonly HubFlowTaskResult[];
  readonly mergeResult?: RunHubBatchMergeResult;
}): number => {
  if (input.taskResults.length > 0) {
    return countSuccessfulHubTaskResults(input.taskResults);
  }
  return countSuccessfulMergeResults(input.mergeResult);
};

const resolveHubFlowWorktreeWarning = (
  state: HubMergeWorktreeState,
): HubFlowWorktreeWarning | undefined =>
  state.dirtySourceFiles.length > 0
    ? {
        dirtySourceFiles: state.dirtySourceFiles,
        dirtyTaskStoreFiles: state.dirtyTaskStoreFiles,
      }
    : undefined;

const hasSameTaskIds = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  const rightIds = new Set(right);
  return left.every((taskId) => rightIds.has(taskId));
};

const resolveHubFlowBatchStatus = (input: {
  readonly selectedTaskIds: readonly string[];
  readonly taskResults: readonly HubFlowTaskResult[];
  readonly mergeResult?: RunHubBatchMergeResult;
}): HubFlowBatchResult["batchStatus"] => {
  if (input.taskResults.some((result) => !isSuccessfulHubTaskResult(result))) {
    return "failed";
  }
  if (input.mergeResult && input.mergeResult.batchStatus !== "done") {
    return "failed";
  }
  if (
    input.mergeResult &&
    input.selectedTaskIds.length > 0 &&
    !hasSameTaskIds(input.selectedTaskIds, input.mergeResult.selectedTaskIds)
  ) {
    return "failed";
  }
  return "completed";
};

const resolveHubFlowBatchTaskIds = (input: {
  readonly selectedTaskIds: readonly string[];
  readonly mergeResult?: RunHubBatchMergeResult;
}): readonly string[] => {
  if (input.selectedTaskIds.length > 0) {
    return input.selectedTaskIds;
  }
  return input.mergeResult?.selectedTaskIds ?? [];
};

const resolveHubFlowBatchResult = (input: {
  readonly batchId: string;
  readonly selectedTaskIds: readonly string[];
  readonly taskResults: readonly HubFlowTaskResult[];
  readonly mergeResult?: RunHubBatchMergeResult;
}): HubFlowBatchResult | undefined => {
  if (
    input.selectedTaskIds.length === 0 &&
    input.taskResults.length === 0 &&
    !input.mergeResult
  ) {
    return undefined;
  }

  return {
    batchId: input.batchId,
    selectedTaskIds: resolveHubFlowBatchTaskIds(input),
    completedTaskCount: resolveHubFlowCompletedTaskCount(input),
    batchStatus: resolveHubFlowBatchStatus({
      selectedTaskIds: input.selectedTaskIds,
      taskResults: input.taskResults,
      mergeResult: input.mergeResult,
    }),
  };
};

const resolveMergeOnlyHubFlowBatchResult = (input: {
  readonly batchId: string;
  readonly mergeResult?: RunHubBatchMergeResult;
  readonly treatSkippedAsFailed?: boolean;
}): HubFlowBatchResult | undefined => {
  const { batchId, mergeResult, treatSkippedAsFailed = false } = input;
  if (!mergeResult) {
    return undefined;
  }

  if (mergeResult.batchStatus === "skipped") {
    if (!treatSkippedAsFailed) {
      return undefined;
    }

    return {
      batchId,
      selectedTaskIds: mergeResult.selectedTaskIds,
      completedTaskCount: 0,
      batchStatus: "failed",
    };
  }

  return resolveHubFlowBatchResult({
    batchId,
    selectedTaskIds: [],
    taskResults: [],
    mergeResult,
  });
};

const buildHubFlowBatchPlannedMetadata = (input: {
  readonly batchSelection?: HubBatchPlannerResult;
  readonly fallbackReason?: string;
}): HubFlowBatchPlannedMetadata => {
  if (!input.batchSelection) {
    return input.fallbackReason ? { fallbackReason: input.fallbackReason } : {};
  }

  return {
    batchStrategyRequested: input.batchSelection.batchStrategyRequested,
    batchStrategyUsed: input.batchSelection.batchStrategyUsed,
    maxTasks: input.batchSelection.maxTasks,
    deferredTasks: input.batchSelection.deferredTasks,
    ...(input.batchSelection.fallbackReason
      ? { fallbackReason: input.batchSelection.fallbackReason }
      : {}),
    ...(input.batchSelection.diagnosticReason
      ? { diagnosticReason: input.batchSelection.diagnosticReason }
      : {}),
    ...(input.batchSelection.rationale
      ? { rationale: input.batchSelection.rationale }
      : {}),
  };
};

const resolveHubFlowRoleEntry = (input: {
  readonly role: HubAgentRole;
  readonly roleEntry?: HubAgentRoleEntry;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): HubAgentRoleEntry => {
  if (input.roleEntry) {
    return input.roleEntry;
  }

  const config = readHubAgentConfig({
    env: input.env,
    homeDir: input.homeDir,
  });
  const entry = config.roles[input.role];
  if (!entry) {
    throw new Error(`Missing Hub agent role config: ${input.role}`);
  }
  return entry;
};

const readJsonlRecords = (path: string): readonly Record<string, unknown>[] => {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) {
        return [];
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
};

const findResumableHubFlowBatches = (input: {
  readonly hubProjectDir: string;
  readonly flowId: string;
  readonly tasks: readonly HubTaskProjection[];
}): readonly ResumableHubFlowBatch[] => {
  const batches = new Map<string, ResumableHubFlowBatch>();

  for (const task of input.tasks) {
    if (task.hubStatus !== "waiting_for_merge") {
      continue;
    }
    const runId = task.claim?.runId;
    const batchId = task.claim?.batchId;
    if (!runId || !batchId) {
      continue;
    }

    const batchEventsPath = join(
      input.hubProjectDir,
      "runs",
      runId,
      "events",
      "batch.jsonl",
    );
    const planned = readJsonlRecords(batchEventsPath).find(
      (event) =>
        event.type === "batch_planned" &&
        event.batchId === batchId &&
        event.flowId === input.flowId,
    );
    if (!planned) {
      continue;
    }

    batches.set(`${runId}:${batchId}`, {
      runId,
      batchId,
      createdAt:
        typeof planned.createdAt === "string" ? planned.createdAt : undefined,
    });
  }

  return [...batches.values()].sort((left, right) => {
    if (left.createdAt && right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.batchId.localeCompare(right.batchId);
  });
};

const SANDBOX_FAILURE_TAGS = new Set([
  "DockerError",
  "PodmanError",
  "ContainerStartTimeoutError",
  "WorktreeError",
  "CopyError",
  "SyncError",
]);

const getErrorTag = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { _tag?: unknown })._tag === "string"
    ? (error as { _tag: string })._tag
    : undefined;

const isSandboxFailureTag = (tag: string | undefined): boolean =>
  tag !== undefined && SANDBOX_FAILURE_TAGS.has(tag);

const buildHubAgentPromptArgs = (
  input: Pick<
    HubImplementTaskInput,
    "taskId" | "title" | "branch" | "retryContext"
  > & { readonly taskSnapshot: string },
  projectDevelopmentContract?: HubProjectDevelopmentContractState,
): Readonly<Record<string, string>> => ({
  TASK_ID: input.taskId,
  TASK_TITLE: input.title,
  BRANCH: input.branch,
  TASK_SNAPSHOT: input.taskSnapshot,
  RETRY_CONTEXT: input.retryContext ?? "",
  ...(projectDevelopmentContract
    ? buildHubProjectDevelopmentContractPromptArgs({
        contract: projectDevelopmentContract,
      })
    : {}),
});

const HUB_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

const readTextFileOrEmpty = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const readCompletionSignalFromLog = (logPath: string): string | undefined => {
  const content = readTextFileOrEmpty(logPath);
  return content.includes(HUB_COMPLETION_SIGNAL)
    ? HUB_COMPLETION_SIGNAL
    : undefined;
};

const DEFAULT_PROVIDER_RETRY_ATTEMPTS = 3;
const DEFAULT_PROVIDER_RETRY_BASE_MS = 5_000;
/** Multipliers for attempt backoffs: 5s / 20s / 60s when base is 5000ms. */
const PROVIDER_RETRY_BACKOFF_MULTIPLIERS = [1, 4, 12] as const;

const parsePositiveIntEnv = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return parsed > 0 ? parsed : fallback;
};

const resolveProviderRetryConfig = (env?: NodeJS.ProcessEnv) => {
  const attempts = parsePositiveIntEnv(
    env?.ARCHLOOP_PROVIDER_RETRY_ATTEMPTS ??
      process.env.ARCHLOOP_PROVIDER_RETRY_ATTEMPTS,
    DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  );
  const baseMsRaw =
    env?.ARCHLOOP_PROVIDER_RETRY_BASE_MS ??
    process.env.ARCHLOOP_PROVIDER_RETRY_BASE_MS;
  // 0 is allowed so tests can disable backoff sleeps.
  let baseMs = DEFAULT_PROVIDER_RETRY_BASE_MS;
  if (baseMsRaw !== undefined) {
    const trimmed = baseMsRaw.trim();
    if (/^\d+$/.test(trimmed)) {
      baseMs = Number.parseInt(trimmed, 10);
    }
  }

  return { attempts, baseMs };
};

export const matchProviderTransientReason = (
  message: string,
): string | undefined => {
  if (message.includes("API Error: 400 Invalid request parameters")) {
    return "API Error: 400 Invalid request parameters";
  }

  const retriableMatch = message.match(/RetriableError:\s*([^\n]+)/);
  if (retriableMatch?.[1]) {
    return `RetriableError: ${retriableMatch[1].trim()}`;
  }

  return undefined;
};

const providerRetryBackoffMs = (baseMs: number, retryIndex: number): number => {
  const multiplier =
    PROVIDER_RETRY_BACKOFF_MULTIPLIERS[
      Math.min(retryIndex, PROVIDER_RETRY_BACKOFF_MULTIPLIERS.length - 1)
    ] ?? 1;
  return baseMs * multiplier;
};

const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const withSnapshotSandbox = (
  sandbox: SandboxProvider,
  snapshotEnv: Readonly<Record<string, string>>,
): SandboxProvider => {
  const env = { ...mergeHubAgentSandboxEnv(sandbox.env, snapshotEnv) };
  switch (sandbox.tag) {
    case "bind-mount":
      return { ...sandbox, env };
    case "isolated":
      return { ...sandbox, env };
    case "none":
      return { ...sandbox, env };
  }
};

const applyHubAgentNotes = (input: {
  readonly cwd: string;
  readonly taskId: string;
  readonly branch: string;
  readonly runDir: string;
  readonly batchId: string;
  readonly status: string;
  readonly stdout?: string;
  readonly logPath: string;
  readonly env?: NodeJS.ProcessEnv;
}): void => {
  const text = `${input.stdout ?? ""}\n${readTextFileOrEmpty(input.logPath)}`;
  const result = applyHubTaskNotes({
    cwd: input.cwd,
    taskId: input.taskId,
    text,
    env: input.env,
  });
  if (result.status === "absent" || result.status === "replayed") {
    return;
  }

  const eventBase = {
    runId: basename(input.runDir),
    batchId: input.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: new Date().toISOString(),
    status: input.status,
  };

  if (result.status === "applied") {
    appendHubTaskEvent(input.runDir, {
      ...eventBase,
      type: "task_notes_applied",
      message: `Applied ${result.commentCount} Hub task note(s)`,
      diagnostics: {
        fingerprint: result.fingerprint,
        commentCount: result.commentCount,
      },
    });
    return;
  }

  appendHubTaskEvent(input.runDir, {
    ...eventBase,
    type: "task_notes_rejected",
    message: `Rejected Hub task notes: ${result.diagnostic}`,
    diagnostics: { diagnostic: result.diagnostic },
  });
};

const runHubAgent = async (input: {
  readonly agent: AgentProvider;
  readonly cwd: string;
  readonly promptFile: string;
  readonly flowId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly runDir: string;
  readonly name: string;
  readonly role: "implement" | "review";
  readonly logFileName: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly retryContext?: string;
  readonly projectDevelopmentContract?: HubProjectDevelopmentContractState;
  readonly showAgentStartup?: boolean;
  readonly idleTimeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly sandbox?: SandboxProvider;
  readonly createTaskSnapshot?: typeof createHubTaskSnapshot;
  readonly applyTaskNotes?: typeof applyHubAgentNotes;
  readonly cleanupTaskSnapshot?: typeof cleanupHubTaskSnapshot;
}) => {
  await assertAgentCredentialsConfigured({
    providerName: input.agent.name,
    cwd: input.cwd,
    env: input.env,
  });

  const { run } = await import("./run.js");
  const { noSandbox } = await import("./sandboxes/no-sandbox.js");
  const createTaskSnapshot = input.createTaskSnapshot ?? createHubTaskSnapshot;
  const cleanupTaskSnapshot =
    input.cleanupTaskSnapshot ?? cleanupHubTaskSnapshot;
  const applyTaskNotes = input.applyTaskNotes ?? applyHubAgentNotes;

  const envMaxIterations = Number(
    input.env?.ARCHLOOP_HUB_MAX_ITERATIONS ??
      process.env.ARCHLOOP_HUB_MAX_ITERATIONS,
  );
  const maxIterations =
    Number.isFinite(envMaxIterations) && envMaxIterations > 0
      ? Math.floor(envMaxIterations)
      : 20;

  const logPath = join(input.runDir, "logs", input.logFileName);
  const retryConfig = resolveProviderRetryConfig(input.env);
  const status = input.role === "review" ? "reviewing" : "implementing";

  const invoke = async () => {
    const snapshot = createTaskSnapshot({
      cwd: input.cwd,
      taskId: input.taskId,
      runDir: input.runDir,
      role: input.role,
      env: input.env,
    });
    try {
      return await run({
        agent: input.agent,
        sandbox: withSnapshotSandbox(
          input.sandbox ?? noSandbox(),
          snapshot.sandboxEnv,
        ),
        cwd: input.cwd,
        promptFile: input.promptFile,
        promptArgs: buildHubAgentPromptArgs(
          { ...input, taskSnapshot: snapshot.promptContent },
          input.projectDevelopmentContract,
        ),
        branchStrategy: { type: "branch", branch: input.branch },
        name: input.name,
        maxIterations,
        idleTimeoutSeconds: input.idleTimeoutSeconds,
        worktreeLeaseOwner: {
          kind: "hub",
          taskId: input.taskId,
          flowId: input.flowId,
          batchId: input.batchId,
        },
        logging: {
          type: "file",
          path: logPath,
          showStartup: input.showAgentStartup,
        },
        signal: input.signal,
      });
    } finally {
      cleanupTaskSnapshot(snapshot);
    }
  };

  const safeApplyNotes = (stdout?: string): void => {
    try {
      applyTaskNotes({
        cwd: input.cwd,
        taskId: input.taskId,
        branch: input.branch,
        runDir: input.runDir,
        batchId: input.batchId,
        status,
        stdout,
        logPath,
        env: input.env,
      });
    } catch {
      // Notes application must not fail Hub orchestration.
    }
  };

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const result = await invoke();
      safeApplyNotes(result.stdout);
      return result;
    } catch (error) {
      input.signal?.throwIfAborted();

      const completionAlreadyEmitted =
        readCompletionSignalFromLog(logPath) !== undefined;
      if (completionAlreadyEmitted) {
        safeApplyNotes();
        throw error;
      }

      const transientReason = matchProviderTransientReason(errorMessage(error));
      if (transientReason === undefined || attempt >= retryConfig.attempts) {
        safeApplyNotes();
        throw error;
      }

      const backoffMs = providerRetryBackoffMs(retryConfig.baseMs, attempt - 1);
      const backoffSeconds = backoffMs / 1000;
      appendHubTaskEvent(input.runDir, {
        type: "task_provider_retry",
        runId: basename(input.runDir),
        batchId: input.batchId,
        taskId: input.taskId,
        branch: input.branch,
        createdAt: new Date().toISOString(),
        status,
        reason: transientReason,
        message: `Retrying provider after transient error (attempt ${attempt}/${retryConfig.attempts}, backoff ${backoffSeconds}s)`,
        diagnostics: {
          attempt,
          maxAttempts: retryConfig.attempts,
          backoffSeconds,
          transientReason,
        },
      });

      await sleepMs(backoffMs, input.signal);
    }
  }
};

const reviewSelectedTask = async (
  input: RunHubFlowInput,
  context: ReturnType<typeof createHubRunContext>,
  task: HubTaskProjection,
  branch: string,
  claim: HubTaskClaimMetadata,
  taskMetadata: Readonly<Record<string, unknown>>,
  promptFile: string,
  implementCommitCount: number,
  mutateLifecycle: HubFlowLifecycleMutation,
): Promise<HubFlowTaskResult> => {
  const cwd = input.cwd ?? process.cwd();
  const reviewer = input.reviewer;
  if (!reviewer) {
    throw new Error(
      `Hub flow "${input.flowId}" requires a reviewer but none was provided`,
    );
  }

  const startedAt = new Date().toISOString();
  appendHubTaskEvent(context.runDir, {
    type: "task_review_started",
    runId: context.runId,
    batchId: context.batchId,
    taskId: task.id,
    branch,
    createdAt: startedAt,
    status: "reviewing",
    commitCount: implementCommitCount,
    claim,
  });

  let reviewResult: HubReviewTaskResult;
  try {
    reviewResult = await reviewer({
      flowId: input.flowId,
      batchId: context.batchId,
      taskId: task.id,
      title: task.title,
      branch,
      promptFile,
      cwd,
      runDir: context.runDir,
      implementCommitCount,
      signal: input.signal,
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    const message =
      error instanceof Error ? error.message : "Hub reviewer failed";
    reviewResult = {
      outcome: "sandbox_failed",
      commits: [],
      message,
    };
  }

  const finishedAt = new Date().toISOString();
  const commitCount = reviewResult.commits.length;
  const lifecycleBase = {
    cwd,
    runDir: context.runDir,
    runId: context.runId,
    batchId: context.batchId,
    env: input.env,
    taskId: task.id,
    branch,
    taskMetadata,
    claim,
    commitCount,
    createdAt: finishedAt,
  };

  const lifecycleResult = await mutateLifecycle(() =>
    isSuccessfulReview(reviewResult)
      ? recordHubTaskReviewSuccess(lifecycleBase)
      : recordHubTaskReviewFailure({
          ...lifecycleBase,
          failureReason: resolveFailureReason(reviewResult.outcome),
        }),
  );

  return {
    taskId: task.id,
    title: task.title,
    branch,
    outcome: lifecycleResult.outcome,
    hubStatus: lifecycleResult.hubStatus,
    commitCount,
    ...("failureReason" in lifecycleResult
      ? {
          failureReason: lifecycleResult.failureReason,
          failureStage: "review" as const,
          ...(reviewResult.message
            ? { diagnosticSummary: reviewResult.message }
            : {}),
          logPath: join(context.runDir, "logs", `${task.id}-review.log`),
        }
      : {}),
  };
};

const implementSelectedTask = async (
  input: RunHubFlowInput,
  context: ReturnType<typeof createHubRunContext>,
  task: HubTaskProjection,
  promptFile: string,
  hasReviewer: boolean,
  reviewPromptFile: string | undefined,
  mutateLifecycle: HubFlowLifecycleMutation,
): Promise<HubFlowTaskResult> => {
  const cwd = input.cwd ?? process.cwd();
  const branch = resolveHubTaskBranch(task.id, task.title);
  const retryPreparation = await prepareHubTaskRetry({
    repoDir: cwd,
    branch,
    taskId: task.id,
  });

  if (retryPreparation.status === "active_execution") {
    appendHubTaskEvent(context.runDir, {
      type: "task_retry_blocked",
      runId: context.runId,
      batchId: context.batchId,
      taskId: task.id,
      branch,
      createdAt: new Date().toISOString(),
      status: task.hubStatus,
      reason: "active_worktree_lease",
      message: retryPreparation.message,
    });

    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome: "active_execution",
      hubStatus: task.hubStatus,
      commitCount: 0,
    };
  }

  if (retryPreparation.status === "lease_malformed") {
    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome: "sandbox_failed",
      hubStatus: task.hubStatus,
      failureReason: "sandbox_failed",
      diagnosticSummary: retryPreparation.message,
      commitCount: 0,
    };
  }

  const retryContext = formatHubRetryPromptContext({
    branch,
    preservedWorktreePath: retryPreparation.preservedWorktreePath,
    hasDirtyWork: retryPreparation.hasDirtyWork,
  });

  const claimResult = await mutateLifecycle(() =>
    claimHubTaskForImplementation({
      cwd,
      taskId: task.id,
      branch,
      hubProjectDir: context.hubProjectDir,
      runId: context.runId,
      batchId: context.batchId,
      startedAt: input.startedAt,
      env: input.env,
    }),
  );

  if (claimResult.outcome === "skipped") {
    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome: "claim_skipped",
      hubStatus: claimResult.task.hubStatus,
      commitCount: 0,
    };
  }

  const claim = claimResult.claim;
  if (!claim) {
    throw new Error(
      `Hub task ${task.id} reached implementation without claim metadata`,
    );
  }

  const startedAt = (input.startedAt ?? new Date()).toISOString();
  const lifecycleContext: HubTaskLifecycleContext = {
    runId: context.runId,
    batchId: context.batchId,
    runDir: context.runDir,
  };
  await mutateLifecycle(() =>
    recordImplementationStarted({
      context: lifecycleContext,
      taskId: task.id,
      branch,
      hubStatus: claimResult.task.hubStatus,
      claim,
      createdAt: startedAt,
    }),
  );

  let implementationResult: HubImplementTaskResult;
  try {
    implementationResult = await input.implementer({
      flowId: input.flowId,
      batchId: context.batchId,
      taskId: task.id,
      title: task.title,
      branch,
      promptFile,
      cwd,
      runDir: context.runDir,
      hubProjectDir: context.hubProjectDir,
      projectDevelopmentContract: input.projectDevelopmentContract!,
      retryContext,
      preservedWorktreePath: retryPreparation.preservedWorktreePath,
      signal: input.signal,
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    const message =
      error instanceof Error ? error.message : "Hub implementer failed";
    implementationResult = {
      outcome: "sandbox_failed",
      commits: [],
      message,
    };
  }

  const finishedAt = new Date().toISOString();

  // The implementer recognized an already-merged re-run: the agent signaled
  // completion with no new branch work because the task's implementation was
  // previously merged into the base branch (arch-d0c). There is nothing left to
  // review or merge — the work is already on the lineage — so record the
  // implementation success and close the task as done directly, instead of
  // advancing it to reviewing/waiting_for_merge (where the merge phase would
  // strand a branch with no unmerged work) or marking it agent_failed.
  if (implementationResult.alreadyMerged === true) {
    const { task: updatedTask } = await mutateLifecycle(() =>
      recordImplementationSuccess({
        cwd,
        env: input.env,
        context: lifecycleContext,
        taskId: task.id,
        branch,
        metadata: claimResult.task.metadata,
        claim,
        commitCount: implementationResult.commits.length,
        hasReviewer: false,
        branchHasUnmergedWork: false,
        implementationWork: undefined,
        createdAt: finishedAt,
      }),
    );
    const closure = await mutateLifecycle(() =>
      recordTaskClosure({
        cwd,
        env: input.env,
        context: lifecycleContext,
        taskId: task.id,
        branch,
        metadata: claimResult.task.metadata,
        claim,
        createdAt: finishedAt,
      }),
    );
    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome: "implemented",
      hubStatus: closure.hubStatus ?? updatedTask.hubStatus,
      commitCount: implementationResult.commits.length,
    };
  }

  if (isSuccessfulImplementation(implementationResult)) {
    const implementationWork = resolveImplementationWork(implementationResult);
    const { task: updatedTask } = await mutateLifecycle(() =>
      recordImplementationSuccess({
        cwd,
        env: input.env,
        context: lifecycleContext,
        taskId: task.id,
        branch,
        metadata: claimResult.task.metadata,
        claim,
        commitCount: implementationResult.commits.length,
        hasReviewer,
        branchHasUnmergedWork:
          implementationResult.branchHasUnmergedWork === true,
        implementationWork,
        createdAt: finishedAt,
      }),
    );

    if (hasReviewer) {
      return reviewSelectedTask(
        input,
        context,
        task,
        branch,
        claim,
        claimResult.task.metadata,
        reviewPromptFile!,
        implementationResult.commits.length,
        mutateLifecycle,
      );
    }

    return {
      taskId: task.id,
      title: task.title,
      branch,
      outcome: "implemented",
      hubStatus: updatedTask.hubStatus,
      commitCount: implementationResult.commits.length,
      implementationWork,
    };
  }

  const failureReason = resolveFailureReason(implementationResult.outcome);
  const { task: updatedTask } = await mutateLifecycle(() =>
    recordImplementationFailure({
      cwd,
      env: input.env,
      context: lifecycleContext,
      taskId: task.id,
      branch,
      metadata: claimResult.task.metadata,
      claim,
      failureReason,
      commitCount: implementationResult.commits.length,
      createdAt: finishedAt,
    }),
  );

  return {
    taskId: task.id,
    title: task.title,
    branch,
    outcome:
      implementationResult.outcome === "sandbox_failed"
        ? "sandbox_failed"
        : "agent_failed",
    hubStatus: updatedTask.hubStatus,
    failureReason,
    failureStage: "implementation",
    ...(implementationResult.message
      ? { diagnosticSummary: implementationResult.message }
      : {}),
    logPath: join(context.runDir, "logs", `${task.id}.log`),
    commitCount: implementationResult.commits.length,
  };
};

const createHubLandingTaskCloseReader = (
  repoRoot: string,
  env: NodeJS.ProcessEnv | undefined,
) => {
  return (taskId: string) => {
    try {
      return beadsCloseEvidenceFromHubTask(
        loadHubTaskBoard(repoRoot, env).tasks.find(
          (entry) => entry.id === taskId,
        ),
      );
    } catch {
      return undefined;
    }
  };
};

const createHubLandingTaskCloser = (
  repoRoot: string,
  env: NodeJS.ProcessEnv | undefined,
): HubLandingTaskCloser =>
  async ({ taskId, transactionId, candidateOid }) => {
    closeHubTask({
      cwd: repoRoot,
      taskId,
      metadata: {
        landingTransactionId: transactionId,
        landingCandidateOid: candidateOid,
      },
      env,
    });
  };

const hubLandingReconciliationEventFields = (
  outcome: HubLandingReconciliationOutcome,
): Pick<
  HubLandingReconciliationEvent,
  | "kind"
  | "pendingCount"
  | "reconstructedCount"
  | "message"
  | "integrityIncident"
> => ({
  kind: outcome.kind,
  pendingCount: outcome.pendingCount,
  reconstructedCount: outcome.reconstructedCount,
  message: formatHubLandingReconciliationMessage(outcome),
  ...(outcome.integrityIncident
    ? { integrityIncident: outcome.integrityIncident }
    : {}),
});

const hubTaskStoreMigrationEventFields = (
  outcome: Exclude<HubTaskStoreMigrationOutcome, { kind: "not_needed" }>,
): Pick<
  HubTaskStoreMigrationEvent,
  "kind" | "phase" | "beadsDir" | "message" | "reason" | "pendingUntil"
> => {
  const base = {
    kind: outcome.kind,
    beadsDir: outcome.beadsDir,
    message: formatHubTaskStoreMigrationMessage(outcome),
  };
  if (outcome.kind === "migrated") {
    return { ...base, phase: outcome.phase };
  }
  if (outcome.kind === "deferred") {
    return {
      ...base,
      phase: outcome.phase,
      reason: outcome.reason,
      pendingUntil: outcome.pendingUntil,
    };
  }
  return base;
};

const runObservedHubFlow = async (
  input: RunHubFlowInput,
): Promise<RunHubFlowResult> => {
  const cwd = input.cwd ?? process.cwd();
  const repoRoot = resolveGitRepoRoot(cwd);
  const flowDefinition = getHubFlowDefinition(input.flowId);
  if (!flowDefinition) {
    throw new Error(`Unknown Hub flow: "${input.flowId}"`);
  }
  if (flowDefinition.kind === "proposal") {
    throw new Error(
      `Hub flow "${input.flowId}" is a proposal flow and must be executed through archloop run --flow or its task shortcut.`,
    );
  }
  if (flowDefinition.hasReviewer && !input.reviewer) {
    throw new Error(
      `Hub flow "${input.flowId}" requires a reviewer but none was provided`,
    );
  }

  const implementPromptFile = resolveHubFlowPromptPath(
    input.flowId,
    "implement",
  );
  const reviewPromptFile = flowDefinition.hasReviewer
    ? resolveHubFlowPromptPath(input.flowId, "review")
    : undefined;

  const hubProjectDir =
    input.hubProjectDir ??
    resolveHubProjectDir(resolveArchloopUserDataDir(input.env), repoRoot);
  ensureHubLandingPolicy({
    repoRoot,
    hubProjectDir,
  });
  const taskStoreMigration = ensureHubTaskStoreMigrated({
    repoRoot,
    hubProjectDir,
    env: input.env,
  });
  throwIfHubTaskStoreSplitBrain(taskStoreMigration);
  const landingReconciliationInput = {
    repoRoot,
    hubProjectDir,
    readTaskClose: createHubLandingTaskCloseReader(repoRoot, input.env),
    closeTask: createHubLandingTaskCloser(repoRoot, input.env),
  };
  const landingReconciliation = await reconcileHubLandingTransactions(
    landingReconciliationInput,
  );
  // Run-startup auto-recover: detect tasks left stuck in an execution status by
  // a previously-interrupted run and route each one through the event-aware
  // recovery wiring before the run loads the board for the resumed-batch scan.
  // This must precede findResumableHubFlowBatches so a `merging` task recovered
  // to `waiting_for_merge` (claim preserved) is picked up by the resumed-batch
  // merge path, and a `ready_for_agent` recovery is selected by the planner.
  const autoRecoverSummary =
    input.autoRecover === false
      ? undefined
      : await autoRecoverInterruptedHubTasks({
          cwd: repoRoot,
          env: input.env,
          // Read the event log from the same Hub project dir this run writes to,
          // so recovery sees the phase-completion events the interrupted run
          // recorded — rather than re-deriving the dir, which diverges when the
          // run uses an explicit hubProjectDir.
          resolveLatestPhaseCompletionEvent:
            input.resolveLatestPhaseCompletionEvent ??
            createHubProjectDirPhaseCompletionEventResolver(hubProjectDir),
          branchHasUnmergedWork: input.branchHasUnmergedWork,
        });
  const startedAt = input.startedAt ?? new Date();
  const projectDevelopmentContract =
    input.projectDevelopmentContract ??
    ensureHubProjectDevelopmentContractState({
      repoRoot,
      hubProjectDir,
      now: startedAt,
    });
  const resolvedInput = {
    ...input,
    projectDevelopmentContract,
  };
  const maxBatches = resolveHubFlowMaxBatches({
    maxBatches: input.maxBatches,
  });
  const initialWorktreeState = await inspectHubMergeWorktreeState(repoRoot);
  const worktreeWarning = resolveHubFlowWorktreeWarning(initialWorktreeState);
  const unfinishedBatches = findResumableHubFlowBatches({
    hubProjectDir,
    flowId: input.flowId,
    tasks: loadHubTaskBoard(repoRoot, input.env).tasks,
  });
  const unfinishedBatchIds = unfinishedBatches.map((batch) => batch.batchId);
  const resumedBatchId = unfinishedBatches[0]?.batchId;
  const isResumingMergeBatch = resumedBatchId !== undefined;
  const context = createHubRunContext({
    cwd: repoRoot,
    hubProjectDir,
    branch: `flow/${input.flowId}`,
    batchId: resumedBatchId,
    startedAt,
    env: input.env,
  });
  mkdirSync(join(context.runDir, "logs"), { recursive: true });
  if (taskStoreMigration.kind !== "not_needed") {
    appendHubRunEvent(context.runDir, {
      type: "task_store_migration",
      runId: context.runId,
      createdAt: new Date().toISOString(),
      ...hubTaskStoreMigrationEventFields(taskStoreMigration),
    });
  }
  const appendLandingReconciliationEvent = (
    outcome: HubLandingReconciliationOutcome,
  ): void => {
    if (outcome.kind === "clean") {
      return;
    }
    appendHubRunEvent(context.runDir, {
      type: "landing_reconciliation",
      runId: context.runId,
      createdAt: new Date().toISOString(),
      ...hubLandingReconciliationEventFields(outcome),
    });
  };
  appendLandingReconciliationEvent(landingReconciliation);
  const batchResults: HubFlowBatchResult[] = [];
  const results: HubFlowTaskResult[] = [];
  const selectedTaskIds: string[] = [];
  let batchSelection: HubBatchPlannerResult | undefined;
  let fallbackReason: string | undefined;
  let mergeResult: RunHubBatchMergeResult | undefined;
  let stopReason: HubFlowStopReason = "no_ready_tasks";
  const mutateLifecycle = createHubFlowLifecycleMutationQueue();
  const runMergePhase = input.runMergePhase ?? true;
  const merger =
    input.merger ??
    createHubFlowRunMerger({
      cwd: repoRoot,
      hubProjectDir,
      env: input.env,
    });
  const verifier =
    input.verifier ?? createHubFlowRunVerifier({ cwd: repoRoot });
  let currentBatchId = resumedBatchId ?? context.batchId;
  let batchStartedAt = startedAt;

  const appendBatchStarted = (batchId: string, createdAt: Date): void => {
    appendHubBatchEvent(context.runDir, {
      type: "batch_started",
      runId: context.runId,
      batchId,
      branch: `flow/${input.flowId}`,
      startedAt: createdAt.toISOString(),
    });
  };

  const startNextBatch = (): void => {
    currentBatchId = createHubRunIdentifiers().batchId;
    batchStartedAt = new Date();
    appendBatchStarted(currentBatchId, batchStartedAt);
  };

  const runBatchMergePhase = (
    batchId: string,
  ): Promise<RunHubBatchMergeResult | undefined> => {
    if (!runMergePhase) {
      return Promise.resolve(undefined);
    }

    return runHubBatchMerge({
      flowId: input.flowId,
      cwd: repoRoot,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env: input.env,
      hubProjectDir,
      merger,
      verifier,
    });
  };

  const executeSelectedBatch = async (
    batchId: string,
  ): Promise<HubFlowBatchExecution> => {
    const readyBoard = loadHubReadyQueue(repoRoot, input.env);
    const effectiveBatchSelection = resolveEffectiveHubBatchSelection({
      flowKind: flowDefinition.kind,
      batchStrategy: input.batchStrategy,
      maxTasks: input.maxTasks,
    });
    const batchStrategy =
      effectiveBatchSelection.batchStrategy ?? HUB_BATCH_DEFAULT_STRATEGY;
    const maxTasks =
      effectiveBatchSelection.maxTasks ?? HUB_BATCH_DEFAULT_MAX_TASKS;
    const {
      selectedTasks: initiallySelectedTasks,
      batchSelection: initialBatchSelection,
    } = await selectHubFlowTasksWithBatchOptions({
      flowId: input.flowId,
      cwd: repoRoot,
      env: input.env,
      runDir: context.runDir,
      candidates: readyBoard.tasks,
      batchStrategy,
      maxTasks,
      batchPlanner: input.batchPlanner,
      signal: input.signal,
    });
    const freshBoard = loadHubReadyQueue(repoRoot, input.env);
    const freshValidation = resolveFreshValidatedHubBatchSelection({
      initialSelectedTaskIds: initiallySelectedTasks.map((task) => task.id),
      freshCandidates: freshBoard.tasks,
      batchStrategy,
      maxTasks,
      batchSelection: initialBatchSelection,
    });
    const selectedTasks = freshValidation.selectedTasks;
    const selectedIds = selectedTasks.map((task) => task.id);
    const batchSelectionResult = freshValidation.batchSelection;
    const batchFallbackReason = freshValidation.fallbackReason;
    const batchPlannedMetadata = buildHubFlowBatchPlannedMetadata({
      batchSelection: batchSelectionResult,
      fallbackReason: batchFallbackReason,
    });

    appendHubBatchEvent(context.runDir, {
      type: "batch_planned",
      runId: context.runId,
      batchId,
      flowId: input.flowId,
      createdAt: batchStartedAt.toISOString(),
      taskIds: selectedIds,
      tasks: selectedTasks.map((task) => ({
        taskId: task.id,
        title: task.title,
      })),
      ...batchPlannedMetadata,
    });

    if (selectedTasks.length === 0) {
      return {
        selectedTaskIds: [],
        results: [],
        ...(batchSelectionResult
          ? { batchSelection: batchSelectionResult }
          : {}),
        ...(batchFallbackReason ? { fallbackReason: batchFallbackReason } : {}),
      };
    }

    const taskResults = await Promise.all(
      selectedTasks.map((task) =>
        implementSelectedTask(
          { ...resolvedInput, cwd: repoRoot },
          {
            ...context,
            batchId,
          },
          task,
          implementPromptFile,
          flowDefinition.hasReviewer === true,
          reviewPromptFile,
          mutateLifecycle,
        ),
      ),
    );

    const allSelectedTasksSucceeded = taskResults.every(
      isSuccessfulHubTaskResult,
    );
    const batchMergeResult = allSelectedTasksSucceeded
      ? await runBatchMergePhase(batchId)
      : undefined;
    const executedBatchResult = resolveHubFlowBatchResult({
      batchId,
      selectedTaskIds: selectedIds,
      taskResults,
      mergeResult: batchMergeResult,
    });

    return {
      selectedTaskIds: selectedIds,
      results: taskResults,
      ...(batchSelectionResult ? { batchSelection: batchSelectionResult } : {}),
      ...(batchFallbackReason ? { fallbackReason: batchFallbackReason } : {}),
      ...(batchMergeResult ? { mergeResult: batchMergeResult } : {}),
      ...(executedBatchResult ? { batchResult: executedBatchResult } : {}),
    };
  };

  if (isResumingMergeBatch && resumedBatchId) {
    const resumedMergeResult = await runBatchMergePhase(resumedBatchId);

    mergeResult = resumedMergeResult;
    const resumedBatchResult = resolveMergeOnlyHubFlowBatchResult({
      batchId: resumedBatchId,
      mergeResult: resumedMergeResult,
      treatSkippedAsFailed: true,
    });
    if (resumedBatchResult) {
      batchResults.push(resumedBatchResult);
    }
    if (resumedBatchResult?.batchStatus === "failed") {
      stopReason = "batch_failed";
    } else if (batchResults.length >= maxBatches) {
      stopReason = "max_batches_reached";
    } else {
      startNextBatch();
    }
  }

  while (
    stopReason !== "batch_failed" &&
    stopReason !== "max_batches_reached"
  ) {
    const batchExecution = await executeSelectedBatch(currentBatchId);
    if (batchSelection === undefined && batchExecution.batchSelection) {
      batchSelection = batchExecution.batchSelection;
    }
    if (fallbackReason === undefined && batchExecution.fallbackReason) {
      fallbackReason = batchExecution.fallbackReason;
    }
    if (batchExecution.mergeResult) {
      mergeResult = batchExecution.mergeResult;
    }

    if (batchExecution.selectedTaskIds.length > 0) {
      selectedTaskIds.push(...batchExecution.selectedTaskIds);
      results.push(...batchExecution.results);
    }

    if (batchExecution.batchResult) {
      batchResults.push(batchExecution.batchResult);
      if (batchExecution.batchResult.batchStatus === "failed") {
        stopReason = "batch_failed";
        break;
      }
    }

    if (batchExecution.selectedTaskIds.length === 0) {
      stopReason = "no_ready_tasks";
      break;
    }

    if (batchResults.length >= maxBatches) {
      stopReason = "max_batches_reached";
      break;
    }

    startNextBatch();
  }

  const completedBatchCount = batchResults.filter(
    (entry) => entry.batchStatus === "completed",
  ).length;
  const completedTaskCount = batchResults.reduce(
    (total, entry) => total + entry.completedTaskCount,
    0,
  );
  const mode = resolveHubFlowMode({
    isResumingMergeBatch,
    selectedTaskCount: selectedTaskIds.length,
  });
  const effectiveBatchId = resumedBatchId ?? context.batchId;

  const completedLandingReconciliation = await reconcileHubLandingTransactions(
    landingReconciliationInput,
  );
  appendLandingReconciliationEvent(completedLandingReconciliation);

  appendHubRunEvent(context.runDir, {
    type: "run_completed",
    runId: context.runId,
    flowId: input.flowId,
    createdAt: new Date().toISOString(),
    completedBatchCount,
    completedTaskCount,
    stopReason,
    batchResults,
  });

  return {
    flowId: input.flowId,
    runId: context.runId,
    batchId: effectiveBatchId,
    runDir: context.runDir,
    mode,
    completedBatchCount,
    completedTaskCount,
    stopReason,
    batchResults,
    selectedTaskIds,
    results,
    mergeResult,
    resumedBatchId,
    unfinishedBatchIds,
    batchSelection,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(worktreeWarning ? { worktreeWarning } : {}),
    projectDevelopmentContractPath: projectDevelopmentContract.contractPath,
    projectDevelopmentContractCreatedGenericFallback:
      projectDevelopmentContract.createdGenericFallback,
    autoRecoverSummary,
    taskStoreMigration,
    landingReconciliation: completedLandingReconciliation,
  };
};

export const runHubFlow = (input: RunHubFlowInput): Promise<RunHubFlowResult> =>
  observeHubRunEvents(input.onEvent, () => runObservedHubFlow(input));

export const formatHubFlowResultLines = (
  result: RunHubFlowResult,
): readonly string[] => {
  const selectedTaskCount = result.selectedTaskIds.length;
  const lines = [
    `Hub flow ${result.flowId}`,
    `Run id: ${result.runId}`,
    `Batch id: ${result.batchId}`,
    `Mode: ${result.mode}`,
    `Completed batches: ${result.completedBatchCount}`,
    `Completed tasks: ${result.completedTaskCount}`,
    `Stop reason: ${result.stopReason}`,
    `Selected tasks: ${selectedTaskCount}`,
  ];
  for (const line of formatHubRunAutoRecoverLines(result.autoRecoverSummary)) {
    lines.push(line);
  }
  if (
    result.taskStoreMigration &&
    result.taskStoreMigration.kind !== "not_needed"
  ) {
    lines.push(formatHubTaskStoreMigrationMessage(result.taskStoreMigration));
  }
  if (
    result.landingReconciliation &&
    result.landingReconciliation.kind !== "clean"
  ) {
    lines.push(
      formatHubLandingReconciliationMessage(result.landingReconciliation),
    );
  }
  if (result.worktreeWarning) {
    lines.push(
      `Worktree warning: dirty source files detected before flow start: ${result.worktreeWarning.dirtySourceFiles.join(", ")}`,
    );
    lines.push(
      "Dirty source files only block Hub merge when a selected task branch would overwrite or conflict with those paths.",
    );
    lines.push(
      "If merge selection blocks, commit, stash, or discard the listed files, then rerun the same flow so waiting_for_merge tasks resume.",
    );
  }
  if (result.batchSelection) {
    lines.push(
      `Batch strategy: ${result.batchSelection.batchStrategyUsed} (max ${result.batchSelection.maxTasks})`,
    );
    if (
      result.batchSelection.batchStrategyRequested !==
      result.batchSelection.batchStrategyUsed
    ) {
      lines.push(
        `Batch strategy requested: ${result.batchSelection.batchStrategyRequested}`,
      );
    }
    if (result.batchSelection.fallbackReason) {
      lines.push(`Batch fallback: ${result.batchSelection.fallbackReason}`);
    }
    if (result.batchSelection.diagnosticReason) {
      lines.push(`Batch diagnostic: ${result.batchSelection.diagnosticReason}`);
    }
    if (result.batchSelection.rationale) {
      lines.push(`Batch planner rationale: ${result.batchSelection.rationale}`);
    }
    if (result.batchSelection.deferredTasks.length > 0) {
      lines.push(
        `Deferred tasks: ${result.batchSelection.deferredTasks
          .map((entry) => `${entry.taskId} (${entry.reason})`)
          .join(", ")}`,
      );
    }
  } else if (result.fallbackReason) {
    lines.push(`Batch fallback: ${result.fallbackReason}`);
  }
  if (result.projectDevelopmentContractCreatedGenericFallback) {
    lines.push(
      `Project development contract: created generic fallback at ${result.projectDevelopmentContractPath}. Re-run \`archloop project configure --project-profile <generic|node|python|cpp>\` to specialize it.`,
    );
  }
  if (result.resumedBatchId) {
    lines.push(`Resumed batch id: ${result.resumedBatchId}`);
  }

  if (selectedTaskCount === 0) {
    if (result.mode === "resumed_batch") {
      lines.push("No new tasks claimed; resuming prior merge-ready batch.");
    } else {
      lines.push("No ready tasks selected.");
      lines.push(`No unfinished ${result.flowId} batch found to resume.`);
    }
  } else {
    for (const taskResult of result.results) {
      const workSuffix =
        taskResult.implementationWork === "existing_unmerged_work"
          ? " (existing unmerged work)"
          : taskResult.implementationWork === "new_commits"
            ? ` (${taskResult.commitCount} new ${
                taskResult.commitCount === 1 ? "commit" : "commits"
              })`
            : "";
      lines.push(
        `  ${taskResult.taskId}: ${taskResult.outcome} -> ${taskResult.hubStatus}${workSuffix}`,
      );
    }
  }

  if (result.mergeResult) {
    lines.push("Merge phase:");
    for (const line of formatHubBatchMergeResultLines(result.mergeResult)) {
      lines.push(`  ${line}`);
    }
  }

  return lines;
};

/**
 * Pure selector over the Hub run event log: has this task previously reached
 * a merged/done milestone? A prior `target_landing_succeeded`,
 * `merge_succeeded`, `task_close_succeeded`, or `task_closed` proves the
 * task's described work already landed. Used by the implementer to distinguish
 * a faithful zero-new-commit re-run on already-landed work from a genuine
 * no-work failure (arch-d0c).
 *
 * Events from the *current* run do not carry these types before the
 * implementer returns (implementation is the first phase), so only a prior,
 * completed run can set this true — which is exactly the "already merged"
 * signal. Phase-completion events (`task_implementation_succeeded`,
 * `task_review_succeeded`) are deliberately NOT enough here: they prove a
 * phase finished, not that the work reached the base branch.
 */
const hasPriorMergedCompletion = (
  events: readonly HubTaskEvent[],
  taskId: string,
): boolean =>
  events.some(
    (event) =>
      event.taskId === taskId &&
      (event.type === "target_landing_succeeded" ||
        event.type === "task_close_succeeded" ||
        event.type === "merge_succeeded" ||
        event.type === "task_closed"),
  );

/**
 * Resolves whether a task's implementation was previously merged/done, by
 * reading the Hub run event log with the shared `readTaskEvents` reader (the
 * single event-log reader, so no reading code is duplicated) and applying the
 * pure {@link hasPriorMergedCompletion} selector. Injectable so tests supply a
 * result without a real Hub run dir; the default scans the Hub project dir the
 * run resolved (passed per-task as `hubProjectDir`) or, failing that, the dir
 * derived from `cwd` / `env`.
 */
export type ResolvePriorMergedCompletion = (
  input: Readonly<{
    cwd: string;
    taskId: string;
    hubProjectDir?: string;
    env?: NodeJS.ProcessEnv;
  }>,
) => Promise<boolean>;

const defaultResolvePriorMergedCompletion: ResolvePriorMergedCompletion =
  async ({ cwd, taskId, hubProjectDir, env }) => {
    const projectDir =
      hubProjectDir ??
      resolveHubProjectDir(
        resolveArchloopUserDataDir(env ?? process.env),
        resolveGitRepoRoot(cwd),
      );
    return hasPriorMergedCompletion(readTaskEvents(projectDir), taskId);
  };

const hasBranchUnmergedWork = async (
  cwd: string,
  branch: string,
): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", `HEAD..${branch}`],
      { cwd, encoding: "utf8" },
    );
    return Number(String(stdout).trim()) > 0;
  } catch {
    return false;
  }
};

const collectBranchCommits = async (
  cwd: string,
  branch: string,
): Promise<{ sha: string }[]> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--reverse", `HEAD..${branch}`],
      { cwd, encoding: "utf8" },
    );
    const lines = String(stdout).trim();
    if (!lines) {
      return [];
    }
    return lines.split("\n").map((sha) => ({ sha }));
  } catch {
    return [];
  }
};

const resolveHubFlowRunnerAgent = (
  role: HubAgentRole,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homeDir?: string;
    readonly roleEntry?: HubAgentRoleEntry;
  },
): AgentProvider =>
  resolveHubAgentProvider(
    resolveHubFlowRoleEntry({
      role,
      roleEntry: options.roleEntry,
      env: options.env,
      homeDir: options.homeDir,
    }),
  );

const buildHubFlowRunnerFailure = (
  error: unknown,
): Pick<HubImplementTaskResult, "outcome" | "commits" | "message"> => {
  const message = error instanceof Error ? error.message : String(error);
  if (isSandboxFailureTag(getErrorTag(error))) {
    return {
      outcome: "sandbox_failed",
      commits: [],
      message,
    };
  }

  return {
    outcome: "agent_failed",
    commits: [],
    message,
  };
};

export const createHubFlowRunImplementer = (options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly roleEntry?: HubAgentRoleEntry;
  readonly showAgentStartup?: boolean;
  readonly idleTimeoutSeconds?: number;
  readonly sandbox?: SandboxProvider;
  readonly createTaskSnapshot?: typeof createHubTaskSnapshot;
  readonly cleanupTaskSnapshot?: typeof cleanupHubTaskSnapshot;
  /**
   * Override for whether the task's implementation was previously merged/done
   * (arch-d0c). The default reads the Hub run event log; inject a stub in
   * tests that do not lay out a real run dir.
   */
  readonly resolvePriorMergedCompletion?: ResolvePriorMergedCompletion;
}): HubFlowImplementer => {
  const agent = resolveHubFlowRunnerAgent("implementation", options);
  const resolvePriorMergedCompletion =
    options.resolvePriorMergedCompletion ?? defaultResolvePriorMergedCompletion;

  return async (input) => {
    const logFileName = `${input.taskId}.log`;
    const logPath = join(input.runDir, "logs", logFileName);
    let runResult: Awaited<ReturnType<typeof runHubAgent>> | undefined;
    let runError: unknown;

    try {
      runResult = await runHubAgent({
        agent,
        cwd: options.cwd,
        promptFile: input.promptFile,
        flowId: input.flowId,
        batchId: input.batchId,
        taskId: input.taskId,
        title: input.title,
        branch: input.branch,
        runDir: input.runDir,
        name: `implement-${input.taskId}`,
        role: "implement",
        logFileName,
        env: options.env,
        retryContext: input.retryContext,
        projectDevelopmentContract: input.projectDevelopmentContract,
        showAgentStartup: options.showAgentStartup,
        idleTimeoutSeconds: options.idleTimeoutSeconds,
        signal: input.signal,
        sandbox: options.sandbox,
        createTaskSnapshot: options.createTaskSnapshot,
        cleanupTaskSnapshot: options.cleanupTaskSnapshot,
      });
    } catch (error) {
      input.signal?.throwIfAborted();
      runError = error;
    }

    // Observe branch state before attributing provider exit-code failure.
    const observedCommits = await collectBranchCommits(
      options.cwd,
      input.branch,
    );
    const commits =
      observedCommits.length > 0 ? observedCommits : (runResult?.commits ?? []);
    const branchHasUnmergedWork = await hasBranchUnmergedWork(
      options.cwd,
      input.branch,
    );
    const hasBranchWork = commits.length > 0 || branchHasUnmergedWork;
    const completionSignal =
      runResult?.completionSignal ?? readCompletionSignalFromLog(logPath);

    if (hasBranchWork && completionSignal) {
      return {
        outcome: "success",
        commits,
        completionSignal,
        branchHasUnmergedWork,
      };
    }

    if (runError !== undefined) {
      return {
        ...buildHubFlowRunnerFailure(runError),
        commits,
      };
    }

    if (!completionSignal) {
      return {
        outcome: "agent_failed",
        commits,
        message: "Implementer finished without completion signal",
      };
    }

    // The agent signaled completion but produced no new branch work. Before
    // attributing this as a no-work failure, check whether the task's
    // implementation was already merged into the base branch: a faithful
    // re-run on already-merged work legitimately produces zero new commits
    // (arch-d0c). The prior-merge event is the only signal that distinguishes
    // this from a genuine no-work failure — the completion signal alone is not
    // trustworthy (a lazy agent can emit COMPLETE with no work), so trusting it
    // unconditionally would regress the #221/#57 empty-loop guard.
    if (!hasBranchWork) {
      const priorMergedCompletion = await resolvePriorMergedCompletion({
        cwd: options.cwd,
        taskId: input.taskId,
        hubProjectDir: input.hubProjectDir,
        env: options.env,
      });
      if (priorMergedCompletion) {
        return {
          outcome: "success",
          commits,
          completionSignal,
          branchHasUnmergedWork,
          alreadyMerged: true,
          message:
            "Implementer completed without new commits; the task's implementation was already merged into the base branch.",
        };
      }
    }

    return {
      outcome: "agent_failed",
      commits,
      completionSignal,
      message: "Implementer completed without commits",
    };
  };
};

export const createHubFlowRunReviewer = (options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly roleEntry?: HubAgentRoleEntry;
  readonly showAgentStartup?: boolean;
  readonly idleTimeoutSeconds?: number;
  readonly sandbox?: SandboxProvider;
  readonly createTaskSnapshot?: typeof createHubTaskSnapshot;
  readonly cleanupTaskSnapshot?: typeof cleanupHubTaskSnapshot;
}): HubFlowReviewer => {
  const agent = resolveHubFlowRunnerAgent("review", options);

  return async (input) => {
    try {
      const result = await runHubAgent({
        agent,
        cwd: options.cwd,
        promptFile: input.promptFile,
        flowId: input.flowId,
        batchId: input.batchId,
        taskId: input.taskId,
        title: input.title,
        branch: input.branch,
        runDir: input.runDir,
        name: `review-${input.taskId}`,
        role: "review",
        logFileName: `${input.taskId}-review.log`,
        env: options.env,
        showAgentStartup: options.showAgentStartup,
        idleTimeoutSeconds: options.idleTimeoutSeconds,
        signal: input.signal,
        sandbox: options.sandbox,
        createTaskSnapshot: options.createTaskSnapshot,
        cleanupTaskSnapshot: options.cleanupTaskSnapshot,
      });

      if (!result.completionSignal) {
        return {
          outcome: "agent_failed",
          commits: result.commits,
          message: "Reviewer finished without completion signal",
        };
      }

      return {
        outcome: "success",
        commits: result.commits,
        completionSignal: result.completionSignal,
      };
    } catch (error) {
      input.signal?.throwIfAborted();
      return buildHubFlowRunnerFailure(error);
    }
  };
};
