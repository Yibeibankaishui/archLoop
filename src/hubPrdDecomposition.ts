import type { StandardSchemaV1 } from "@standard-schema/spec";

import { Output } from "./Output.js";
import type { ValidatedPrdFileFlowInput } from "./hubFlowInput.js";
import { mapFromPrdArgToFlowInput } from "./hubFlowInput.js";
import { createHubProposalAgentInvoker } from "./hubProposalAgent.js";
import {
  ensureHubAgentRolesConfigured,
  type HubAgentConfig,
  type HubAgentRoleConfigurator,
} from "./hubAgentConfig.js";
import { readHubFlowPrompt } from "./hubFlows.js";
import {
  runProposalSession,
  writeProposalSessionApplyResult,
  type ProposalAgentInvoker,
  type ProposalSessionInteraction,
  type RunProposalSessionResult,
} from "./hubProposalSession.js";
import {
  addHubTaskDependency,
  createHubTask,
  loadHubTaskBoard,
  type CreateHubTaskResult,
} from "./taskBoard.js";
import {
  extractPrdTitle,
  mapSliceTypeToReadyHubStatus,
} from "./prdDecomposition.js";

export type PrdSliceType = "AFK" | "HITL";
export type PrdWarningSeverity = "low" | "medium" | "high";
export type PrdHubStatusMode = "inbox" | "classified_ready";

export interface PrdProposalWarning {
  readonly tempId: string;
  readonly severity: PrdWarningSeverity;
  readonly message: string;
}

export interface PrdProposalSlice {
  readonly tempId: string;
  readonly title: string;
  readonly description: string;
  readonly sliceType: PrdSliceType;
  readonly acceptanceCriteria: readonly string[];
  readonly userStoriesCovered?: readonly string[];
  readonly rationale: string;
}

export interface PrdProposalDependency {
  readonly dependentTempId: string;
  readonly blockerTempId: string;
}

export interface PrdDecompositionProposal {
  readonly prdRef: string;
  readonly prdTitle: string;
  readonly summary: string;
  readonly slices: readonly PrdProposalSlice[];
  readonly dependencies: readonly PrdProposalDependency[];
  readonly warnings: readonly PrdProposalWarning[];
}

export interface ValidatePrdDecompositionProposalOptions {
  readonly unattendedReadyStates?: boolean;
}

export interface ApplyPrdDecompositionProposalInput {
  readonly cwd: string;
  readonly proposal: PrdDecompositionProposal;
  readonly hubStatusMode: PrdHubStatusMode;
  readonly proposalRunId: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ApplyPrdDecompositionProposalResult {
  readonly tasks: readonly CreateHubTaskResult[];
  readonly dependencies: readonly {
    readonly dependentId: string;
    readonly blockerId: string;
  }[];
}

const collectDuplicateTempIds = (
  slices: readonly PrdProposalSlice[],
): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const slice of slices) {
    if (seen.has(slice.tempId)) {
      duplicates.add(slice.tempId);
    }
    seen.add(slice.tempId);
  }
  return [...duplicates];
};

const collectUnknownTempIds = (
  proposal: PrdDecompositionProposal,
): string[] => {
  const knownTempIds = new Set(proposal.slices.map((slice) => slice.tempId));
  const unknown = new Set<string>();

  for (const dependency of proposal.dependencies) {
    if (!knownTempIds.has(dependency.dependentTempId)) {
      unknown.add(dependency.dependentTempId);
    }
    if (!knownTempIds.has(dependency.blockerTempId)) {
      unknown.add(dependency.blockerTempId);
    }
  }

  for (const warning of proposal.warnings) {
    if (!knownTempIds.has(warning.tempId)) {
      unknown.add(warning.tempId);
    }
  }

  return [...unknown];
};

