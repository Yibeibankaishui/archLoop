import { HubFlowError } from "./errors.js";
import type { HubFlowKind } from "./hubFlows.js";
import type { HubBatchPlannerInvoker } from "./hubBatchPlannerAgent.js";
import {
  enrichHubBatchPlannerCandidates,
  type HubBatchPlannerCandidate,
} from "./hubBatchPlannerCandidates.js";
import { isHubFlowEligibleTask, type HubTaskProjection } from "./taskBoard.js";

export const HUB_BATCH_DEFAULT_MAX_TASKS = 3;
export const HUB_BATCH_DEFAULT_STRATEGY = "planned" as const;
export const HUB_BATCH_MIN_MAX_TASKS = 1;
export const HUB_BATCH_MAX_TASKS_UPPER_LIMIT = 10;

export const HUB_BATCH_STRATEGIES = [
  "planned",
  "limited",
  "conservative",
] as const;
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
export type HubBatchDeferredReason =
  (typeof HUB_BATCH_DEFERRED_REASONS)[number];

export const HUB_BATCH_FALLBACK_REASONS = [
  "planner_unavailable",
  "planner_failed",
  "malformed_output",
  "invalid_task_ids",
  "duplicate_task_ids",
  "over_max_tasks",
  "empty_selection",
] as const;
export type HubBatchFallbackReason =
  (typeof HUB_BATCH_FALLBACK_REASONS)[number];

export const HUB_BATCH_DIAGNOSTIC_REASONS = [
  "invalid_explicit_blocker_deferral",
] as const;
export type HubBatchDiagnosticReason =
  (typeof HUB_BATCH_DIAGNOSTIC_REASONS)[number];

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
  readonly fallbackReason?: string;
  readonly diagnosticReason?: HubBatchDiagnosticReason;
  readonly rationale?: string;
}

export const HUB_BATCH_SELECTION_INVALID_REASONS = [
  "duplicate_selection",
  "over_max_tasks",
  "not_in_candidate_set",
  "not_ready_for_agent",
  "active_claim",
] as const;
export type HubBatchSelectionInvalidReason =
  (typeof HUB_BATCH_SELECTION_INVALID_REASONS)[number];

export interface ResolvedHubBatchSelectionOptions {
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
}

export interface HubBatchPlannerAgentOutput {
  readonly selectedTaskIds: readonly string[];
  readonly deferred: readonly HubBatchDeferredTask[];
  readonly rationale?: string;
}

const HUB_BATCH_DEFERRED_REASON_SET = new Set<string>(
  HUB_BATCH_DEFERRED_REASONS,
);

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

const isHubBatchStrategy = (value: string): value is HubBatchStrategy =>
  (HUB_BATCH_STRATEGIES as readonly string[]).includes(value);

const parseHubBatchStrategyNormalized = (
  normalized: string,
  raw: string,
): HubBatchStrategy => {
  if (isHubBatchStrategy(normalized)) {
    return normalized;
  }

  throw new HubFlowError({
    message: `Unknown batch strategy "${raw}". Supported strategies: ${HUB_BATCH_STRATEGIES.join(", ")}.`,
  });
};

export const parseHubBatchStrategy = (raw: string): HubBatchStrategy => {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new HubFlowError({
      message: `Invalid --batch-strategy value. Use ${HUB_BATCH_STRATEGIES.join(", ")}.`,
    });
  }

  return parseHubBatchStrategyNormalized(normalized, raw);
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
    : HUB_BATCH_DEFAULT_STRATEGY;

  const maxTasks = hasMaxTasks
    ? parseHubBatchMaxTasks(input.maxTasks)
    : HUB_BATCH_DEFAULT_MAX_TASKS;

  return { batchStrategy, maxTasks };
};

export const resolveEffectiveHubBatchSelection = (input: {
  readonly flowKind: HubFlowKind;
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
}): ResolvedHubBatchSelectionOptions => {
  if (input.flowKind !== "task-board") {
    return {};
  }

  return {
    batchStrategy: input.batchStrategy ?? HUB_BATCH_DEFAULT_STRATEGY,
    maxTasks: input.maxTasks ?? HUB_BATCH_DEFAULT_MAX_TASKS,
  };
};

