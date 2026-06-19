import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
  resolveSandcastleUserDataDir,
} from "./projectStatus.js";
import {
  recordHubTaskReviewFailure,
  recordHubTaskReviewSuccess,
} from "./hubTaskLifecycle.js";
import {
  claimHubTask,
  resolveHubTaskBranch,
  selectHubFlowTasks,
  loadHubReadyQueue,
  updateHubTaskStatus,
  type HubFailureReason,
  type HubTaskProjection,
} from "./taskBoard.js";

export interface HubImplementTaskInput {
  readonly flowId: string;
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly promptFile: string;
  readonly cwd: string;
  readonly runDir: string;
}

export interface HubImplementTaskResult {
  readonly outcome: "success" | "agent_failed" | "sandbox_failed";
  readonly commits: readonly { readonly sha: string }[];
  readonly completionSignal?: string;
  readonly message?: string;
}

export type HubFlowImplementer = (
  input: HubImplementTaskInput,
) => Promise<HubImplementTaskResult>;

export interface HubReviewTaskInput {
  readonly flowId: string;
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
}

export interface HubFlowTaskResult {
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly outcome:
    | "implemented"
    | "reviewed"
    | "claim_skipped"
    | "agent_failed"
    | "sandbox_failed";
  readonly hubStatus: string;
  readonly failureReason?: HubFailureReason;
  readonly commitCount: number;
}

export interface RunHubFlowResult {
  readonly flowId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly runDir: string;
  readonly selectedTaskIds: readonly string[];
  readonly results: readonly HubFlowTaskResult[];
  readonly mergeResult?: RunHubBatchMergeResult;
}

const resolveFailureReason = (
  outcome: HubImplementTaskResult["outcome"],
): HubFailureReason =>
  outcome === "sandbox_failed" ? "sandbox_failed" : "agent_failed";

const isSuccessfulImplementation = (result: HubImplementTaskResult): boolean =>
  result.outcome === "success" &&
  result.commits.length > 0 &&
  result.completionSignal !== undefined;

const isSuccessfulReview = (result: HubReviewTaskResult): boolean =>
  result.outcome === "success" && result.completionSignal !== undefined;

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

const recordTaskStatusAdvanced = (
  runDir: string,
  input: {
    readonly runId: string;
    readonly batchId: string;
    readonly taskId: string;
    readonly branch: string;
    readonly createdAt: string;
    readonly status: string;
    readonly reason?: string;
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
    reason: input.reason,
    failureReason: input.failureReason,
    commitCount: input.commitCount,
  });
};

const buildHubAgentPromptArgs = (
  input: Pick<HubImplementTaskInput, "taskId" | "title" | "branch">,
): Readonly<Record<string, string>> => ({
  TASK_ID: input.taskId,
  TASK_TITLE: input.title,
  BRANCH: input.branch,
  VIEW_TASK_COMMAND: `bd show ${input.taskId}`,
});