const detectDependencyCycles = (
  slices: readonly PrdProposalSlice[],
  dependencies: readonly PrdProposalDependency[],
): string[] => {
  const graph = new Map<string, string[]>();
  for (const slice of slices) {
    graph.set(slice.tempId, []);
  }
  for (const dependency of dependencies) {
    if (dependency.dependentTempId === dependency.blockerTempId) {
      return [dependency.dependentTempId];
    }
    graph.get(dependency.dependentTempId)?.push(dependency.blockerTempId);
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

const hasHighSeverityWarnings = (
  warnings: readonly PrdProposalWarning[],
): boolean => warnings.some((warning) => warning.severity === "high");

export const validatePrdDecompositionProposal = (
  proposal: PrdDecompositionProposal,
  options: ValidatePrdDecompositionProposalOptions = {},
): void => {
  if (proposal.slices.length === 0) {
    throw new Error(
      "PRD decomposition proposal must include at least one slice.",
    );
  }

  for (const [index, slice] of proposal.slices.entries()) {
    if (slice.acceptanceCriteria.length === 0) {
      throw new Error(
        `slices[${index}].acceptanceCriteria must be a non-empty array.`,
      );
    }
    if (slice.sliceType !== "AFK" && slice.sliceType !== "HITL") {
      throw new Error(`slices[${index}].sliceType must be AFK or HITL.`);
    }
  }

  const duplicateTempIds = collectDuplicateTempIds(proposal.slices);
  if (duplicateTempIds.length > 0) {
    throw new Error(
      `Duplicate slice temp ids: ${duplicateTempIds.join(", ")}.`,
    );
  }

  const unknownTempIds = collectUnknownTempIds(proposal);
  if (unknownTempIds.length > 0) {
    throw new Error(
      `PRD decomposition proposal references unknown temp ids: ${unknownTempIds.join(", ")}.`,
    );
  }

  const cycles = detectDependencyCycles(proposal.slices, proposal.dependencies);
  if (cycles.length > 0) {
    throw new Error(
      `PRD decomposition proposal contains dependency cycles involving: ${cycles.join(", ")}.`,
    );
  }

  if (
    options.unattendedReadyStates &&
    hasHighSeverityWarnings(proposal.warnings)
  ) {
    throw new Error(
      "High-severity PRD warnings block unattended ready-state creation.",
    );
  }
};

const formatPrdSliceDescription = (input: {
  readonly slice: PrdProposalSlice;
  readonly proposal: PrdDecompositionProposal;
  readonly proposalRunId: string;
}): string => {
  const acceptanceLines = input.slice.acceptanceCriteria.map(
    (criterion) => `- ${criterion}`,
  );
  const prdOriginLines = [
    `- PRD: ${input.proposal.prdTitle}`,
    `- Reference: ${input.proposal.prdRef}`,
    `- Proposal run: ${input.proposalRunId}`,
  ];
  if (
    input.slice.userStoriesCovered &&
    input.slice.userStoriesCovered.length > 0
  ) {
    prdOriginLines.push(
      `- User stories: ${input.slice.userStoriesCovered.join(", ")}`,
    );
  }

  return [
    input.slice.description,
    "",
    "## Acceptance criteria",
    ...acceptanceLines,
    "",
    "## PRD origin",
    ...prdOriginLines,
    "",
    "## Slice rationale",
    input.slice.rationale,
  ].join("\n");
};

const resolveSliceHubStatus = (
  slice: PrdProposalSlice,
  hubStatusMode: PrdHubStatusMode,
): "inbox" | "ready_for_agent" | "ready_for_human" => {
  if (hubStatusMode === "inbox") {
    return "inbox";
  }

  return mapSliceTypeToReadyHubStatus(slice.sliceType);
};

export const applyPrdDecompositionProposal = (
  input: ApplyPrdDecompositionProposalInput,
): ApplyPrdDecompositionProposalResult => {
  validatePrdDecompositionProposal(input.proposal, {
    unattendedReadyStates: input.hubStatusMode === "classified_ready",
  });

  const tasks = input.proposal.slices.map((slice) =>
    createHubTask(
      input.cwd,
      {
        title: slice.title,
        description: formatPrdSliceDescription({
          slice,
          proposal: input.proposal,
          proposalRunId: input.proposalRunId,
        }),
        origin: "prd-decomposition",
        sliceType: slice.sliceType,
        prdRef: input.proposal.prdRef,
        proposalRunId: input.proposalRunId,
        hubStatus: resolveSliceHubStatus(slice, input.hubStatusMode),
      },
      input.env,
    ),
  );

  const tempIdToTaskId = new Map<string, string>();
  for (const [index, slice] of input.proposal.slices.entries()) {
    const task = tasks[index];
    if (task) {
      tempIdToTaskId.set(slice.tempId, task.id);
    }
  }

  const dependencies: {
    dependentId: string;
    blockerId: string;
  }[] = [];
  for (const dependency of input.proposal.dependencies) {
    const dependentId = tempIdToTaskId.get(dependency.dependentTempId);
    const blockerId = tempIdToTaskId.get(dependency.blockerTempId);
    if (!dependentId || !blockerId) {
      continue;
    }

    addHubTaskDependency(input.cwd, dependentId, blockerId, input.env);
    dependencies.push({ dependentId, blockerId });
  }

  return { tasks, dependencies };
};

const PRD_DECOMPOSITION_OUTPUT_TAG = "prd-decomposition-proposal";
const SLICE_TYPE_SET = new Set<PrdSliceType>(["AFK", "HITL"]);
const WARNING_SEVERITY_SET = new Set<PrdWarningSeverity>([
  "low",
  "medium",
  "high",
]);

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

const readStringArray = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }

  return value.map((entry, index) =>
    readNonEmptyString(entry, `${label}[${index}]`),
  );
};

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
  if (value.length === 0) {
    return [];
  }
  return value.map((entry, index) =>
    readNonEmptyString(entry, `${label}[${index}]`),
  );
};