const partitionEligibleCandidates = (
  candidates: readonly HubTaskProjection[],
  selectionLimit: number,
): {
  readonly selectedTasks: readonly HubTaskProjection[];
  readonly deferredTasks: readonly HubBatchDeferredTask[];
} => {
  const eligible = candidates.filter(isHubFlowEligibleTask);
  return {
    selectedTasks: eligible.slice(0, selectionLimit),
    deferredTasks: eligible.slice(selectionLimit).map((task) => ({
      taskId: task.id,
      reason: "over_max_tasks",
    })),
  };
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
  readonly fallbackReason?: string;
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

const collectSelectedTaskBlockerIds = (
  selectedTasks: readonly HubBatchPlannerCandidate[],
): ReadonlySet<string> => {
  const blockerIds = new Set<string>();
  for (const task of selectedTasks) {
    for (const blocker of task.blockersResolved ?? []) {
      blockerIds.add(blocker.taskId);
    }
  }
  return blockerIds;
};

const resolvePlannedBatchSelection = (input: {
  readonly eligible: readonly HubTaskProjection[];
  readonly enrichedCandidates: readonly HubBatchPlannerCandidate[];
  readonly parsed: HubBatchPlannerAgentOutput;
  readonly maxTasks: number;
}): {
  readonly selectedTasks: readonly HubTaskProjection[];
  readonly deferredTasks: readonly HubBatchDeferredTask[];
  readonly diagnosticReason?: HubBatchDiagnosticReason;
} => {
  const selectedTasks = mapSelectedTasks(
    input.eligible,
    input.parsed.selectedTaskIds,
  );
  const selectedTaskIds = new Set(input.parsed.selectedTaskIds);
  const eligibleById = new Map(
    input.enrichedCandidates.map((task) => [task.id, task]),
  );
  const selectedDependencyBlockerIds = collectSelectedTaskBlockerIds(
    input.enrichedCandidates.filter((task) => selectedTaskIds.has(task.id)),
  );
  const deferredTasks: HubBatchDeferredTask[] = [];
  const invalidExplicitBlockerTaskIds = new Set<string>();

  for (const deferred of input.parsed.deferred) {
    const candidate = eligibleById.get(deferred.taskId);
    if (
      deferred.reason !== "explicit_blocker" ||
      candidate === undefined ||
      candidate.openBlockers.length > 0 ||
      candidate.unknownBlockers.length > 0 ||
      selectedDependencyBlockerIds.has(candidate.id)
    ) {
      deferredTasks.push(deferred);
      continue;
    }

    invalidExplicitBlockerTaskIds.add(candidate.id);
  }

  const capacity = Math.max(0, input.maxTasks - selectedTasks.length);
  const recoveredTasks = input.eligible
    .filter((task) => invalidExplicitBlockerTaskIds.has(task.id))
    .slice(0, capacity);
  selectedTasks.push(...recoveredTasks);

  const recoveredTaskIds = new Set(recoveredTasks.map((task) => task.id));
  const remainingInvalidTaskIds = [...invalidExplicitBlockerTaskIds].filter(
    (taskId) => !recoveredTaskIds.has(taskId),
  );

  return {
    selectedTasks,
    deferredTasks: [
      ...deferredTasks.filter((entry) => !recoveredTaskIds.has(entry.taskId)),
      ...remainingInvalidTaskIds.map((taskId) => ({
        taskId,
        reason: "over_max_tasks" as const,
      })),
    ],
    diagnosticReason:
      invalidExplicitBlockerTaskIds.size > 0
        ? "invalid_explicit_blocker_deferral"
        : undefined,
  };
};

const planConservativeHubFlowBatch = (
  input: HubBatchPlannerInput,
): HubBatchPlannerResult =>
  buildConservativeBatchResult({
    candidates: input.candidates,
    batchStrategyRequested: input.batchStrategy,
    maxTasks: input.maxTasks,
  });

const planLimitedBatch = (
  input: HubBatchPlannerInput,
): HubBatchPlannerResult => {
  const { selectedTasks, deferredTasks } = partitionEligibleCandidates(
    input.candidates,
    input.maxTasks,
  );

  return {
    selectedTasks,
    deferredTasks,
    batchStrategyRequested: "limited",
    batchStrategyUsed: "limited",
    maxTasks: input.maxTasks,
  };
};

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
    return fallbackPlannedHubFlowBatch(input, "planner_unavailable");
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

  const plannedSelection = resolvePlannedBatchSelection({
    eligible,
    enrichedCandidates,
    parsed,
    maxTasks: input.maxTasks,
  });

  return {
    selectedTasks: plannedSelection.selectedTasks,
    deferredTasks: plannedSelection.deferredTasks,
    batchStrategyRequested: "planned",
    batchStrategyUsed: "planned",
    maxTasks: input.maxTasks,
    rationale: parsed.rationale,
    ...(plannedSelection.diagnosticReason
      ? { diagnosticReason: plannedSelection.diagnosticReason }
      : {}),
  };
};

