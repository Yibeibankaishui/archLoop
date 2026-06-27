import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  type HubRunCompletedBatchResult,
  type HubRunStopReason,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  createHubFlowRunMerger,
  createHubFlowRunVerifier,
  formatHubBatchMergeResultLines,
  runHubBatchMerge,
  type HubFlowMerger,
  type HubFlowVerifier,
  type RunHubBatchMergeResult,
} from "./hubBatchMerge.js";
import { getHubFlowDefinition, resolveHubFlowPromptPath } from "./hubFlows.js";
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
  type HubTaskLifecycleContext,
} from "./hubTaskLifecycle.js";
import {
  formatHubRetryPromptContext,
  prepareHubTaskRetry,
} from "./hubTaskRetry.js";
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
  readonly projectDevelopmentContract: HubProjectDevelopmentContractState;
  readonly retryContext?: string;
  readonly preservedWorktreePath?: string;
}

export interface HubImplementTaskResult {
  readonly outcome: "success" | "agent_failed" | "sandbox_failed";
  readonly commits: readonly { readonly sha: string }[];
  readonly completionSignal?: string;
  readonly branchHasUnmergedWork?: boolean;
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
  readonly commitCount: number;
  readonly implementationWork?: "new_commits" | "existing_unmerged_work";
}

export type HubFlowStopReason = HubRunStopReason;

export type HubFlowBatchResult = HubRunCompletedBatchResult;

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
  readonly projectDevelopmentContractPath: string;
  readonly projectDevelopmentContractCreatedGenericFallback: boolean;
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

const resolveHubFlowBatchStatus = (input: {
  readonly taskResults: readonly HubFlowTaskResult[];
  readonly mergeResult?: RunHubBatchMergeResult;
}): HubFlowBatchResult["batchStatus"] => {
  if (input.taskResults.some((result) => !isSuccessfulHubTaskResult(result))) {
    return "failed";
  }
  if (input.mergeResult?.batchStatus === "partial_failed") {
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
    batchStatus: resolveHubFlowBatchStatus(input),
  };
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
  >,
  projectDevelopmentContract?: HubProjectDevelopmentContractState,
): Readonly<Record<string, string>> => ({
  TASK_ID: input.taskId,
  TASK_TITLE: input.title,
  BRANCH: input.branch,
  VIEW_TASK_COMMAND: `bd show ${input.taskId}`,
  RETRY_CONTEXT: input.retryContext ?? "",
  ...(projectDevelopmentContract
    ? buildHubProjectDevelopmentContractPromptArgs({
        contract: projectDevelopmentContract,
      })
    : {}),
});

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
  readonly logFileName: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly retryContext?: string;
  readonly projectDevelopmentContract?: HubProjectDevelopmentContractState;
}) => {
  await assertAgentCredentialsConfigured({
    providerName: input.agent.name,
    cwd: input.cwd,
    env: input.env,
  });

  const { run } = await import("./run.js");
  const { noSandbox } = await import("./sandboxes/no-sandbox.js");

  return run({
    agent: input.agent,
    sandbox: noSandbox(),
    cwd: input.cwd,
    promptFile: input.promptFile,
    promptArgs: buildHubAgentPromptArgs(
      input,
      input.projectDevelopmentContract,
    ),
    branchStrategy: { type: "branch", branch: input.branch },
    name: input.name,
    worktreeLeaseOwner: {
      kind: "hub",
      taskId: input.taskId,
      flowId: input.flowId,
      batchId: input.batchId,
    },
    logging: {
      type: "file",
      path: join(input.runDir, "logs", input.logFileName),
    },
  });
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
    });
  } catch (error) {
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
      ? { failureReason: lifecycleResult.failureReason }
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
      projectDevelopmentContract: input.projectDevelopmentContract!,
      retryContext,
      preservedWorktreePath: retryPreparation.preservedWorktreePath,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Hub implementer failed";
    implementationResult = {
      outcome: "sandbox_failed",
      commits: [],
      message,
    };
  }

  const finishedAt = new Date().toISOString();

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
    commitCount: implementationResult.commits.length,
  };
};

export const runHubFlow = async (
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
    input.merger ?? createHubFlowRunMerger({ cwd: repoRoot, env: input.env });
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
      ...batchPlannedMetadata,
    });

    const batchMergeResult = await runBatchMergePhase(batchId);

    if (selectedTasks.length === 0) {
      return {
        selectedTaskIds: [],
        results: [],
        ...(batchMergeResult ? { mergeResult: batchMergeResult } : {}),
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

    const batchResult = resolveHubFlowBatchResult({
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
      ...(batchResult ? { batchResult } : {}),
    };
  };

  if (isResumingMergeBatch && resumedBatchId) {
    const resumedMergeResult = await runBatchMergePhase(resumedBatchId);

    mergeResult = resumedMergeResult;
    const resumedBatchResult = resolveHubFlowBatchResult({
      batchId: resumedBatchId,
      selectedTaskIds: [],
      taskResults: [],
      mergeResult: resumedMergeResult,
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
    if (batchExecution.selectedTaskIds.length === 0) {
      if (batchExecution.mergeResult) {
        mergeResult = batchExecution.mergeResult;
      }
      stopReason = "no_ready_tasks";
      break;
    }

    selectedTaskIds.push(...batchExecution.selectedTaskIds);
    results.push(...batchExecution.results);
    if (batchExecution.mergeResult) {
      mergeResult = batchExecution.mergeResult;
    }
    if (batchExecution.batchResult) {
      batchResults.push(batchExecution.batchResult);
      if (batchExecution.batchResult.batchStatus === "failed") {
        stopReason = "batch_failed";
        break;
      }
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
    projectDevelopmentContractPath: projectDevelopmentContract.contractPath,
    projectDevelopmentContractCreatedGenericFallback:
      projectDevelopmentContract.createdGenericFallback,
  };
};

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

export const createHubFlowRunImplementer = (options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly roleEntry?: HubAgentRoleEntry;
}): HubFlowImplementer => {
  const agent = resolveHubAgentProvider(
    resolveHubFlowRoleEntry({
      role: "implementation",
      roleEntry: options.roleEntry,
      env: options.env,
      homeDir: options.homeDir,
    }),
  );

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
        name: `implement-${input.taskId}`,
        logFileName: `${input.taskId}.log`,
        retryContext: input.retryContext,
      });

      if (!result.completionSignal) {
        return {
          outcome: "agent_failed",
          commits: result.commits,
          message: "Implementer finished without completion signal",
        };
      }

      const branchHasUnmergedWork = await hasBranchUnmergedWork(
        options.cwd,
        input.branch,
      );

      if (result.commits.length === 0 && !branchHasUnmergedWork) {
        return {
          outcome: "agent_failed",
          commits: result.commits,
          completionSignal: result.completionSignal,
          message: "Implementer completed without commits",
        };
      }

      return {
        outcome: "success",
        commits: result.commits,
        completionSignal: result.completionSignal,
        branchHasUnmergedWork,
      };
    } catch (error) {
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
    }
  };
};

export const createHubFlowRunReviewer = (options: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly roleEntry?: HubAgentRoleEntry;
}): HubFlowReviewer => {
  const agent = resolveHubAgentProvider(
    resolveHubFlowRoleEntry({
      role: "review",
      roleEntry: options.roleEntry,
      env: options.env,
      homeDir: options.homeDir,
    }),
  );

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
        logFileName: `${input.taskId}-review.log`,
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
    }
  };
};
