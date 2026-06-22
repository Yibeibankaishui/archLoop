import { HubFlowError } from "./errors.js";
import type { HubFlowKind } from "./hubFlows.js";
import type { HubTaskProjection } from "./taskBoard.js";

export const HUB_BATCH_DEFAULT_MAX_TASKS = 3;
export const HUB_BATCH_MIN_MAX_TASKS = 1;
export const HUB_BATCH_MAX_TASKS_UPPER_LIMIT = 10;

export const HUB_BATCH_STRATEGIES = ["conservative"] as const;
export type HubBatchStrategy = (typeof HUB_BATCH_STRATEGIES)[number];

export const HUB_BATCH_DEFERRED_REASONS = ["over_max_tasks"] as const;
export type HubBatchDeferredReason = (typeof HUB_BATCH_DEFERRED_REASONS)[number];

export interface HubBatchDeferredTask {
  readonly taskId: string;
  readonly reason: HubBatchDeferredReason;
}

export interface HubBatchPlannerInput {
  readonly candidates: readonly HubTaskProjection[];
  readonly batchStrategy: HubBatchStrategy;
  readonly maxTasks: number;
}

export interface HubBatchPlannerResult {
  readonly selectedTasks: readonly HubTaskProjection[];
  readonly deferredTasks: readonly HubBatchDeferredTask[];
  readonly batchStrategyRequested: HubBatchStrategy;
  readonly batchStrategyUsed: HubBatchStrategy;
  readonly maxTasks: number;
}

export interface ResolvedHubBatchSelectionOptions {
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
}

const isEligibleHubFlowCandidate = (task: HubTaskProjection): boolean =>
  task.hubStatus === "ready_for_agent" && task.claimState !== "active";

export const parseHubBatchStrategy = (raw: string): HubBatchStrategy => {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new HubFlowError({
      message: "Invalid --batch-strategy value. Use conservative.",
    });
  }
  if (normalized === "conservative") {
    return "conservative";
  }
  throw new HubFlowError({
    message: `Unknown batch strategy "${raw}". Supported strategies: ${HUB_BATCH_STRATEGIES.join(", ")}.`,
  });
};

export const parseHubBatchMaxTasks = (raw: string): number => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new HubFlowError({
      message: `Invalid --max-tasks value "${raw}". Expected an integer between ${HUB_BATCH_MIN_MAX_TASKS} and ${HUB_BATCH_MAX_TASKS_UPPER_LIMIT}.`,
    });
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < HUB_BATCH_MIN_MAX_TASKS ||
    parsed > HUB_BATCH_MAX_TASKS_UPPER_LIMIT
  ) {
    throw new HubFlowError({
      message: `Invalid --max-tasks value "${raw}". Expected an integer between ${HUB_BATCH_MIN_MAX_TASKS} and ${HUB_BATCH_MAX_TASKS_UPPER_LIMIT}.`,
    });
  }

  return parsed;
};

export const resolveHubBatchSelectionOptions = (input: {
  readonly flowKind: HubFlowKind;
  readonly batchStrategy?: string;
  readonly maxTasks?: string;
}): ResolvedHubBatchSelectionOptions => {
  const hasBatchStrategy =
    input.batchStrategy !== undefined && input.batchStrategy.trim().length > 0;
  const hasMaxTasks =
    input.maxTasks !== undefined && input.maxTasks.trim().length > 0;

  if (input.flowKind === "proposal") {
    if (hasBatchStrategy || hasMaxTasks) {
      throw new HubFlowError({
        message:
          "Proposal flows do not support --batch-strategy or --max-tasks.",
      });
    }
    return {};
  }

  const batchStrategy = hasBatchStrategy
    ? parseHubBatchStrategy(input.batchStrategy!)
    : undefined;
  const maxTasks = hasMaxTasks
    ? parseHubBatchMaxTasks(input.maxTasks!)
    : batchStrategy !== undefined
      ? HUB_BATCH_DEFAULT_MAX_TASKS
      : undefined;

  return { batchStrategy, maxTasks };
};

export const planHubFlowBatch = (
  input: HubBatchPlannerInput,
): HubBatchPlannerResult => {
  const eligible = input.candidates.filter(isEligibleHubFlowCandidate);

  switch (input.batchStrategy) {
    case "conservative": {
      const effectiveLimit = Math.min(input.maxTasks, 1);
      const selectedTasks = eligible.slice(0, effectiveLimit);
      const deferredTasks = eligible.slice(effectiveLimit).map((task) => ({
        taskId: task.id,
        reason: "over_max_tasks" as const,
      }));

      return {
        selectedTasks,
        deferredTasks,
        batchStrategyRequested: input.batchStrategy,
        batchStrategyUsed: "conservative",
        maxTasks: input.maxTasks,
      };
    }
    default: {
      const exhaustive: never = input.batchStrategy;
      throw new HubFlowError({
        message: `Unsupported batch strategy "${String(exhaustive)}".`,
      });
    }
  }
};

export const selectHubFlowTasksWithBatchOptions = (input: {
  readonly candidates: readonly HubTaskProjection[];
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
}): {
  readonly selectedTasks: readonly HubTaskProjection[];
  readonly batchSelection?: HubBatchPlannerResult;
} => {
  if (!input.batchStrategy) {
    return {
      selectedTasks: input.candidates.filter(isEligibleHubFlowCandidate),
    };
  }

  const batchSelection = planHubFlowBatch({
    candidates: input.candidates,
    batchStrategy: input.batchStrategy,
    maxTasks: input.maxTasks ?? HUB_BATCH_DEFAULT_MAX_TASKS,
  });

  return {
    selectedTasks: batchSelection.selectedTasks,
    batchSelection,
  };
};