export const planHubFlowBatch = async (
  input: HubBatchPlannerInput,
): Promise<HubBatchPlannerResult> => {
  switch (input.batchStrategy) {
    case "conservative":
      return planConservativeHubFlowBatch(input);
    case "limited":
      return planLimitedBatch(input);
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

const indexHubTasksById = (
  candidates: readonly HubTaskProjection[],
): ReadonlyMap<string, HubTaskProjection> =>
  new Map(candidates.map((task) => [task.id, task] as const));

export const validateHubBatchSelectionFreshness = (input: {
  readonly selectedTaskIds: readonly string[];
  readonly freshCandidates: readonly HubTaskProjection[];
  readonly maxTasks: number;
}): {
  readonly valid: boolean;
  readonly invalidReasons: readonly HubBatchSelectionInvalidReason[];
} => {
  const invalidReasons = new Set<HubBatchSelectionInvalidReason>();
  const seen = new Set<string>();

  for (const taskId of input.selectedTaskIds) {
    if (seen.has(taskId)) {
      invalidReasons.add("duplicate_selection");
      break;
    }
    seen.add(taskId);
  }

  if (
    Number.isFinite(input.maxTasks) &&
    input.selectedTaskIds.length > input.maxTasks
  ) {
    invalidReasons.add("over_max_tasks");
  }

  const freshById = indexHubTasksById(input.freshCandidates);

  for (const taskId of input.selectedTaskIds) {
    const task = freshById.get(taskId);
    if (!task) {
      invalidReasons.add("not_in_candidate_set");
      continue;
    }
    if (task.claimState === "active") {
      invalidReasons.add("active_claim");
      continue;
    }
    if (task.hubStatus !== "ready_for_agent") {
      invalidReasons.add("not_ready_for_agent");
      continue;
    }
    if (!isHubFlowEligibleTask(task)) {
      invalidReasons.add("not_in_candidate_set");
    }
  }

  return {
    valid: invalidReasons.size === 0,
    invalidReasons: [...invalidReasons],
  };
};

const mapSelectedTaskIdsToFreshCandidates = (
  selectedTaskIds: readonly string[],
  freshCandidates: readonly HubTaskProjection[],
): readonly HubTaskProjection[] => {
  const freshById = indexHubTasksById(freshCandidates);
  return selectedTaskIds.flatMap((taskId) => {
    const task = freshById.get(taskId);
    return task ? [task] : [];
  });
};

export const resolveFreshValidatedHubBatchSelection = (input: {
  readonly initialSelectedTaskIds: readonly string[];
  readonly freshCandidates: readonly HubTaskProjection[];
  readonly batchStrategy?: HubBatchStrategy;
  readonly maxTasks?: number;
  readonly batchSelection?: HubBatchPlannerResult;
}): {
  readonly selectedTasks: readonly HubTaskProjection[];
  readonly batchSelection?: HubBatchPlannerResult;
  readonly fallbackReason?: string;
} => {
  let effectiveMaxTasks = input.maxTasks;
  if (effectiveMaxTasks === undefined) {
    effectiveMaxTasks = input.batchStrategy
      ? HUB_BATCH_DEFAULT_MAX_TASKS
      : Number.POSITIVE_INFINITY;
  }

  const validation = validateHubBatchSelectionFreshness({
    selectedTaskIds: input.initialSelectedTaskIds,
    freshCandidates: input.freshCandidates,
    maxTasks: effectiveMaxTasks,
  });

  if (validation.valid) {
    return {
      selectedTasks: mapSelectedTaskIdsToFreshCandidates(
        input.initialSelectedTaskIds,
        input.freshCandidates,
      ),
      batchSelection: input.batchSelection,
    };
  }

  const fallbackReason = validation.invalidReasons.join(", ");
  const fallbackSelection = buildConservativeBatchResult({
    candidates: input.freshCandidates,
    batchStrategyRequested: "conservative",
    maxTasks: input.maxTasks ?? HUB_BATCH_DEFAULT_MAX_TASKS,
    fallbackReason,
  });

  if (input.batchSelection) {
    return {
      selectedTasks: fallbackSelection.selectedTasks,
      batchSelection: {
        ...fallbackSelection,
        batchStrategyRequested: input.batchSelection.batchStrategyRequested,
      },
      fallbackReason,
    };
  }

  return {
    selectedTasks: fallbackSelection.selectedTasks,
    fallbackReason,
  };
};