const assertSliceType = (value: unknown, label: string): PrdSliceType => {
  const normalized = readNonEmptyString(value, label);
  if (!SLICE_TYPE_SET.has(normalized as PrdSliceType)) {
    throw new Error(`${label} must be AFK or HITL.`);
  }
  return normalized as PrdSliceType;
};

const assertWarningSeverity = (
  value: unknown,
  label: string,
): PrdWarningSeverity => {
  const normalized = readNonEmptyString(value, label);
  if (!WARNING_SEVERITY_SET.has(normalized as PrdWarningSeverity)) {
    throw new Error(`${label} must be low, medium, or high.`);
  }
  return normalized as PrdWarningSeverity;
};

const parseProposalSlice = (
  value: unknown,
  index: number,
): PrdProposalSlice => {
  const record = readRecord(value, `slices[${index}]`);
  return {
    tempId: readNonEmptyString(record.tempId, `slices[${index}].tempId`),
    title: readNonEmptyString(record.title, `slices[${index}].title`),
    description: readNonEmptyString(
      record.description,
      `slices[${index}].description`,
    ),
    sliceType: assertSliceType(record.sliceType, `slices[${index}].sliceType`),
    acceptanceCriteria: readStringArray(
      record.acceptanceCriteria,
      `slices[${index}].acceptanceCriteria`,
    ),
    userStoriesCovered: readOptionalStringArray(
      record.userStoriesCovered,
      `slices[${index}].userStoriesCovered`,
    ),
    rationale: readNonEmptyString(
      record.rationale,
      `slices[${index}].rationale`,
    ),
  };
};

const parseProposalDependency = (
  value: unknown,
  index: number,
): PrdProposalDependency => {
  const record = readRecord(value, `dependencies[${index}]`);
  return {
    dependentTempId: readNonEmptyString(
      record.dependentTempId,
      `dependencies[${index}].dependentTempId`,
    ),
    blockerTempId: readNonEmptyString(
      record.blockerTempId,
      `dependencies[${index}].blockerTempId`,
    ),
  };
};

