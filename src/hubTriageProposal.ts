import { execFileSync } from "node:child_process";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { Output } from "./Output.js";
import { createHubProposalAgentInvoker } from "./hubProposalAgent.js";
import {
  ensureHubAgentRolesConfigured,
  type HubAgentConfig,
  type HubAgentRoleConfigurator,
} from "./hubAgentConfig.js";
import { readHubFlowPrompt } from "./hubFlows.js";
import { resolveProposalSessionApproval } from "./hubPrdDecomposition.js";
import {
  formatHubTriageComment,
  HUB_TRIAGE_SOURCE_STATUSES,
  isHubTriageSourceStatus,
  type HubTriageOutcome,
} from "./hubTriage.js";
import {
  runProposalSession,
  writeProposalSessionApplyResult,
  type ProposalAgentInvoker,
  type ProposalSessionInteraction,
  type RunProposalSessionResult,
} from "./hubProposalSession.js";
import { resolveBdExecutable } from "./resolveBdExecutable.js";
import { TaskBoardError } from "./errors.js";
import {
  addHubTaskDependency,
  appendHubTaskComment,
  loadHubTask,
  loadHubTaskBoard,
  updateHubTaskStatus,
  type HubTaskProjection,
} from "./taskBoard.js";

export type TriageConfidence = "low" | "medium" | "high";

export type TriageConfirmationReason =
  | "wontfix"
  | "dependency_change"
  | "medium_confidence"
  | "low_confidence";

export interface TriageDependencySuggestion {
  readonly dependentTaskId: string;
  readonly blockerTaskId: string;
  readonly rationale: string;
}

export interface TriageProposalDecision {
  readonly taskId: string;
  readonly outcome: HubTriageOutcome;
  readonly category: string;
  readonly confidence: TriageConfidence;
  readonly rationale: string;
  readonly comment: string;
  readonly labels?: readonly string[];
  readonly needsInfoQuestions?: readonly string[];
  readonly dependencySuggestions?: readonly TriageDependencySuggestion[];
}

export interface TriageProposal {
  readonly summary: string;
  readonly decisions: readonly TriageProposalDecision[];
}

export interface TriagePreparedContext {
  readonly taskQuery: string;
  readonly taskCount: number;
  readonly hubTaskSummary: {
    readonly totalTasks: number;
    readonly inboxCount: number;
    readonly needsInfoCount: number;
  };
  readonly taskDetails: string;
  readonly tasksUnderTriage: readonly HubTaskProjection[];
}

export interface ValidateTriageProposalOptions {
  readonly knownTaskIds: ReadonlySet<string> | readonly string[];
  readonly boardTaskIds?: readonly string[];
  readonly requiredTaskIds?: ReadonlySet<string> | readonly string[];
}

export interface ApplyTriageProposalInput {
  readonly cwd: string;
  readonly proposal: TriageProposal;
  readonly decisionsToApply: ReadonlySet<string>;
  readonly proposalRunId: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ApplyTriageProposalResult {
  readonly appliedDecisions: readonly string[];
  readonly dependencies: readonly {
    readonly dependentId: string;
    readonly blockerId: string;
  }[];
}

const TRIAGE_PROPOSAL_OUTPUT_TAG = "triage-proposal";
const CONFIDENCE_SET = new Set<TriageConfidence>(["low", "medium", "high"]);
const OUTCOME_SET = new Set<HubTriageOutcome>([
  "needs_info",
  "ready_for_agent",
  "ready_for_human",
  "wontfix",
]);

const TRIAGE_LABELS_TO_CLEAR = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
] as const;

const TASK_ID_PATTERN = /^bd-\d+$/i;
const MAX_COMMENTS_IN_DETAILS = 5;

const toKnownTaskIdSet = (
  knownTaskIds: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> =>
  knownTaskIds instanceof Set ? knownTaskIds : new Set(knownTaskIds);

const readNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
};

const readRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readOptionalStringArray = (
  value: unknown,
  label: string,
): readonly string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided.`);
  }
  return value.map((entry, index) =>
    readNonEmptyString(entry, `${label}[${index}]`),
  );
};

const assertOutcome = (value: unknown, label: string): HubTriageOutcome => {
  const normalized = readNonEmptyString(value, label);
  if (!OUTCOME_SET.has(normalized as HubTriageOutcome)) {
    throw new Error(
      `${label} must be needs_info, ready_for_agent, ready_for_human, or wontfix.`,
    );
  }
  return normalized as HubTriageOutcome;
};

const assertConfidence = (value: unknown, label: string): TriageConfidence => {
  const normalized = readNonEmptyString(value, label);
  if (!CONFIDENCE_SET.has(normalized as TriageConfidence)) {
    throw new Error(`${label} must be low, medium, or high.`);
  }
  return normalized as TriageConfidence;
};

const parseDependencySuggestion = (
  value: unknown,
  index: number,
  decisionIndex: number,
): TriageDependencySuggestion => {
  const record = readRecord(
    value,
    `decisions[${decisionIndex}].dependencySuggestions[${index}]`,
  );
  return {
    dependentTaskId: readNonEmptyString(
      record.dependentTaskId,
      `decisions[${decisionIndex}].dependencySuggestions[${index}].dependentTaskId`,
    ),
    blockerTaskId: readNonEmptyString(
      record.blockerTaskId,
      `decisions[${decisionIndex}].dependencySuggestions[${index}].blockerTaskId`,
    ),
    rationale: readNonEmptyString(
      record.rationale,
      `decisions[${decisionIndex}].dependencySuggestions[${index}].rationale`,
    ),
  };
};

const parseTriageProposalDecision = (
  value: unknown,
  index: number,
): TriageProposalDecision => {
  const record = readRecord(value, `decisions[${index}]`);
  const dependencySuggestions = Array.isArray(record.dependencySuggestions)
    ? record.dependencySuggestions.map((entry, depIndex) =>
        parseDependencySuggestion(entry, depIndex, index),
      )
    : undefined;

  return {
    taskId: readNonEmptyString(record.taskId, `decisions[${index}].taskId`),
    outcome: assertOutcome(record.outcome, `decisions[${index}].outcome`),
    category: readNonEmptyString(
      record.category,
      `decisions[${index}].category`,
    ),
    confidence: assertConfidence(
      record.confidence,
      `decisions[${index}].confidence`,
    ),
    rationale: readNonEmptyString(
      record.rationale,
      `decisions[${index}].rationale`,
    ),
    comment: readNonEmptyString(record.comment, `decisions[${index}].comment`),
    labels: readOptionalStringArray(
      record.labels,
      `decisions[${index}].labels`,
    ),
    needsInfoQuestions: readOptionalStringArray(
      record.needsInfoQuestions,
      `decisions[${index}].needsInfoQuestions`,
    ),
    dependencySuggestions,
  };
};

const parseTriageProposal = (value: unknown): TriageProposal => {
  const record = readRecord(value, "Triage proposal");
  const decisions = Array.isArray(record.decisions)
    ? record.decisions.map((decision, index) =>
        parseTriageProposalDecision(decision, index),
      )
    : [];

  if (decisions.length === 0) {
    throw new Error("decisions must be a non-empty array.");
  }

  return {
    summary: readNonEmptyString(record.summary, "summary"),
    decisions,
  };
};

const triageProposalSchema = (): StandardSchemaV1<unknown, TriageProposal> => ({
  "~standard": {
    version: 1,
    vendor: "sandcastle",
    validate: (value: unknown) => {
      try {
        return { value: parseTriageProposal(value) };
      } catch (error) {
        return {
          issues: [{ message: toErrorMessage(error) }],
        };
      }
    },
  },
});

export const triageProposalOutput = () =>
  Output.object({
    tag: TRIAGE_PROPOSAL_OUTPUT_TAG,
    schema: triageProposalSchema(),
  });

const collectDuplicateTaskIds = (
  decisions: readonly TriageProposalDecision[],
): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.taskId)) {
      duplicates.add(decision.taskId);
    }
    seen.add(decision.taskId);
  }
  return [...duplicates];
};

const collectProposalDependencyEdges = (
  proposal: TriageProposal,
): TriageDependencySuggestion[] => {
  const edges: TriageDependencySuggestion[] = [];
  for (const decision of proposal.decisions) {
    for (const suggestion of decision.dependencySuggestions ?? []) {
      edges.push(suggestion);
    }
  }
  return edges;
};

// Cycle detection covers only dependency edges proposed in this batch. Existing
// board edges are assumed acyclic; combining them with new edges is not checked.
const detectDependencyCycles = (
  edges: readonly TriageDependencySuggestion[],
): string[] => {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.dependentTaskId === edge.blockerTaskId) {
      return [edge.dependentTaskId];
    }
    const neighbors = graph.get(edge.dependentTaskId) ?? [];
    neighbors.push(edge.blockerTaskId);
    graph.set(edge.dependentTaskId, neighbors);
    graph.set(edge.blockerTaskId, graph.get(edge.blockerTaskId) ?? []);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  const visit = (node: string): void => {
    if (visited.has(node)) {
      return;
    }
    if (visiting.has(node)) {
      cycles.push(node);
      return;
    }

    visiting.add(node);
    for (const neighbor of graph.get(node) ?? []) {
      visit(neighbor);
    }
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of graph.keys()) {
    visit(node);
  }

  return cycles;
};

export const validateTriageProposal = (
  proposal: TriageProposal,
  options: ValidateTriageProposalOptions,
): void => {
  if (proposal.decisions.length === 0) {
    throw new Error("Triage proposal must include at least one decision.");
  }

  const knownTaskIds = toKnownTaskIdSet(options.knownTaskIds);
  const boardTaskIds = new Set(options.boardTaskIds ?? [...knownTaskIds]);

  const duplicateTaskIds = collectDuplicateTaskIds(proposal.decisions);
  if (duplicateTaskIds.length > 0) {
    throw new Error(
      `Duplicate decision task ids: ${duplicateTaskIds.join(", ")}.`,
    );
  }

  for (const decision of proposal.decisions) {
    if (!knownTaskIds.has(decision.taskId)) {
      throw new Error(
        `Triage proposal references unknown task id "${decision.taskId}".`,
      );
    }
  }

  const edges = collectProposalDependencyEdges(proposal);
  for (const edge of edges) {
    if (edge.dependentTaskId === edge.blockerTaskId) {
      throw new Error(
        `Triage proposal contains a self-edge dependency on "${edge.dependentTaskId}".`,
      );
    }
    if (!boardTaskIds.has(edge.dependentTaskId)) {
      throw new Error(
        `Triage proposal dependency references unknown dependent task id "${edge.dependentTaskId}".`,
      );
    }
    if (!boardTaskIds.has(edge.blockerTaskId)) {
      throw new Error(
        `Triage proposal dependency references unknown blocker task id "${edge.blockerTaskId}".`,
      );
    }
  }

  const cycles = detectDependencyCycles(edges);
  if (cycles.length > 0) {
    throw new Error(
      `Triage proposal contains dependency cycles involving: ${cycles.join(", ")}.`,
    );
  }

  if (options.requiredTaskIds) {
    const decisionTaskIds = new Set(
      proposal.decisions.map((decision) => decision.taskId),
    );
    const missingTaskIds = [...options.requiredTaskIds].filter(
      (taskId) => !decisionTaskIds.has(taskId),
    );
    if (missingTaskIds.length > 0) {
      throw new Error(
        `Triage proposal is missing decisions for: ${missingTaskIds.join(", ")}.`,
      );
    }
  }
};

const formatHubTaskSummaryText = (
  summary: TriagePreparedContext["hubTaskSummary"],
): string =>
  [
    `Total tasks: ${summary.totalTasks}`,
    `Inbox: ${summary.inboxCount}`,
    `Needs info: ${summary.needsInfoCount}`,
  ].join("\n");

const readMetadataText = (
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

const readDependencyIds = (
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): readonly string[] => {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      return value
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0);
    }
  }
  return [];
};

const formatCommentForDetails = (
  comment: HubTaskProjection["comments"][number],
): string => {
  const parts: string[] = [];
  if (comment.author) {
    parts.push(comment.author);
  }
  const prefix = parts.length > 0 ? `${parts.join(" · ")}: ` : "";
  return `${prefix}${comment.body ?? ""}`.trim();
};

const formatTaskDetailBlock = (task: HubTaskProjection): string => {
  const lines = [
    `### ${task.id}: ${task.title}`,
    `- hubStatus: ${task.hubStatus}`,
    `- labels: ${task.labels.join(", ") || "(none)"}`,
  ];

  const kind = readMetadataText(task.metadata, ["kind", "category"]);
  const executionMode = readMetadataText(task.metadata, [
    "execution_mode",
    "executionMode",
  ]);
  if (kind) {
    lines.push(`- kind/category: ${kind}`);
  }
  if (executionMode) {
    lines.push(`- execution_mode: ${executionMode}`);
  }

  const blockers = readDependencyIds(task.metadata, [
    "blockers",
    "blocked_by",
    "blockedBy",
  ]);
  const blocks = readDependencyIds(task.metadata, ["blocks", "blocking"]);
  if (blockers.length > 0) {
    lines.push(`- blocked by: ${blockers.join(", ")}`);
  }
  if (blocks.length > 0) {
    lines.push(`- blocks: ${blocks.join(", ")}`);
  }

  lines.push("", "Description:", task.description?.trim() || "(empty)");

  const recentComments = task.comments.slice(-MAX_COMMENTS_IN_DETAILS);
  lines.push("", `Comments (last ${recentComments.length}):`);
  if (recentComments.length === 0) {
    lines.push("(none)");
  } else {
    for (const comment of recentComments) {
      lines.push(`- ${formatCommentForDetails(comment)}`);
    }
  }

  return lines.join("\n");
};

