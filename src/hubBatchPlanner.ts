import { HubFlowError } from "./errors.js";
import type { HubFlowKind } from "./hubFlows.js";
import type { HubBatchPlannerInvoker } from "./hubBatchPlannerAgent.js";
import { enrichHubBatchPlannerCandidates } from "./hubBatchPlannerCandidates.js";
import { isHubFlowEligibleTask, type HubTaskProjection } from "./taskBoard.js";

export const HUB_BATCH_DEFAULT_MAX_TASKS = 3;
export const HUB_BATCH_MIN_MAX_TASKS = 1;
export const HUB_BATCH_MAX_TASKS_UPPER_LIMIT = 10;

export const HUB_BATCH_STRATEGIES = ["planned", "conservative"] as const;
export type HubBatchStrategy = (typeof HUB_BATCH_STRATEGIES)[number];

export const HUB_BATCH_DEFERRED_REASONS = [
  "explicit_blocker",
  "selected_api_shape_dependency",
  "same_core_module",
  "docs_or_qa_for_selected_behavior",
  "design_decision_dependency",
  "over_max_tasks",
  "lower_priority",
] as const;
export type HubBatchDeferredReason = (typeof HUB_BATCH_DEFERRED_REASONS)[number];

export const HUB_BATCH_FALLBACK_REASONS = [
  "planner_failed",
  "malformed_output",
  "invalid_task_ids",
  "duplicate_task_ids",
  "over_max_tasks",
  "empty_selection",
] as const;
export type HubBatchFallbackReason = (typeof HUB_BATCH_FALLBACK_REASONS)[number];

export interface HubBatchDeferredTask {
  readonly taskId: string;
  readonly reason: HubBatchDeferredReason;
}

export interface HubBatchPlannerInput {
  readonly flowId?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly candidates: readonly HubTaskProjection[];
  readonly batchStrategy: HubBatchStrategy;
  readonly maxTasks: number;
  readonly batchPlanner?: HubBatchPlannerInvoker;
  readonly runDir?: string;
}

export interface HubBatchPlannerResult {
  readonly selectedTasks: readonly HubTaskProjection[];
  readonly deferredTasks: readonly HubBatchDeferredTask[];
  readonly batchStrategyRequested: HubBatchStrategy;
  readonly batchStrategyUsed: HubBatchStrategy;
  readonly maxTasks: number;
  readonly fallbackReason?: HubBatchFallbackReason;
  readonly rationale?: string;
}

export interface ResolvedHubBatchSelectionOptions {
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
}

export interface HubBatchPlannerAgentOutput {
  readonly selectedTaskIds: readonly string[];
  readonly deferred: readonly HubBatchDeferredTask[];
  readonly rationale?: string;
}

const HUB_BATCH_DEFERRED_REASON_SET = new Set<string>(HUB_BATCH_DEFERRED_REASONS);

const hasOptionalCliText = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

const invalidMaxTasksError = (raw: string): HubFlowError =>
  new HubFlowError({
    message: `Invalid --max-tasks value "${raw}". Expected an integer between ${HUB_BATCH_MIN_MAX_TASKS} and ${HUB_BATCH_MAX_TASKS_UPPER_LIMIT}.`,
  });

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return [entry.trim()];
    }
    return [];
  });
};

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readDeferredTaskId = (record: Record<string, unknown>): string => {
  if (typeof record.taskId === "string") {
    return record.taskId.trim();
  }
  if (typeof record.task_id === "string") {
    return record.task_id.trim();
  }
  return "";
};

export const parseHubBatchStrategy = (raw: string): HubBatchStrategy => {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new HubFlowError({
      message: "Invalid --batch-strategy value. Use planned or conservative.",
    });
  }
  if (normalized === "planned" || normalized === "conservative") {
    return normalized;
  }
  throw new HubFlowError({
    message: `Unknown batch strategy "${raw}". Supported strategies: ${HUB_BATCH_STRATEGIES.join(", ")}.`,
  });
};

export const parseHubBatchMaxTasks = (raw: string): number => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw invalidMaxTasksError(raw);
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (
    parsed < HUB_BATCH_MIN_MAX_TASKS ||
    parsed > HUB_BATCH_MAX_TASKS_UPPER_LIMIT
  ) {
    throw invalidMaxTasksError(raw);
  }

  return parsed;
};