const parseProposalWarning = (
  value: unknown,
  index: number,
): PrdProposalWarning => {
  const record = readRecord(value, `warnings[${index}]`);
  return {
    tempId: readNonEmptyString(record.tempId, `warnings[${index}].tempId`),
    severity: assertWarningSeverity(
      record.severity,
      `warnings[${index}].severity`,
    ),
    message: readNonEmptyString(record.message, `warnings[${index}].message`),
  };
};

const parsePrdDecompositionProposal = (
  value: unknown,
): PrdDecompositionProposal => {
  const record = readRecord(value, "PRD decomposition proposal");
  const slices = Array.isArray(record.slices)
    ? record.slices.map((slice, index) => parseProposalSlice(slice, index))
    : [];
  const dependencies = Array.isArray(record.dependencies)
    ? record.dependencies.map((dependency, index) =>
        parseProposalDependency(dependency, index),
      )
    : [];
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.map((warning, index) =>
        parseProposalWarning(warning, index),
      )
    : [];

  return {
    prdRef: readNonEmptyString(record.prdRef, "prdRef"),
    prdTitle: readNonEmptyString(record.prdTitle, "prdTitle"),
    summary: readNonEmptyString(record.summary, "summary"),
    slices,
    dependencies,
    warnings,
  };
};

const prdDecompositionProposalSchema = (): StandardSchemaV1<
  unknown,
  PrdDecompositionProposal
> => ({
  "~standard": {
    version: 1,
    vendor: "sandcastle",
    validate: (value: unknown) => {
      try {
        return { value: parsePrdDecompositionProposal(value) };
      } catch (error) {
        return {
          issues: [{ message: toErrorMessage(error) }],
        };
      }
    },
  },
});

export const prdDecompositionProposalOutput = () =>
  Output.object({
    tag: PRD_DECOMPOSITION_OUTPUT_TAG,
    schema: prdDecompositionProposalSchema(),
  });

export interface PrdDecompositionPreparedContext {
  readonly prdRef: string;
  readonly prdPath: string;
  readonly prdTitle: string;
  readonly prdContent: string;
  readonly hubTaskSummary: {
    readonly totalTasks: number;
    readonly inboxCount: number;
    readonly needsInfoCount: number;
  };
}

const formatHubTaskSummaryText = (
  summary: PrdDecompositionPreparedContext["hubTaskSummary"],
): string =>
  [
    `Total tasks: ${summary.totalTasks}`,
    `Inbox: ${summary.inboxCount}`,
    `Needs info: ${summary.needsInfoCount}`,
  ].join("\n");

export const preparePrdDecompositionContext = (
  validatedInput: ValidatedPrdFileFlowInput,
  cwd: string,
): PrdDecompositionPreparedContext => {
  const board = loadHubTaskBoard(cwd);
  const inboxCount =
    board.groups.find((group) => group.status === "inbox")?.tasks.length ?? 0;
  const needsInfoCount =
    board.groups.find((group) => group.status === "needs_info")?.tasks.length ??
    0;

  return {
    prdRef: validatedInput.ref,
    prdPath: validatedInput.path,
    prdTitle: extractPrdTitle(validatedInput.content),
    prdContent: validatedInput.content,
    hubTaskSummary: {
      totalTasks: board.tasks.length,
      inboxCount,
      needsInfoCount,
    },
  };
};

export const substitutePrdDecompositionDraftPrompt = (
  template: string,
  context: PrdDecompositionPreparedContext,
): string =>
  template
    .replaceAll("{{PRD_REF}}", context.prdRef)
    .replaceAll("{{PRD_TITLE}}", context.prdTitle)
    .replaceAll(
      "{{HUB_TASK_SUMMARY}}",
      formatHubTaskSummaryText(context.hubTaskSummary),
    )
    .replaceAll("{{PRD_CONTENT}}", context.prdContent);