const resolveTasksUnderTriage = (
  cwd: string,
  input: {
    readonly query?: string;
    readonly taskIds?: readonly string[];
  },
  env: NodeJS.ProcessEnv,
): { readonly taskQuery: string; readonly tasks: HubTaskProjection[] } => {
  const board = loadHubTaskBoard(cwd, env);

  if (input.taskIds && input.taskIds.length > 0) {
    const tasks = input.taskIds.map((taskId) => loadHubTask(cwd, taskId, env));
    for (const task of tasks) {
      if (!isHubTriageSourceStatus(task.hubStatus)) {
        throw new TaskBoardError({
          message: `Task ${task.id} has status "${task.hubStatus}" and is outside triage scope. Triage only covers inbox and needs_info tasks.`,
        });
      }
    }
    return {
      taskQuery:
        input.taskIds.length === 1
          ? input.taskIds[0]!
          : input.taskIds.join(","),
      tasks,
    };
  }

  const statuses = (input.query ?? HUB_TRIAGE_SOURCE_STATUSES.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const statusSet = new Set(statuses);
  const tasks = board.tasks
    .filter((task) => statusSet.has(task.hubStatus))
    .map((task) => loadHubTask(cwd, task.id, env));

  return {
    taskQuery: statuses.join(","),
    tasks,
  };
};

export const prepareTriageContext = (input: {
  readonly cwd: string;
  readonly query?: string;
  readonly taskIds?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): TriagePreparedContext => {
  const env = input.env ?? process.env;
  const board = loadHubTaskBoard(input.cwd, env);
  const inboxCount =
    board.groups.find((group) => group.status === "inbox")?.tasks.length ?? 0;
  const needsInfoCount =
    board.groups.find((group) => group.status === "needs_info")?.tasks.length ??
    0;

  const { taskQuery, tasks } = resolveTasksUnderTriage(
    input.cwd,
    { query: input.query, taskIds: input.taskIds },
    env,
  );

  return {
    taskQuery,
    taskCount: tasks.length,
    hubTaskSummary: {
      totalTasks: board.tasks.length,
      inboxCount,
      needsInfoCount,
    },
    taskDetails: tasks.map(formatTaskDetailBlock).join("\n\n"),
    tasksUnderTriage: tasks,
  };
};

export const substituteTriageDraftPrompt = (
  template: string,
  context: TriagePreparedContext,
): string =>
  template
    .replaceAll("{{TASK_QUERY}}", context.taskQuery)
    .replaceAll("{{TASK_COUNT}}", String(context.taskCount))
    .replaceAll(
      "{{HUB_TASK_SUMMARY}}",
      formatHubTaskSummaryText(context.hubTaskSummary),
    )
    .replaceAll("{{TASK_DETAILS}}", context.taskDetails);

const runBdText = (
  cwd: string,
  args: readonly string[],
  failureLabel: string,
  env: NodeJS.ProcessEnv,
): void => {
  try {
    execFileSync(resolveBdExecutable(env), [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unable to execute bd";
    throw new TaskBoardError({
      message: `sandcastle ${failureLabel} requires Beads in the current repo: ${message}`,
    });
  }
};

const addHubTaskLabels = (
  cwd: string,
  taskId: string,
  labels: readonly string[],
  env: NodeJS.ProcessEnv,
): void => {
  const normalized = labels.map((label) => label.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return;
  }

  runBdText(
    cwd,
    ["update", taskId, "--add-labels", normalized.join(",")],
    `tasks triage ${taskId}`,
    env,
  );
};

const applyWontfixOutcome = (
  cwd: string,
  task: HubTaskProjection,
  env: NodeJS.ProcessEnv,
): void => {
  updateHubTaskStatus({
    cwd,
    taskId: task.id,
    hubStatus: "wontfix",
    metadata: {
      ...task.metadata,
      hub_status: "wontfix",
      wontfix: true,
    },
    env,
  });

  const args = ["update", task.id];
  for (const label of TRIAGE_LABELS_TO_CLEAR) {
    args.push("--remove-labels", label);
  }
  args.push("--add-labels", "wontfix");
  runBdText(cwd, args, `tasks triage ${task.id}`, env);
};

const applyNonWontfixOutcome = (
  cwd: string,
  task: HubTaskProjection,
  outcome: Exclude<HubTriageOutcome, "wontfix">,
  env: NodeJS.ProcessEnv,
): void => {
  const metadata: Record<string, unknown> = {
    ...task.metadata,
    hub_status: outcome,
  };
  delete metadata.wontfix;

  updateHubTaskStatus({
    cwd,
    taskId: task.id,
    hubStatus: outcome,
    metadata,
    env,
  });

  const labelsToRemove = TRIAGE_LABELS_TO_CLEAR.filter(
    (label) => label !== metadataLabelForOutcome(outcome),
  );
  if (labelsToRemove.length > 0) {
    runBdText(
      cwd,
      ["update", task.id, "--remove-labels", labelsToRemove.join(",")],
      `tasks triage ${task.id}`,
      env,
    );
  }
};

const metadataLabelForOutcome = (
  outcome: Exclude<HubTriageOutcome, "wontfix">,
): string => {
  switch (outcome) {
    case "needs_info":
      return "needs-info";
    case "ready_for_agent":
      return "ready-for-agent";
    case "ready_for_human":
      return "ready-for-human";
  }
};

export const classifyTriageDecisionAutoApply = (
  decision: TriageProposalDecision,
): "auto" | "needs_confirmation" => {
  if (decision.confidence !== "high") {
    return "needs_confirmation";
  }
  if (decision.outcome === "wontfix") {
    return "needs_confirmation";
  }
  if ((decision.dependencySuggestions?.length ?? 0) > 0) {
    return "needs_confirmation";
  }
  return "auto";
};

export const triageDecisionConfirmationReason = (
  decision: TriageProposalDecision,
): TriageConfirmationReason => {
  if (decision.outcome === "wontfix") {
    return "wontfix";
  }
  if ((decision.dependencySuggestions?.length ?? 0) > 0) {
    return "dependency_change";
  }
  if (decision.confidence === "medium") {
    return "medium_confidence";
  }
  return "low_confidence";
};

export const applyTriageProposal = (
  input: ApplyTriageProposalInput,
): ApplyTriageProposalResult => {
  const env = input.env ?? process.env;
  const board = loadHubTaskBoard(input.cwd, env);
  const boardTaskIds = new Set(board.tasks.map((task) => task.id));
  const appliedDecisions: string[] = [];
  const dependencies: { dependentId: string; blockerId: string }[] = [];
  const appliedEdges = new Set<string>();

  for (const decision of input.proposal.decisions) {
    if (!input.decisionsToApply.has(decision.taskId)) {
      continue;
    }

    const task = loadHubTask(input.cwd, decision.taskId, env);
    if (decision.outcome === "wontfix") {
      applyWontfixOutcome(input.cwd, task, env);
    } else {
      applyNonWontfixOutcome(input.cwd, task, decision.outcome, env);
    }

    if (decision.labels && decision.labels.length > 0) {
      addHubTaskLabels(input.cwd, decision.taskId, decision.labels, env);
    }

    appendHubTaskComment(
      input.cwd,
      decision.taskId,
      formatHubTriageComment(decision.comment),
      env,
    );
    appliedDecisions.push(decision.taskId);
  }

  for (const decision of input.proposal.decisions) {
    if (!input.decisionsToApply.has(decision.taskId)) {
      continue;
    }

    for (const suggestion of decision.dependencySuggestions ?? []) {
      const dependentApproved =
        input.decisionsToApply.has(suggestion.dependentTaskId) ||
        boardTaskIds.has(suggestion.dependentTaskId);
      const blockerApproved =
        input.decisionsToApply.has(suggestion.blockerTaskId) ||
        boardTaskIds.has(suggestion.blockerTaskId);
      if (!dependentApproved || !blockerApproved) {
        continue;
      }

      const edgeKey = `${suggestion.dependentTaskId}->${suggestion.blockerTaskId}`;
      if (appliedEdges.has(edgeKey)) {
        continue;
      }

      addHubTaskDependency(
        input.cwd,
        suggestion.dependentTaskId,
        suggestion.blockerTaskId,
        env,
      );
      appliedEdges.add(edgeKey);
      dependencies.push({
        dependentId: suggestion.dependentTaskId,
        blockerId: suggestion.blockerTaskId,
      });
    }
  }

  return { appliedDecisions, dependencies };
};

export const formatTriageProposalLines = (
  proposal: TriageProposal,
): readonly string[] => {
  const lines = [
    `Summary: ${proposal.summary}`,
    `Decisions: ${proposal.decisions.length}`,
  ];

  if (proposal.decisions.length === 0) {
    return lines;
  }

  lines.push("");
  for (const [index, decision] of proposal.decisions.entries()) {
    lines.push(
      `${index + 1}. ${decision.taskId} -> ${decision.outcome} (${decision.confidence})`,
    );
    lines.push(`   Category: ${decision.category}`);
    lines.push(`   Rationale: ${decision.rationale}`);
    if (decision.labels && decision.labels.length > 0) {
      lines.push(`   Labels: ${decision.labels.join(", ")}`);
    }
    if (
      decision.dependencySuggestions &&
      decision.dependencySuggestions.length > 0
    ) {
      lines.push("   Dependency suggestions:");
      for (const edge of decision.dependencySuggestions) {
        lines.push(
          `     - ${edge.dependentTaskId} blocked by ${edge.blockerTaskId}: ${edge.rationale}`,
        );
      }
    }
  }

  return lines;
};

export type SkippedTriageDecisionReason =
  | "user_rejected"
  | "unconfirmed"
  | "non_tty_skipped";

export type RunTriageProposalFlowResult =
  | {
      readonly outcome: "applied";
      readonly runId: string;
      readonly runDir: string;
      readonly proposal: TriageProposal;
      readonly appliedDecisions: readonly string[];
      readonly skippedDecisions: readonly {
        readonly taskId: string;
        readonly reason: SkippedTriageDecisionReason;
      }[];
      readonly dependencies: readonly {
        readonly dependentId: string;
        readonly blockerId: string;
      }[];
    }
  | {
      readonly outcome: "cancelled";
      readonly runId: string;
      readonly runDir: string;
      readonly phase: "approval" | "refinement";
    }
  | {
      readonly outcome: "failed";
      readonly runId: string;
      readonly runDir: string;
      readonly reason: string;
    };

export interface RunTriageProposalFlowInput {
  readonly cwd: string;
  readonly query?: string;
  readonly taskIds?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly hubProjectDir?: string;
  readonly yes?: boolean;
  readonly interaction?: ProposalSessionInteraction<TriageProposal>;
  readonly refinements?: readonly string[];
  readonly approve?: boolean;
  readonly hubAgentConfig?: HubAgentConfig;
  readonly configureHubAgentRole?: HubAgentRoleConfigurator;
  readonly isTTY?: boolean;
  readonly agentInvoker?: ProposalAgentInvoker;
  readonly onProposalReady?: (proposal: TriageProposal) => Promise<void>;
  readonly applyConfirmation?: (
    decision: TriageProposalDecision,
    reason: TriageConfirmationReason,
  ) => Promise<boolean>;
}

const toFailedFlowResult = (
  session: RunProposalSessionResult<TriageProposal>,
  reason: string,
): RunTriageProposalFlowResult => ({
  outcome: "failed",
  runId: session.runId,
  runDir: session.runDir,
  reason,
});

const resolveDecisionsToApply = async (
  proposal: TriageProposal,
  input: RunTriageProposalFlowInput,
): Promise<{
  readonly decisionsToApply: Set<string>;
  readonly skippedDecisions: {
    readonly taskId: string;
    readonly reason: SkippedTriageDecisionReason;
  }[];
}> => {
  const decisionsToApply = new Set<string>();
  const skippedDecisions: {
    taskId: string;
    reason: SkippedTriageDecisionReason;
  }[] = [];

  for (const decision of proposal.decisions) {
    const classification = classifyTriageDecisionAutoApply(decision);
    if (classification === "auto") {
      decisionsToApply.add(decision.taskId);
      continue;
    }

    const reason = triageDecisionConfirmationReason(decision);
    if (!input.applyConfirmation) {
      skippedDecisions.push({
        taskId: decision.taskId,
        reason: input.yes ? "unconfirmed" : "non_tty_skipped",
      });
      continue;
    }

    const confirmed = await input.applyConfirmation(decision, reason);
    if (confirmed) {
      decisionsToApply.add(decision.taskId);
    } else {
      skippedDecisions.push({
        taskId: decision.taskId,
        reason: "user_rejected",
      });
    }
  }

  return { decisionsToApply, skippedDecisions };
};

export const runTriageProposalFlow = async (
  input: RunTriageProposalFlowInput,
): Promise<RunTriageProposalFlowResult> => {
  const env = input.env ?? process.env;
  const preparedContext = prepareTriageContext({
    cwd: input.cwd,
    query: input.query,
    taskIds: input.taskIds,
    env,
  });

  if (preparedContext.taskCount === 0) {
    throw new TaskBoardError({
      message: `No tasks matched triage selection "${preparedContext.taskQuery}".`,
    });
  }

  const draftPromptTemplate = readHubFlowPrompt("triage", "draft");
  const draftPrompt = substituteTriageDraftPrompt(
    draftPromptTemplate,
    preparedContext,
  );

  const hubAgentConfig =
    input.hubAgentConfig ??
    (await ensureHubAgentRolesConfigured({
      requiredRoles: ["triage"],
      env: input.env,
      yes: input.yes,
      isTTY: input.isTTY,
      configureRole: input.configureHubAgentRole,
    }));
  const triageRole = hubAgentConfig.roles.triage;
  if (!triageRole) {
    throw new Error("Missing Hub triage agent role configuration.");
  }

  const agentInvoker =
    input.agentInvoker ??
    createHubProposalAgentInvoker({
      cwd: input.cwd,
      roleEntry: triageRole,
      env: input.env,
    });

  const session = await runProposalSession({
    flowId: "triage",
    cwd: input.cwd,
    hubProjectDir: input.hubProjectDir,
    env: input.env,
    preparedContext: preparedContext as unknown as Readonly<
      Record<string, unknown>
    >,
    draftPrompt,
    finalizationPrompt: readHubFlowPrompt("triage", "finalization"),
    output: triageProposalOutput(),
    agentInvoker,
    interaction: input.interaction,
    refinements: input.refinements,
    approve: resolveProposalSessionApproval(input),
    oneShot: input.yes,
  });

  if (session.outcome === "cancelled") {
    return {
      outcome: "cancelled",
      runId: session.runId,
      runDir: session.runDir,
      phase: session.phase,
    };
  }

  if (session.outcome === "failed") {
    return toFailedFlowResult(session, session.reason);
  }

  const proposal = session.finalProposal;
  await input.onProposalReady?.(proposal);

  const knownTaskIds = new Set(
    preparedContext.tasksUnderTriage.map((task) => task.id),
  );
  const board = loadHubTaskBoard(input.cwd, env);

  try {
    validateTriageProposal(proposal, {
      knownTaskIds,
      boardTaskIds: board.tasks.map((task) => task.id),
      requiredTaskIds: knownTaskIds,
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Invalid triage proposal.";
    writeProposalSessionApplyResult(session.runDir, {
      status: "validation_failed",
      reason,
    });
    return toFailedFlowResult(session, reason);
  }

  const { decisionsToApply, skippedDecisions } = await resolveDecisionsToApply(
    proposal,
    input,
  );

  const applied = applyTriageProposal({
    cwd: input.cwd,
    proposal,
    decisionsToApply,
    proposalRunId: session.runId,
    env: input.env,
  });

  writeProposalSessionApplyResult(session.runDir, {
    status: "applied",
    appliedDecisionIds: applied.appliedDecisions,
    skippedDecisions,
    dependencyCount: applied.dependencies.length,
  });

  return {
    outcome: "applied",
    runId: session.runId,
    runDir: session.runDir,
    proposal,
    appliedDecisions: applied.appliedDecisions,
    skippedDecisions,
    dependencies: applied.dependencies,
  };
};

export const isTriageTaskIdInput = (value: string): boolean =>
  TASK_ID_PATTERN.test(value.trim());