const runHubAgent = async (input: {
  readonly cwd: string;
  readonly promptFile: string;
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly runDir: string;
  readonly name: string;
  readonly logFileName: string;
  readonly env?: NodeJS.ProcessEnv;
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
  const claimResult = claimHubTask({
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

  const startedAt = (input.startedAt ?? new Date()).toISOString();
  appendHubTaskEvent(context.runDir, {
    type: "task_implementation_started",
    runId: context.runId,
    batchId: context.batchId,
    taskId: task.id,
    branch,
    createdAt: startedAt,
    status: claimResult.task.hubStatus,
    claim: claimResult.claim,
  });

  let implementationResult: HubImplementTaskResult;
  try {
    implementationResult = await input.implementer({
      flowId: input.flowId,
      taskId: task.id,
      title: task.title,
      branch,
      promptFile,
      cwd,
      runDir: context.runDir,
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
    const postImplementationStatus = hasReviewer
      ? "reviewing"
      : "waiting_for_merge";

    appendHubTaskEvent(context.runDir, {
      type: "task_implementation_succeeded",
      runId: context.runId,
      batchId: context.batchId,
      taskId: task.id,
      branch,
      createdAt: finishedAt,
      status: postImplementationStatus,
      commitCount: implementationResult.commits.length,
      claim: claimResult.claim,
    });

    const updatedTask = updateHubTaskStatus({
      cwd,
      taskId: task.id,
      hubStatus: postImplementationStatus,
      metadata: claimResult.task.metadata,
      env: input.env,
    });
    recordTaskStatusAdvanced(context.runDir, {
      runId: context.runId,
      batchId: context.batchId,
      taskId: task.id,
      branch,
      createdAt: finishedAt,
      status: updatedTask.hubStatus,
      commitCount: implementationResult.commits.length,
    });

    if (hasReviewer) {
      return reviewSelectedTask(
        input,
        context,
        task,
        branch,
        claimResult.claim!,
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
    };
  }

  const failureReason = resolveFailureReason(implementationResult.outcome);
  appendHubTaskEvent(context.runDir, {
    type: "task_implementation_failed",
    runId: context.runId,
    batchId: context.batchId,
    taskId: task.id,
    branch,
    createdAt: finishedAt,
    status: "failed",
    failureReason,
    commitCount: implementationResult.commits.length,
    claim: claimResult.claim,
  });

  const updatedTask = updateHubTaskStatus({
    cwd,
    taskId: task.id,
    hubStatus: "failed",
    metadata: claimResult.task.metadata,
    failureReason,
    env: input.env,
  });
  recordTaskStatusAdvanced(context.runDir, {
    runId: context.runId,
    batchId: context.batchId,
    taskId: task.id,
    branch,
    createdAt: finishedAt,
    status: updatedTask.hubStatus,
    failureReason,
    commitCount: implementationResult.commits.length,
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
      `Hub flow "${input.flowId}" is a proposal flow and must be executed through sandcastle run --flow or its task shortcut.`,
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

  const readyBoard = loadHubReadyQueue(repoRoot, input.env);
  const selectedTasks = selectHubFlowTasks(readyBoard);
  const selectedTaskIds = selectedTasks.map((task) => task.id);
  const startedAt = input.startedAt ?? new Date();
  const context = createHubRunContext({
    cwd: repoRoot,
    hubProjectDir:
      input.hubProjectDir ??
      resolveHubProjectDir(resolveSandcastleUserDataDir(input.env), repoRoot),
    branch: `flow/${input.flowId}`,
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
      batchId: context.batchId,
      env: input.env,
      merger: input.merger ?? createHubFlowRunMerger({ cwd: repoRoot }),
      verifier: input.verifier ?? createHubFlowRunVerifier({ cwd: repoRoot }),
    });
  }

  return {
    flowId: input.flowId,
    runId: context.runId,
    batchId: context.batchId,
    runDir: context.runDir,
    selectedTaskIds,
    results,
    mergeResult,
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
    `Selected tasks: ${selectedTaskCount}`,
  ];

  if (selectedTaskCount === 0) {
    lines.push("No ready tasks selected.");
    return lines;
  }

  for (const taskResult of result.results) {
    lines.push(
      `  ${taskResult.taskId}: ${taskResult.outcome} -> ${taskResult.hubStatus}`,
    );
  }

  if (result.mergeResult) {
    lines.push("Merge phase:");
    for (const line of formatHubBatchMergeResultLines(result.mergeResult)) {
      lines.push(`  ${line}`);
    }
  }

  return lines;
};

export const createHubFlowRunImplementer = (options: {
  readonly cwd: string;
}): HubFlowImplementer => {
  return async (input) => {
    try {
      const result = await runHubAgent({
        cwd: options.cwd,
        promptFile: input.promptFile,
        taskId: input.taskId,
        title: input.title,
        branch: input.branch,
        runDir: input.runDir,
        name: `implement-${input.taskId}`,
        logFileName: `${input.taskId}.log`,
      });

      if (!result.completionSignal) {
        return {
          outcome: "agent_failed",
          commits: result.commits,
          message: "Implementer finished without completion signal",
        };
      }

      if (result.commits.length === 0) {
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