export const formatPrdDecompositionProposalLines = (
  proposal: PrdDecompositionProposal,
): readonly string[] => {
  const lines = [
    `PRD: ${proposal.prdTitle}`,
    `Reference: ${proposal.prdRef}`,
    `Summary: ${proposal.summary}`,
    `Proposed vertical slices: ${proposal.slices.length}`,
  ];

  if (proposal.slices.length === 0) {
    return lines;
  }

  lines.push("");
  for (const [index, slice] of proposal.slices.entries()) {
    lines.push(
      `${index + 1}. [${slice.tempId}] ${slice.title} (${slice.sliceType})`,
    );
    lines.push(`   ${slice.description}`);
    lines.push(`   Rationale: ${slice.rationale}`);
    lines.push("   Acceptance criteria:");
    for (const criterion of slice.acceptanceCriteria) {
      lines.push(`     - ${criterion}`);
    }
    if (slice.userStoriesCovered && slice.userStoriesCovered.length > 0) {
      lines.push(`   User stories: ${slice.userStoriesCovered.join(", ")}`);
    }
  }

  if (proposal.dependencies.length > 0) {
    lines.push("");
    lines.push("Dependencies:");
    for (const dependency of proposal.dependencies) {
      lines.push(
        `  - ${dependency.dependentTempId} depends on ${dependency.blockerTempId}`,
      );
    }
  }

  if (proposal.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of proposal.warnings) {
      lines.push(
        `  - [${warning.severity}] ${warning.tempId}: ${warning.message}`,
      );
    }
  }

  return lines;
};

export const parsePrdProposalDependencyOverride = (
  spec: string,
  proposal: PrdDecompositionProposal,
): readonly PrdProposalDependency[] => {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return proposal.dependencies;
  }

  const dependencies: PrdProposalDependency[] = [];
  for (const entry of trimmed.split(",")) {
    const normalizedEntry = entry.trim();
    const match = normalizedEntry.match(/^(\d+)\s*:\s*(\d+)$/);
    if (!match) {
      throw new Error(
        `Invalid dependency pair "${normalizedEntry}". Use childIndex:parentIndex, e.g. 2:1.`,
      );
    }

    const dependentIndex = Number(match[1]) - 1;
    const blockerIndex = Number(match[2]) - 1;
    const dependent = proposal.slices[dependentIndex];
    const blocker = proposal.slices[blockerIndex];
    if (!dependent || !blocker) {
      throw new Error(
        `Dependency pair "${normalizedEntry}" is out of range for ${proposal.slices.length} proposed slices.`,
      );
    }
    if (dependent.tempId === blocker.tempId) {
      throw new Error(
        `Dependency pair "${normalizedEntry}" cannot reference the same slice.`,
      );
    }

    dependencies.push({
      dependentTempId: dependent.tempId,
      blockerTempId: blocker.tempId,
    });
  }

  return dependencies;
};

