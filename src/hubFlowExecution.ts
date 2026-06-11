import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { HubFlowError } from "./errors.js";
import {
  appendHubBatchEvent,
  appendHubTaskEvent,
  createHubRunContext,
} from "./hubExecution.js";
import { resolveHubFlowPromptPath } from "./hubFlows.js";
import {
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveSandcastleUserDataDir,
} from "./projectStatus.js";
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

export interface RunHubFlowInput {
  readonly flowId: string;
  readonly cwd?: string;
  readonly hubProjectDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly startedAt?: Date;
  readonly implementer: HubFlowImplementer;
}

export interface HubFlowTaskResult {
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly outcome:
    | "implemented"
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
}

const resolveFailureReason = (
  outcome: HubImplementTaskResult["outcome"],
): HubFailureReason =>
  outcome === "sandbox_failed" ? "sandbox_failed" : "agent_failed";

const isSuccessfulImplementation = (result: HubImplementTaskResult): boolean =>
  result.outcome === "success" &&
  result.commits.length > 0 &&
  result.completionSignal !== undefined;

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

const implementSelectedTask = async (
  input: RunHubFlowInput,
  context: ReturnType<typeof createHubRunContext>,
  task: HubTaskProjection,
  promptFile: string,
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
    appendHubTaskEvent(context.runDir, {
      type: "task_implementation_succeeded",
      runId: context.runId,
      batchId: context.batchId,
      taskId: task.id,
      branch,
      createdAt: finishedAt,
      status: "waiting_for_merge",
      commitCount: implementationResult.commits.length,
      claim: claimResult.claim,
    });

    const updatedTask = updateHubTaskStatus({
      cwd,
      taskId: task.id,
      hubStatus: "waiting_for_merge",
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
  const promptFile = resolveHubFlowPromptPath(input.flowId, "implement");
  if (!promptFile.includes("hub-flows")) {
    throw new HubFlowError({
      message: `Hub flow "${input.flowId}" must use Hub-owned prompts, not repo-local .sandcastle/ prompts.`,
    });
  }

  const readyBoard = loadHubReadyQueue(repoRoot, input.env);
  const selectedTasks = selectHubFlowTasks(readyBoard);
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
    taskIds: selectedTasks.map((task) => task.id),
  });

  const results: HubFlowTaskResult[] = [];
  for (const task of selectedTasks) {
    results.push(
      await implementSelectedTask(
        { ...input, cwd: repoRoot },
        context,
        task,
        promptFile,
      ),
    );
  }

  return {
    flowId: input.flowId,
    runId: context.runId,
    batchId: context.batchId,
    runDir: context.runDir,
    selectedTaskIds: selectedTasks.map((task) => task.id),
    results,
  };
};

export const formatHubFlowResultLines = (
  result: RunHubFlowResult,
): readonly string[] => {
  const lines = [
    `Hub flow ${result.flowId}`,
    `Run id: ${result.runId}`,
    `Batch id: ${result.batchId}`,
    `Selected tasks: ${result.selectedTaskIds.length}`,
  ];

  if (result.selectedTaskIds.length === 0) {
    lines.push("No ready tasks selected.");
    return lines;
  }

  for (const taskResult of result.results) {
    lines.push(
      `  ${taskResult.taskId}: ${taskResult.outcome} -> ${taskResult.hubStatus}`,
    );
  }

  return lines;
};

export const createHubFlowRunImplementer = (options: {
  readonly cwd: string;
}): HubFlowImplementer => {
  return async (input) => {
    const { cursor } = await import("./AgentProvider.js");
    const { run } = await import("./run.js");
    const { noSandbox } = await import("./sandboxes/no-sandbox.js");

    try {
      const result = await run({
        agent: cursor("auto"),
        sandbox: noSandbox(),
        cwd: options.cwd,
        promptFile: input.promptFile,
        promptArgs: {
          TASK_ID: input.taskId,
          TASK_TITLE: input.title,
          BRANCH: input.branch,
          VIEW_TASK_COMMAND: `bd show ${input.taskId}`,
        },
        branchStrategy: { type: "branch", branch: input.branch },
        name: `implement-${input.taskId}`,
        logging: {
          type: "file",
          path: join(input.runDir, "logs", `${input.taskId}.log`),
        },
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
      const tag =
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        typeof (error as { _tag?: unknown })._tag === "string"
          ? (error as { _tag: string })._tag
          : undefined;

      if (
        tag === "DockerError" ||
        tag === "PodmanError" ||
        tag === "ContainerStartTimeoutError" ||
        tag === "WorktreeError" ||
        tag === "CopyError" ||
        tag === "SyncError"
      ) {
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
