import { execFileSync } from "node:child_process";

import type { StandardSchemaV1 } from "@standard-schema/spec";

import { HubFlowError } from "./errors.js";
import { Output } from "./Output.js";
import {
  HUB_TRIAGE_LABELS_TO_CLEAR,
  HUB_TRIAGE_OUTCOME_LABELS,
  formatHubTriageComment,
  type HubTriageOutcome,
} from "./hubTriage.js";
import {
  appendHubTaskComment,
  loadHubTask,
  loadHubTaskBoard,
  type HubTaskBoard,
  type HubTaskProjection,
} from "./taskBoard.js";

export const TRIAGE_PROPOSAL_OUTPUT_TAG = "triage-proposal";

export type TriageConfidence = "high" | "medium" | "low";

export type TriageDependencyAction = "add" | "remove";

export interface TriageDependencyChange {
  readonly action: TriageDependencyAction;
  readonly dependentTaskId: string;
  readonly blockerTaskId: string;
}

export interface TriageTaskRecommendation {
  readonly taskId: string;
  readonly outcome: HubTriageOutcome;
  readonly confidence: TriageConfidence;
  readonly labels?: readonly string[];
  readonly rationale: string;
  readonly comment: string;
  readonly dependencyChanges?: readonly TriageDependencyChange[];
}

export interface TriageProposal {
  readonly taskQuery: string;
  readonly recommendations: readonly TriageTaskRecommendation[];
  readonly summary?: string;
}

export interface TriagePreparedTaskContext {
  readonly id: string;
  readonly title: string;
  readonly hubStatus: string;
  readonly description?: string;
  readonly notes?: string;
  readonly labels: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly comments: readonly {
    readonly author?: string;
    readonly body?: string;
    readonly createdAt?: string;
  }[];
}

export interface TriagePreparedContext {
  readonly flowId: "triage";
  readonly taskQuery: string;
  readonly tasks: readonly TriagePreparedTaskContext[];
}

const TRIAGE_OUTCOMES = [
  "needs_info",
  "ready_for_agent",
  "ready_for_human",
  "wontfix",
] as const satisfies readonly HubTriageOutcome[];

const TRIAGE_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

const SAFE_TRIAGE_OUTCOMES_FOR_YES = new Set<HubTriageOutcome>([
  "needs_info",
  "ready_for_agent",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readNonEmptyString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });

  return items;
};

const parseDependencyChange = (
  value: unknown,
): TriageDependencyChange | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const action = value.action;
  const dependentTaskId = readNonEmptyString(value, "dependentTaskId");
  const blockerTaskId = readNonEmptyString(value, "blockerTaskId");
  if (
    (action !== "add" && action !== "remove") ||
    !dependentTaskId ||
    !blockerTaskId
  ) {
    return undefined;
  }

  return { action, dependentTaskId, blockerTaskId };
};

const parseRecommendation = (
  value: unknown,
): TriageTaskRecommendation | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const taskId = readNonEmptyString(value, "taskId");
  const outcome = value.outcome;
  const confidence = value.confidence;
  const rationale = readNonEmptyString(value, "rationale");
  const comment = readNonEmptyString(value, "comment");
  if (
    !taskId ||
    !rationale ||
    !comment ||
    !(TRIAGE_OUTCOMES as readonly string[]).includes(String(outcome)) ||
    !(TRIAGE_CONFIDENCE_LEVELS as readonly string[]).includes(
      String(confidence),
    )
  ) {
    return undefined;
  }

  const labels = readStringArray(value.labels);
  const dependencyChanges = Array.isArray(value.dependencyChanges)
    ? value.dependencyChanges.flatMap((entry) => {
        const parsed = parseDependencyChange(entry);
        return parsed ? [parsed] : [];
      })
    : undefined;

  return {
    taskId,
    outcome: outcome as HubTriageOutcome,
    confidence: confidence as TriageConfidence,
    ...(labels && labels.length > 0 ? { labels } : {}),
    rationale,
    comment,
    ...(dependencyChanges && dependencyChanges.length > 0
      ? { dependencyChanges }
      : {}),
  };
};

const triageProposalSchema = (): StandardSchemaV1<unknown, TriageProposal> => ({
  "~standard": {
    version: 1,
    vendor: "sandcastle",
    validate: (value: unknown) => {
      if (!isRecord(value)) {
        return { issues: [{ message: "Expected a triage proposal object" }] };
      }

      const taskQuery = readNonEmptyString(value, "taskQuery");
      if (!taskQuery) {
        return { issues: [{ message: "taskQuery is required" }] };
      }

      if (!Array.isArray(value.recommendations)) {
        return {
          issues: [{ message: "recommendations must be an array" }],
        };
      }

      const recommendations: TriageTaskRecommendation[] = [];
      for (const [index, entry] of value.recommendations.entries()) {
        const parsed = parseRecommendation(entry);
        if (!parsed) {
          return {
            issues: [
              {
                message: `Invalid recommendation at index ${index}`,
              },
            ],
          };
        }
        recommendations.push(parsed);
      }

      if (recommendations.length === 0) {
        return {
          issues: [{ message: "At least one recommendation is required" }],
        };
      }

      const summary = readNonEmptyString(value, "summary");
      return {
        value: {
          taskQuery,
          recommendations,
          ...(summary ? { summary } : {}),
        },
      };
    },
  },
});