export type RunPrdDecompositionFlowResult =
  | {
      readonly outcome: "applied";
      readonly runId: string;
      readonly runDir: string;
      readonly hubStatusMode: PrdHubStatusMode;
      readonly proposal: PrdDecompositionProposal;
      readonly tasks: readonly CreateHubTaskResult[];
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

export interface RunPrdDecompositionFlowInput {
  readonly cwd: string;
  readonly prdRef: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly hubProjectDir?: string;
  readonly yes?: boolean;
  readonly hubStatusMode?: PrdHubStatusMode;
  readonly resolveHubStatusMode?: () => Promise<PrdHubStatusMode>;
  readonly dependencyOverride?: string;
  readonly agentInvoker?: ProposalAgentInvoker;
  readonly interaction?: ProposalSessionInteraction;
  readonly refinements?: readonly string[];
  readonly approve?: boolean;
  readonly hubAgentConfig?: HubAgentConfig;
  readonly configureHubAgentRole?: HubAgentRoleConfigurator;
  readonly isTTY?: boolean;
}

const determineHubStatusMode = async (
  input: RunPrdDecompositionFlowInput,
): Promise<PrdHubStatusMode> => {
  if (input.yes) {
    return "inbox";
  }
  if (input.hubStatusMode) {
    return input.hubStatusMode;
  }
  if (input.resolveHubStatusMode) {
    return input.resolveHubStatusMode();
  }
  return "inbox";
};

const resolveProposalDependencies = (
  proposal: PrdDecompositionProposal,
  dependencyOverride?: string,
): PrdDecompositionProposal => {
  if (!dependencyOverride?.trim()) {
    return proposal;
  }

  return {
    ...proposal,
    dependencies: parsePrdProposalDependencyOverride(
      dependencyOverride,
      proposal,
    ),
  };
};

const toFailedFlowResult = (
  session: RunProposalSessionResult<PrdDecompositionProposal>,
  reason: string,
): RunPrdDecompositionFlowResult => ({
  outcome: "failed",
  runId: session.runId,
  runDir: session.runDir,
  reason,
});

export const runPrdDecompositionFlow = async (
  input: RunPrdDecompositionFlowInput,
): Promise<RunPrdDecompositionFlowResult> => {
  const validatedInput = mapFromPrdArgToFlowInput(input.cwd, input.prdRef);
  const preparedContext = preparePrdDecompositionContext(
    validatedInput,
    input.cwd,
  );
  const draftPromptTemplate = readHubFlowPrompt("prd-decomposition", "draft");
  const draftPrompt = substitutePrdDecompositionDraftPrompt(
    draftPromptTemplate,
    preparedContext,
  );

  const hubAgentConfig =
    input.hubAgentConfig ??
    (await ensureHubAgentRolesConfigured({
      requiredRoles: ["planning"],
      env: input.env,
      yes: input.yes,
      isTTY: input.isTTY,
      configureRole: input.configureHubAgentRole,
    }));
  const planningRole = hubAgentConfig.roles.planning;
  if (!planningRole) {
    throw new Error("Missing Hub planning agent role configuration.");
  }

  const agentInvoker =
    input.agentInvoker ??
    createHubProposalAgentInvoker({
      cwd: input.cwd,
      roleEntry: planningRole,
      env: input.env,
    });

  const session = await runProposalSession({
    flowId: "prd-decomposition",
    cwd: input.cwd,
    hubProjectDir: input.hubProjectDir,
    env: input.env,
    preparedContext: preparedContext as unknown as Readonly<
      Record<string, unknown>
    >,
    draftPrompt,
    finalizationPrompt: readHubFlowPrompt("prd-decomposition", "finalization"),
    output: prdDecompositionProposalOutput(),
    agentInvoker,
    interaction: input.interaction,
    refinements: input.refinements,
    approve: input.approve ?? input.yes,
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

  const hubStatusMode = await determineHubStatusMode(input);
  const proposal = resolveProposalDependencies(
    session.finalProposal,
    input.dependencyOverride,
  );

  try {
    validatePrdDecompositionProposal(proposal, {
      unattendedReadyStates: hubStatusMode === "classified_ready",
    });
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : "Invalid PRD decomposition proposal.";
    writeProposalSessionApplyResult(session.runDir, {
      status: "validation_failed",
      reason,
    });
    return toFailedFlowResult(session, reason);
  }

  const applied = applyPrdDecompositionProposal({
    cwd: input.cwd,
    proposal,
    hubStatusMode,
    proposalRunId: session.runId,
    env: input.env,
  });

  writeProposalSessionApplyResult(session.runDir, {
    status: "applied",
    hubStatusMode,
    taskIds: applied.tasks.map((task) => task.id),
    dependencyCount: applied.dependencies.length,
  });

  return {
    outcome: "applied",
    runId: session.runId,
    runDir: session.runDir,
    hubStatusMode,
    proposal,
    tasks: applied.tasks,
    dependencies: applied.dependencies,
  };
};