export const resolveHubBatchSelectionOptions = (input: {
  readonly flowKind: HubFlowKind;
  readonly batchStrategy?: string;
  readonly maxTasks?: string;
}): ResolvedHubBatchSelectionOptions => {
  const hasBatchStrategy = hasOptionalCliText(input.batchStrategy);
  const hasMaxTasks = hasOptionalCliText(input.maxTasks);

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
    ? parseHubBatchStrategy(input.batchStrategy)
    : undefined;

  let maxTasks: number | undefined;
  if (hasMaxTasks) {
    maxTasks = parseHubBatchMaxTasks(input.maxTasks);
  } else if (batchStrategy !== undefined) {
    maxTasks = HUB_BATCH_DEFAULT_MAX_TASKS;
  }

  return { batchStrategy, maxTasks };
};

export const normalizeHubBatchDeferredReason = (
  raw: unknown,
): HubBatchDeferredReason | undefined => {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  return HUB_BATCH_DEFERRED_REASON_SET.has(normalized)
    ? (normalized as HubBatchDeferredReason)
    : undefined;
};

export const parseHubBatchPlannerOutput = (
  stdout: string,
): HubBatchPlannerAgentOutput | undefined => {
  const match = stdout.match(/<batch-plan>([\s\S]*?)<\/batch-plan>/i);
  if (!match?.[1]) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }

  const record = readObject(parsed);
  const selectedTaskIds = readStringArray(
    record.selectedTaskIds ?? record.selected_task_ids ?? record.selected,
  );
  const deferredRaw = Array.isArray(record.deferred) ? record.deferred : [];
  const deferred = deferredRaw.flatMap((entry) => {
    const deferredRecord = readObject(entry);
    const taskId = readDeferredTaskId(deferredRecord);
    const reason = normalizeHubBatchDeferredReason(
      deferredRecord.reason ?? deferredRecord.deferredReason,
    );
    if (!taskId || !reason) {
      return [];
    }
    return [{ taskId, reason }];
  });
  const rationale =
    typeof record.rationale === "string" && record.rationale.trim().length > 0
      ? record.rationale.trim()
      : undefined;

  return { selectedTaskIds, deferred, rationale };
};

export const validateHubBatchPlannerOutput = (input: {
  readonly output: HubBatchPlannerAgentOutput;
  readonly eligibleTaskIds: ReadonlySet<string>;
  readonly maxTasks: number;
}): HubBatchFallbackReason | undefined => {
  const uniqueSelected = new Set<string>();
  for (const taskId of input.output.selectedTaskIds) {
    if (!input.eligibleTaskIds.has(taskId)) {
      return "invalid_task_ids";
    }
    if (uniqueSelected.has(taskId)) {
      return "duplicate_task_ids";
    }
    uniqueSelected.add(taskId);
  }

  if (input.output.selectedTaskIds.length === 0) {
    return "empty_selection";
  }

  if (input.output.selectedTaskIds.length > input.maxTasks) {
    return "over_max_tasks";
  }

  return undefined;
};

const buildConservativeBatchResult = (input: {
  readonly candidates: readonly HubTaskProjection[];
  readonly batchStrategyRequested: HubBatchStrategy;
  readonly maxTasks: number;
  readonly fallbackReason?: HubBatchFallbackReason;
  readonly rationale?: string;
  readonly deferredTasks?: readonly HubBatchDeferredTask[];
}): HubBatchPlannerResult => {
  const eligible = input.candidates.filter(isHubFlowEligibleTask);
  const selectedTasks = eligible.slice(0, 1);
  const selectedIds = new Set(selectedTasks.map((task) => task.id));
  const deferredFromPlanner = input.deferredTasks ?? [];
  const deferredTasks = [
    ...deferredFromPlanner.filter((entry) => !selectedIds.has(entry.taskId)),
    ...eligible
      .filter((task) => !selectedIds.has(task.id))
      .map((task) => ({
        taskId: task.id,
        reason: "over_max_tasks" as const,
      })),
  ];

  return {
    selectedTasks,
    deferredTasks,
    batchStrategyRequested: input.batchStrategyRequested,
    batchStrategyUsed: "conservative",
    maxTasks: input.maxTasks,
    fallbackReason: input.fallbackReason,
    rationale: input.rationale,
  };
};

