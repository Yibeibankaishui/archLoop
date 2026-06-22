import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { assertAgentCredentialsConfigured } from "./agentAuthGuidance.js";
import {
  appendHubBatchEvent,
  appendHubTaskEvent,
  createHubRunContext,
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
  selectHubFlowTasksWithBatchOptions,
  resolveFreshValidatedHubBatchSelection,
  type HubBatchPlannerResult,
  type HubBatchStrategy,
} from "./hubBatchPlanner.js";
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
  readonly implementer: HubFlowImplementer;
  readonly reviewer?: HubFlowReviewer;
  readonly merger?: HubFlowMerger;
  readonly verifier?: HubFlowVerifier;
  readonly runMergePhase?: boolean;
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
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

export interface RunHubFlowResult {
  readonly flowId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly runDir: string;
  readonly mode: "new_batch" | "resumed_batch" | "no_ready";
  readonly selectedTaskIds: readonly string[];
  readonly results: readonly HubFlowTaskResult[];
  readonly mergeResult?: RunHubBatchMergeResult;
  readonly resumedBatchId?: string;
  readonly unfinishedBatchIds: readonly string[];
  readonly batchSelection?: HubBatchPlannerResult;
  readonly fallbackReason?: string;
}

interface ResumableHubFlowBatch {
  readonly runId: string;
  readonly batchId: string;
  readonly createdAt: string | undefined;
}

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
): Readonly<Record<string, string>> => ({
  TASK_ID: input.taskId,
  TASK_TITLE: input.title,
  BRANCH: input.branch,
  VIEW_TASK_COMMAND: `bd show ${input.taskId}`,
  RETRY_CONTEXT: input.retryContext ?? "",
});