export const createTriageProposalOutput = () =>
  Output.object({
    tag: TRIAGE_PROPOSAL_OUTPUT_TAG,
    schema: triageProposalSchema(),
  });

export const selectTasksForTriageQuery = (
  board: HubTaskBoard,
  query: string,
): readonly HubTaskProjection[] => {
  const statusSet = new Set(
    query
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  return board.tasks.filter((task) => statusSet.has(task.hubStatus));
};

export const prepareTriageProposalContext = (input: {
  readonly cwd: string;
  readonly taskQuery: string;
  readonly env?: NodeJS.ProcessEnv;
}): TriagePreparedContext => {
  const board = loadHubTaskBoard(input.cwd, input.env);
  const tasks = selectTasksForTriageQuery(board, input.taskQuery).map(
    (task) => ({
      id: task.id,
      title: task.title,
      hubStatus: task.hubStatus,
      ...(task.description ? { description: task.description } : {}),
      ...(task.notes ? { notes: task.notes } : {}),
      labels: task.labels,
      metadata: task.metadata,
      comments: task.comments,
    }),
  );

  return {
    flowId: "triage",
    taskQuery: input.taskQuery,
    tasks,
  };
};

export const validateTriageProposalAgainstContext = (
  proposal: TriageProposal,
  context: TriagePreparedContext,
): void => {
  const knownTaskIds = new Set(context.tasks.map((task) => task.id));
  for (const recommendation of proposal.recommendations) {
    if (!knownTaskIds.has(recommendation.taskId)) {
      throw new HubFlowError({
        message: `Triage proposal references unknown task "${recommendation.taskId}".`,
      });
    }

    for (const change of recommendation.dependencyChanges ?? []) {
      if (!knownTaskIds.has(change.dependentTaskId)) {
        throw new HubFlowError({
          message: `Triage dependency change references unknown dependent task "${change.dependentTaskId}".`,
        });
      }
      if (!knownTaskIds.has(change.blockerTaskId)) {
        throw new HubFlowError({
          message: `Triage dependency change references unknown blocker task "${change.blockerTaskId}".`,
        });
      }
    }
  }
};

export const recommendationHasDependencyChanges = (
  recommendation: TriageTaskRecommendation,
): boolean => (recommendation.dependencyChanges?.length ?? 0) > 0;

export const isSafeTriageDecisionForYes = (
  recommendation: TriageTaskRecommendation,
): boolean =>
  recommendation.confidence === "high" &&
  SAFE_TRIAGE_OUTCOMES_FOR_YES.has(recommendation.outcome) &&
  !recommendationHasDependencyChanges(recommendation);

export const partitionTriageRecommendations = (
  recommendations: readonly TriageTaskRecommendation[],
): {
  readonly safe: readonly TriageTaskRecommendation[];
  readonly requiresConfirmation: readonly TriageTaskRecommendation[];
} => {
  const safe: TriageTaskRecommendation[] = [];
  const requiresConfirmation: TriageTaskRecommendation[] = [];

  for (const recommendation of recommendations) {
    if (isSafeTriageDecisionForYes(recommendation)) {
      safe.push(recommendation);
    } else {
      requiresConfirmation.push(recommendation);
    }
  }

  return { safe, requiresConfirmation };
};

export const formatBlockedTriageReason = (
  recommendation: TriageTaskRecommendation,
): string => {
  if (recommendation.outcome === "wontfix") {
    return "wontfix requires explicit confirmation";
  }
  if (recommendationHasDependencyChanges(recommendation)) {
    return "dependency-changing triage decisions require explicit confirmation";
  }
  if (recommendation.confidence === "medium") {
    return "medium-confidence triage decisions require explicit confirmation";
  }
  if (recommendation.confidence === "low") {
    return "low-confidence triage decisions require explicit confirmation";
  }
  if (recommendation.outcome === "ready_for_human") {
    return "ready_for_human requires explicit confirmation";
  }
  return "triage decision requires explicit confirmation";
};

const blockedTriageRecommendations = (
  recommendations: readonly TriageTaskRecommendation[],
): {
  readonly safe: readonly TriageTaskRecommendation[];
  readonly blocked: readonly { taskId: string; reason: string }[];
} => {
  const { safe, requiresConfirmation } =
    partitionTriageRecommendations(recommendations);
  return {
    safe,
    blocked: requiresConfirmation.map((recommendation) => ({
      taskId: recommendation.taskId,
      reason: formatBlockedTriageReason(recommendation),
    })),
  };
};

export const filterTriageProposalForYes = (
  proposal: TriageProposal,
): {
  readonly proposal: TriageProposal;
  readonly blocked: readonly {
    readonly taskId: string;
    readonly reason: string;
  }[];
} => {
  const { safe, blocked } = blockedTriageRecommendations(
    proposal.recommendations,
  );

  return {
    proposal: {
      ...proposal,
      recommendations: safe,
    },
    blocked,
  };
};

const runBdText = (
  cwd: string,
  args: readonly string[],
  failureLabel: string,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  try {
    execFileSync("bd", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unable to execute bd";
    throw new HubFlowError({
      message: `sandcastle ${failureLabel} requires Beads in the current repo: ${message}`,
    });
  }
};

const applyTriageOutcomeUpdate = (
  cwd: string,
  taskId: string,
  task: HubTaskProjection,
  outcome: HubTriageOutcome,
  env: NodeJS.ProcessEnv,
  extraMetadata: Readonly<Record<string, unknown>>,
  additionalLabels: readonly string[],
): void => {
  const metadata: Record<string, unknown> = {
    ...task.metadata,
    ...extraMetadata,
    hub_status: outcome,
  };

  if (outcome === "wontfix") {
    metadata.wontfix = true;
  } else {
    delete metadata.wontfix;
  }

  const args = ["update", taskId, "--set-metadata", JSON.stringify(metadata)];
  for (const label of HUB_TRIAGE_LABELS_TO_CLEAR) {
    args.push("--remove-labels", label);
  }

  const labelsToAdd = new Set<string>([
    HUB_TRIAGE_OUTCOME_LABELS[outcome],
    ...additionalLabels.filter((label) => label.trim().length > 0),
  ]);
  for (const label of labelsToAdd) {
    args.push("--add-labels", label);
  }

  if (outcome === "wontfix") {
    args.push("--status", "closed");
  } else {
    args.push("--status", "open");
  }

  runBdText(cwd, args, `tasks triage ${taskId}`, env);
};

const applyDependencyChange = (
  cwd: string,
  change: TriageDependencyChange,
  env: NodeJS.ProcessEnv,
): void => {
  if (change.action === "add") {
    runBdText(
      cwd,
      [
        "dep",
        "add",
        change.dependentTaskId,
        change.blockerTaskId,
        "--type",
        "blocks",
      ],
      `tasks triage dependency ${change.dependentTaskId} -> ${change.blockerTaskId}`,
      env,
    );
    return;
  }

  runBdText(
    cwd,
    ["dep", "remove", change.dependentTaskId, change.blockerTaskId],
    `tasks triage dependency remove ${change.dependentTaskId} -> ${change.blockerTaskId}`,
    env,
  );
};

export interface ApplyTriageRecommendationResult {
  readonly taskId: string;
  readonly outcome: HubTriageOutcome;
}

export interface ApplyTriageProposalInput {
  readonly cwd: string;
  readonly proposal: TriageProposal;
  readonly runId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly yesMode?: boolean;
  readonly allowRiskyDecisions?: boolean;
}

export interface ApplyTriageProposalResult {
  readonly applied: readonly ApplyTriageRecommendationResult[];
  readonly blocked: readonly {
    readonly taskId: string;
    readonly reason: string;
  }[];
}

export const applyTriageProposal = (
  input: ApplyTriageProposalInput,
): ApplyTriageProposalResult => {
  const env = input.env ?? process.env;
  let recommendations = input.proposal.recommendations;
  const blocked: { taskId: string; reason: string }[] = [];

  if (input.yesMode || !input.allowRiskyDecisions) {
    const partitioned = blockedTriageRecommendations(recommendations);
    recommendations = partitioned.safe;
    blocked.push(...partitioned.blocked);
  }

  const applied: ApplyTriageRecommendationResult[] = [];
  for (const recommendation of recommendations) {
    const task = loadHubTask(input.cwd, recommendation.taskId, env);
    const additionalLabels = (recommendation.labels ?? []).filter(
      (label) =>
        !(HUB_TRIAGE_LABELS_TO_CLEAR as readonly string[]).includes(label) &&
        label !== HUB_TRIAGE_OUTCOME_LABELS[recommendation.outcome],
    );

    applyTriageOutcomeUpdate(
      input.cwd,
      recommendation.taskId,
      task,
      recommendation.outcome,
      env,
      {
        triage_run_id: input.runId,
        triage_confidence: recommendation.confidence,
      },
      additionalLabels,
    );

    appendHubTaskComment(
      input.cwd,
      recommendation.taskId,
      formatHubTriageComment(recommendation.comment),
      env,
    );

    for (const change of recommendation.dependencyChanges ?? []) {
      applyDependencyChange(input.cwd, change, env);
    }

    applied.push({
      taskId: recommendation.taskId,
      outcome: recommendation.outcome,
    });
  }

  return { applied, blocked };
};

export const formatTriagePreparedContextForPrompt = (
  context: TriagePreparedContext,
): string => JSON.stringify(context, null, 2);

export const injectPreparedContextIntoPrompt = (
  promptTemplate: string,
  context: TriagePreparedContext,
): string =>
  promptTemplate.replace(
    "{{PREPARED_CONTEXT}}",
    formatTriagePreparedContextForPrompt(context),
  );