const mapSelectedTasks = (
  candidates: readonly HubTaskProjection[],
  selectedTaskIds: readonly string[],
): HubTaskProjection[] => {
  const byId = new Map(candidates.map((task) => [task.id, task]));
  return selectedTaskIds.flatMap((taskId) => {
    const task = byId.get(taskId);
    return task ? [task] : [];
  });
};

const planConservativeHubFlowBatch = (
  input: HubBatchPlannerInput,
): HubBatchPlannerResult =>
  buildConservativeBatchResult({
    candidates: input.candidates,
    batchStrategyRequested: input.batchStrategy,
    maxTasks: input.maxTasks,
  });

const fallbackPlannedHubFlowBatch = (
  input: HubBatchPlannerInput,
  fallbackReason: HubBatchFallbackReason,
  extras: {
    readonly rationale?: string;
    readonly deferredTasks?: readonly HubBatchDeferredTask[];
  } = {},
): HubBatchPlannerResult =>
  buildConservativeBatchResult({
    candidates: input.candidates,
    batchStrategyRequested: "planned",
    maxTasks: input.maxTasks,
    fallbackReason,
    ...extras,
  });

const planPlannedHubFlowBatch = async (
  input: HubBatchPlannerInput,
): Promise<HubBatchPlannerResult> => {
  const eligible = input.candidates.filter(isHubFlowEligibleTask);
  const eligibleTaskIds = new Set(eligible.map((task) => task.id));

  if (!input.batchPlanner || !input.flowId || !input.cwd || !input.runDir) {
    return fallbackPlannedHubFlowBatch(input, "planner_failed");
  }

  const enrichedCandidates = enrichHubBatchPlannerCandidates({
    cwd: input.cwd,
    candidates: eligible,
    env: input.env,
  });

  let stdout: string;
  try {
    stdout = await input.batchPlanner({
      flowId: input.flowId,
      cwd: input.cwd,
      runDir: input.runDir,
      maxTasks: input.maxTasks,
      candidates: enrichedCandidates,
      env: input.env,
    });
  } catch {
    return fallbackPlannedHubFlowBatch(input, "planner_failed");
  }

  const parsed = parseHubBatchPlannerOutput(stdout);
  if (!parsed) {
    return fallbackPlannedHubFlowBatch(input, "malformed_output");
  }

  const validationIssue = validateHubBatchPlannerOutput({
    output: parsed,
    eligibleTaskIds,
    maxTasks: input.maxTasks,
  });
  if (validationIssue) {
    return fallbackPlannedHubFlowBatch(input, validationIssue, {
      rationale: parsed.rationale,
      deferredTasks: parsed.deferred,
    });
  }

  return {
    selectedTasks: mapSelectedTasks(eligible, parsed.selectedTaskIds),
    deferredTasks: parsed.deferred,
    batchStrategyRequested: "planned",
    batchStrategyUsed: "planned",
    maxTasks: input.maxTasks,
    rationale: parsed.rationale,
  };
};

export const planHubFlowBatch = async (
  input: HubBatchPlannerInput,
): Promise<HubBatchPlannerResult> => {
  switch (input.batchStrategy) {
    case "conservative":
      return planConservativeHubFlowBatch(input);
    case "planned":
      return planPlannedHubFlowBatch(input);
    default: {
      const exhaustive: never = input.batchStrategy;
      throw new HubFlowError({
        message: `Unsupported batch strategy "${String(exhaustive)}".`,
      });
    }
  }
};

export const selectHubFlowTasksWithBatchOptions = async (input: {
  readonly flowId?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runDir?: string;
  readonly candidates: readonly HubTaskProjection[];
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
  readonly batchPlanner?: HubBatchPlannerInvoker;
}): Promise<{
  readonly selectedTasks: readonly HubTaskProjection[];
  readonly batchSelection?: HubBatchPlannerResult;
}> => {
  if (!input.batchStrategy) {
    return {
      selectedTasks: input.candidates.filter(isHubFlowEligibleTask),
    };
  }

  const batchSelection = await planHubFlowBatch({
    flowId: input.flowId,
    cwd: input.cwd,
    env: input.env,
    runDir: input.runDir,
    candidates: input.candidates,
    batchStrategy: input.batchStrategy,
    maxTasks: input.maxTasks ?? HUB_BATCH_DEFAULT_MAX_TASKS,
    batchPlanner: input.batchPlanner,
  });

  return {
    selectedTasks: batchSelection.selectedTasks,
    batchSelection,
  };
};