const runHubAgent = async (input: {
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
}) => {
  await assertAgentCredentialsConfigured({
    providerName: "cursor",
    cwd: input.cwd,
    env: input.env,
  });

  const { cursor } = await import("./AgentProvider.js");
  const { run } = await import("./run.js");
  const { noSandbox } = await import("./sandboxes/no-sandbox.js");

  return run({
    agent: cursor("auto"),
    sandbox: noSandbox(),
    cwd: input.cwd,
    promptFile: input.promptFile,
    promptArgs: buildHubAgentPromptArgs(input),
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

  const lifecycleResult = isSuccessfulReview(reviewResult)
    ? recordHubTaskReviewSuccess(lifecycleBase)
    : recordHubTaskReviewFailure({
        ...lifecycleBase,
        failureReason: resolveFailureReason(reviewResult.outcome),
      });

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
  reviewPromptFile?: string,
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

  const claimResult = claimHubTaskForImplementation({
    cwd,
    taskId: task.id,
    branch,
    hubProjectDir: context.hubProjectDir,
    runId: context.runId,
    batchId: context.batchId,
    startedAt: input.startedAt,
    env: input.env,
  });

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
  recordImplementationStarted({
    context: lifecycleContext,
    taskId: task.id,
    branch,
    hubStatus: claimResult.task.hubStatus,
    claim,
    createdAt: startedAt,
  });

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
    const { task: updatedTask } = recordImplementationSuccess({
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
    });

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
  const { task: updatedTask } = recordImplementationFailure({
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
  });

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
  const readyBoard = loadHubReadyQueue(repoRoot, input.env);
  const {
    selectedTasks: initiallySelectedTasks,
    batchSelection: initialBatchSelection,
  } = selectHubFlowTasksWithBatchOptions({
    candidates: readyBoard.tasks,
    batchStrategy: input.batchStrategy,
    maxTasks: input.maxTasks,
  });
  const freshBoard = loadHubReadyQueue(repoRoot, input.env);
  const {
    selectedTasks,
    batchSelection,
    fallbackReason,
  } = resolveFreshValidatedHubBatchSelection({
    initialSelectedTaskIds: initiallySelectedTasks.map((task) => task.id),
    freshCandidates: freshBoard.tasks,
    batchStrategy: input.batchStrategy,
    maxTasks: input.maxTasks,
    batchSelection: initialBatchSelection,
  });
  const selectedTaskIds = selectedTasks.map((task) => task.id);
  const unfinishedBatches = findResumableHubFlowBatches({
    hubProjectDir,
    flowId: input.flowId,
    tasks: loadHubTaskBoard(repoRoot, input.env).tasks,
  });
  const unfinishedBatchIds = unfinishedBatches.map((batch) => batch.batchId);
  const resumedBatchId =
    selectedTasks.length === 0 ? unfinishedBatches[0]?.batchId : undefined;
  const mode =
    selectedTasks.length > 0
      ? "new_batch"
      : resumedBatchId
        ? "resumed_batch"
        : "no_ready";
  const startedAt = input.startedAt ?? new Date();
  const context = createHubRunContext({
    cwd: repoRoot,
    hubProjectDir,
    branch: `flow/${input.flowId}`,
    batchId: resumedBatchId,
    startedAt,
    env: input.env,
  });

  mkdirSync(join(context.runDir, "logs"), { recursive: true });

  appendHubBatchEvent(context.runDir, {
    type: "batch_planned",
    runId: context.runId,
    batchId: context.batchId,
    flowId: input.flowId,
    createdAt: startedAt.toISOString(),
    taskIds: selectedTaskIds,
    ...(batchSelection
      ? {
          batchStrategyRequested: batchSelection.batchStrategyRequested,
          batchStrategyUsed: batchSelection.batchStrategyUsed,
          maxTasks: batchSelection.maxTasks,
          deferredTasks: batchSelection.deferredTasks,
          ...(batchSelection.fallbackReason
            ? { fallbackReason: batchSelection.fallbackReason }
            : {}),
        }
      : fallbackReason
        ? { fallbackReason }
        : {}),
  });

  const results: HubFlowTaskResult[] = [];
  for (const task of selectedTasks) {
    results.push(
      await implementSelectedTask(
        { ...input, cwd: repoRoot },
        context,
        task,
        implementPromptFile,
        flowDefinition.hasReviewer === true,
        reviewPromptFile,
      ),
    );
  }

  const runMergePhase = input.runMergePhase ?? true;
  let mergeResult: RunHubBatchMergeResult | undefined;
  if (runMergePhase) {
    mergeResult = await runHubBatchMerge({
      flowId: input.flowId,
      cwd: repoRoot,
      runDir: context.runDir,
      runId: context.runId,
      batchId: resumedBatchId ?? context.batchId,
      env: input.env,
      merger:
        input.merger ??
        createHubFlowRunMerger({ cwd: repoRoot, env: input.env }),
      verifier: input.verifier ?? createHubFlowRunVerifier({ cwd: repoRoot }),
    });
  }

  return {
    flowId: input.flowId,
    runId: context.runId,
    batchId: context.batchId,
    runDir: context.runDir,
    mode,
    selectedTaskIds,
    results,
    mergeResult,
    resumedBatchId,
    unfinishedBatchIds,
    batchSelection,
    ...(fallbackReason ? { fallbackReason } : {}),
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
    `Selected tasks: ${selectedTaskCount}`,
  ];
  if (result.batchSelection) {
    lines.push(
      `Batch strategy: ${result.batchSelection.batchStrategyUsed} (max ${result.batchSelection.maxTasks})`,
    );
    if (result.batchSelection.fallbackReason) {
      lines.push(
        `Batch fallback: ${result.batchSelection.fallbackReason}`,
      );
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
  if (result.resumedBatchId) {
    lines.push(`Resumed batch id: ${result.resumedBatchId}`);
  } else if (result.unfinishedBatchIds.length > 0) {
    lines.push(
      `Unfinished batches not resumed: ${result.unfinishedBatchIds.join(", ")}`,
    );
  }

  if (selectedTaskCount === 0) {
    lines.push("No ready tasks selected.");
    if (!result.resumedBatchId) {
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
}): HubFlowImplementer => {
  return async (input) => {
    try {
      const result = await runHubAgent({
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
}): HubFlowReviewer => {
  return async (input) => {
    try {
      const result = await runHubAgent({
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
