import { HUB_DESKTOP_LAYOUT } from "./hubDesktopShell.js";
import type {
  HubRunEventRecord,
  HubRuntimePreviewAction,
} from "./hubRuntimeBridge.js";
import {
  validatePrdDecompositionProposal,
  type PrdDecompositionProposal,
  type PrdProposalSlice,
  validateTriageProposal,
  type TriageProposal,
  type TriageProposalDecision,
} from "./hubProposalValidation.js";
import { resolveProposalSessionArtifactPaths } from "./hubProposalArtifactPaths.js";
import type { ProposalTranscriptTurn } from "./hubProposalSession.js";
import { mapSliceTypeToReadyHubStatus } from "./prdModel.js";
import type {
  HubProjectRunSummary,
  HubProjectStatus,
} from "./projectStatus.js";
import { HUB_TASK_STORE_INIT_COMMAND } from "./hubTaskStoreCommands.js";

export type HubProposalWorkbenchPhase =
  | "loading"
  | "runtime_unavailable"
  | "empty"
  | "ready";

export type HubProposalFlowId = "prd-decomposition" | "triage";

export type HubProposalSessionStatus =
  | "drafting"
  | "refining"
  | "awaiting_approval"
  | "approved_pending_apply"
  | "applied"
  | "validation_failed"
  | "blocked_mutations"
  | "cancelled"
  | "failed";

export type HubProposalValidationKind =
  | "missing_acceptance_criteria"
  | "invalid_dependencies"
  | "guarded_decision"
  | "schema_mismatch"
  | "mutation_detection_failure";

export type HubProposalActionKind = "bridge_preview" | "cli_only";

export interface HubProposalValidationError {
  readonly kind: HubProposalValidationKind;
  readonly message: string;
  readonly taskRef?: string;
}

export interface HubProposalTaskCard {
  readonly id: string;
  readonly title: string;
  readonly intendedHubStatus?: string;
  readonly classification?: "AFK" | "HITL";
  readonly dependencies: readonly string[];
  readonly validationState: "valid" | "warning" | "error";
  readonly warnings: readonly string[];
  readonly confidence?: "low" | "medium" | "high";
  readonly rationale?: string;
}

export interface HubProposalSessionOption {
  readonly runId: string;
  readonly runDir: string;
  readonly label: string;
  readonly active: boolean;
}

export interface HubProposalSessionMetadata {
  readonly runId: string;
  readonly runDir: string;
  readonly flowId: HubProposalFlowId;
  readonly branch?: string;
  readonly proposalStatus: HubProposalSessionStatus;
  readonly confidenceSummary?: string;
  readonly agentRationale?: string;
  readonly worktreeLeaseSummary: string;
  readonly localWriteSummary: string;
  readonly agentLogPath: string;
  readonly artifactPaths: readonly {
    readonly label: string;
    readonly path: string;
  }[];
}

export interface HubProposalSourceContext {
  readonly title: string;
  readonly summary?: string;
  readonly highlights: readonly string[];
  readonly extractedRequirementText?: string;
  readonly requirements: readonly string[];
  readonly transcriptExcerpt: readonly {
    readonly role: string;
    readonly content: string;
  }[];
}

export interface HubProposalApplyState {
  readonly status:
    | "none"
    | "pending"
    | "applied"
    | "validation_failed"
    | "blocked_mutations";
  readonly message: string;
  readonly nextStep: string;
  readonly artifactReferences: readonly string[];
}

export interface HubProposalWorkbenchAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: HubProposalActionKind;
  readonly bridgeAction?: HubRuntimePreviewAction;
  readonly bridgeParams?: Record<string, unknown>;
  readonly cliFallback: string;
  readonly disabledReason?: string;
}

export interface ProposalSessionArtifactsSnapshot {
  readonly preparedContext: Readonly<Record<string, unknown>>;
  readonly transcript: readonly ProposalTranscriptTurn[];
  readonly finalProposal?: unknown;
  readonly applyResult?: Readonly<Record<string, unknown>>;
}

export interface HubProposalWorkbenchModel {
  readonly phase: HubProposalWorkbenchPhase;
  readonly runtimeError?: string;
  readonly cliFallback?: string;
  readonly localWriteCopy: string;
  readonly remoteSyncCopy: string;
  readonly selectedRunDir?: string;
  readonly sessionOptions: readonly HubProposalSessionOption[];
  readonly metadata?: HubProposalSessionMetadata;
  readonly sourceContext?: HubProposalSourceContext;
  readonly taskCards: readonly HubProposalTaskCard[];
  readonly validationErrors: readonly HubProposalValidationError[];
  readonly applyState?: HubProposalApplyState;
  readonly actions: readonly HubProposalWorkbenchAction[];
}

export interface BuildHubProposalWorkbenchModelInput {
  readonly loading?: boolean;
  readonly runtimeError?: string;
  readonly runSummaries?: readonly HubProjectRunSummary[];
  readonly selectedRunDir?: string;
  readonly sessionArtifacts?: ProposalSessionArtifactsSnapshot;
  readonly proposalEvents?: readonly HubRunEventRecord[];
  readonly projectStatus?: HubProjectStatus;
}

const PROPOSAL_CLI_FALLBACK = "archloop tasks from-prd <ref>";
const TRIAGE_CLI_FALLBACK = "archloop tasks triage <task-id>";

export const HUB_PROPOSAL_LOCAL_WRITE_COPY =
  "Apply writes new tasks to the local Beads task store only. Review here before any local mutation.";

export const HUB_PROPOSAL_REMOTE_SYNC_COPY =
  "Remote GitHub issue sync is separate. Use archloop tasks push or tasks sync after local approval and apply.";

const createEmptyProposalWorkbenchContent = (): Pick<
  HubProposalWorkbenchModel,
  "sessionOptions" | "taskCards" | "validationErrors" | "actions"
> => ({
  sessionOptions: [],
  taskCards: [],
  validationErrors: [],
  actions: [],
});

const BLOCKING_VALIDATION_KINDS: ReadonlySet<HubProposalValidationKind> =
  new Set([
    "schema_mismatch",
    "invalid_dependencies",
    "missing_acceptance_criteria",
    "mutation_detection_failure",
  ]);

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const readStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const readErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const summarizeConfidenceIndex = (input: {
  readonly validationErrors: readonly HubProposalValidationError[];
  readonly taskCards: readonly HubProposalTaskCard[];
  readonly applyState?: HubProposalApplyState;
}): string => {
  const warningCount = input.taskCards.reduce(
    (count, card) => count + card.warnings.length,
    0,
  );
  const validationPenalty = input.validationErrors.reduce((score, error) => {
    switch (error.kind) {
      case "mutation_detection_failure":
      case "schema_mismatch":
      case "invalid_dependencies":
      case "missing_acceptance_criteria":
        return score + 18;
      default:
        return score + 8;
    }
  }, 0);
  const applyPenalty =
    input.applyState?.status === "blocked_mutations"
      ? 20
      : input.applyState?.status === "validation_failed"
        ? 12
        : 0;
  const warningPenalty = warningCount * 4;
  const score = Math.max(
    40,
    100 - validationPenalty - applyPenalty - warningPenalty,
  );
  const tone = score >= 85 ? "high" : score >= 70 ? "medium" : "low";
  return `Confidence index ${score}/100 (${tone})`;
};

const extractRequirementItems = (
  prdContent: string | undefined,
): readonly string[] => {
  if (!prdContent) {
    return [];
  }

  const items: string[] = [];
  for (const line of prdContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^(?:\d+\.|-|\*)\s+(.*)$/.exec(trimmed);
    if (!match?.[1]) {
      continue;
    }
    const requirement = match[1].replace(/^\[[ xX]\]\s+/, "").trim();
    if (requirement.length > 0) {
      items.push(requirement);
    }
  }
  return items;
};

const extractHighlightedRequirementText = (
  preparedContext: Readonly<Record<string, unknown>>,
): string | undefined => {
  const explicit = readString(preparedContext.extractedRequirementText);
  if (explicit) {
    return explicit;
  }

  const prdContent = readString(preparedContext.prdContent);
  if (!prdContent) {
    return readString(preparedContext.summary);
  }

  const paragraphs = prdContent
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  for (const paragraph of paragraphs) {
    if (paragraph.startsWith("#")) {
      continue;
    }
    if (/^(?:\d+\.|-|\*)\s+/.test(paragraph)) {
      continue;
    }
    return paragraph.replace(/\s+/g, " ");
  }

  return readString(preparedContext.summary) ?? prdContent.split(/\r?\n/)[0];
};

const isPrdProposal = (value: unknown): value is PrdDecompositionProposal => {
  const record = readObject(value);
  return Array.isArray(record.slices) && typeof record.prdRef === "string";
};

const isTriageProposal = (value: unknown): value is TriageProposal => {
  const record = readObject(value);
  return Array.isArray(record.decisions) && typeof record.summary === "string";
};

export const isProposalRunSummary = (run: HubProjectRunSummary): boolean =>
  (run.branch?.startsWith("proposal/") ?? false) ||
  run.batches.some(
    (batch) =>
      batch.flowId === "prd-decomposition" || batch.flowId === "triage",
  );

export const filterProposalRunSummaries = (
  runSummaries: readonly HubProjectRunSummary[],
): readonly HubProjectRunSummary[] => runSummaries.filter(isProposalRunSummary);

export const selectDefaultProposalRunDir = (
  runSummaries: readonly HubProjectRunSummary[],
): string | undefined =>
  filterProposalRunSummaries(runSummaries).at(-1)?.runDir;

const resolveFlowId = (
  run: HubProjectRunSummary | undefined,
  preparedContext: Readonly<Record<string, unknown>>,
): HubProposalFlowId => {
  const branchFlow = run?.branch?.replace(/^proposal\//, "");
  if (branchFlow === "triage" || branchFlow === "prd-decomposition") {
    return branchFlow;
  }
  if (
    readString(preparedContext.taskQuery) ||
    preparedContext.taskCount !== undefined
  ) {
    return "triage";
  }
  return "prd-decomposition";
};

const resolveCliFallback = (flowId: HubProposalFlowId): string =>
  flowId === "triage" ? TRIAGE_CLI_FALLBACK : PROPOSAL_CLI_FALLBACK;

const hasProposalEventType = (
  events: readonly HubRunEventRecord[],
  type: string,
): boolean => events.some((record) => readObject(record.event).type === type);

const classifyValidationError = (
  message: string,
): HubProposalValidationKind => {
  const normalized = message.toLowerCase();
  if (normalized.includes("acceptance")) {
    return "missing_acceptance_criteria";
  }
  if (
    normalized.includes("dependency") ||
    normalized.includes("cycle") ||
    normalized.includes("unknown temp")
  ) {
    return "invalid_dependencies";
  }
  if (normalized.includes("severity") || normalized.includes("confidence")) {
    return "guarded_decision";
  }
  if (normalized.includes("mutation")) {
    return "mutation_detection_failure";
  }
  return "schema_mismatch";
};

const isBlockingValidationError = (
  error: HubProposalValidationError,
): boolean => BLOCKING_VALIDATION_KINDS.has(error.kind);

const indexValidationErrorsByTaskRef = (
  validationErrors: readonly HubProposalValidationError[],
): Map<string, HubProposalValidationError[]> => {
  const errorsByRef = new Map<string, HubProposalValidationError[]>();
  for (const error of validationErrors) {
    if (!error.taskRef) {
      continue;
    }
    const existing = errorsByRef.get(error.taskRef) ?? [];
    existing.push(error);
    errorsByRef.set(error.taskRef, existing);
  }
  return errorsByRef;
};

const resolveTaskCardValidationState = (
  errors: readonly HubProposalValidationError[],
  hasWarnings: boolean,
): HubProposalTaskCard["validationState"] => {
  if (errors.some((error) => error.kind !== "guarded_decision")) {
    return "error";
  }
  if (hasWarnings) {
    return "warning";
  }
  return "valid";
};

const collectPrdValidationErrors = (
  proposal: PrdDecompositionProposal,
): readonly HubProposalValidationError[] => {
  const errors: HubProposalValidationError[] = [];

  for (const [index, slice] of proposal.slices.entries()) {
    if (slice.acceptanceCriteria.length === 0) {
      errors.push({
        kind: "missing_acceptance_criteria",
        message: `slices[${index}].acceptanceCriteria must be a non-empty array.`,
        taskRef: slice.tempId,
      });
    }
  }

  const dependencyProbe: PrdDecompositionProposal = {
    ...proposal,
    slices: proposal.slices.map((slice) => ({
      ...slice,
      acceptanceCriteria:
        slice.acceptanceCriteria.length > 0
          ? slice.acceptanceCriteria
          : ["Dependency validation probe"],
    })),
  };

  try {
    validatePrdDecompositionProposal(dependencyProbe, {
      unattendedReadyStates: true,
    });
  } catch (error) {
    const message = readErrorMessage(error, "Invalid proposal");
    errors.push({
      kind: classifyValidationError(message),
      message,
    });
  }

  for (const warning of proposal.warnings) {
    if (warning.severity === "high") {
      errors.push({
        kind: "guarded_decision",
        message: warning.message,
        taskRef: warning.tempId,
      });
    }
  }

  return errors;
};

const collectTriageValidationErrors = (
  proposal: TriageProposal,
  knownTaskIds: readonly string[],
): readonly HubProposalValidationError[] => {
  const errors: HubProposalValidationError[] = [];
  try {
    validateTriageProposal(proposal, {
      knownTaskIds,
      requiredTaskIds: knownTaskIds,
    });
  } catch (error) {
    const message = readErrorMessage(error, "Invalid triage proposal");
    errors.push({
      kind: classifyValidationError(message),
      message,
    });
  }

  for (const decision of proposal.decisions) {
    if (decision.confidence === "low") {
      errors.push({
        kind: "guarded_decision",
        message: `Low-confidence triage decision for ${decision.taskId}.`,
        taskRef: decision.taskId,
      });
    }
  }

  return errors;
};

const buildPrdTaskCards = (
  proposal: PrdDecompositionProposal,
  validationErrors: readonly HubProposalValidationError[],
): readonly HubProposalTaskCard[] => {
  const errorsByRef = indexValidationErrorsByTaskRef(validationErrors);

  const blockersByDependent = new Map<string, string[]>();
  for (const dependency of proposal.dependencies) {
    const existing = blockersByDependent.get(dependency.dependentTempId) ?? [];
    existing.push(dependency.blockerTempId);
    blockersByDependent.set(dependency.dependentTempId, existing);
  }

  return proposal.slices.map((slice: PrdProposalSlice) => {
    const sliceErrors = errorsByRef.get(slice.tempId) ?? [];
    const sliceWarnings = proposal.warnings
      .filter((warning) => warning.tempId === slice.tempId)
      .map((warning) => `${warning.severity}: ${warning.message}`);

    return {
      id: slice.tempId,
      title: slice.title,
      intendedHubStatus: mapSliceTypeToReadyHubStatus(slice.sliceType),
      classification: slice.sliceType,
      dependencies: blockersByDependent.get(slice.tempId) ?? [],
      validationState: resolveTaskCardValidationState(
        sliceErrors,
        sliceWarnings.length > 0,
      ),
      warnings: sliceWarnings,
      rationale: slice.rationale,
    };
  });
};

const buildTriageTaskCards = (
  proposal: TriageProposal,
  validationErrors: readonly HubProposalValidationError[],
): readonly HubProposalTaskCard[] => {
  const errorsByRef = indexValidationErrorsByTaskRef(validationErrors);

  return proposal.decisions.map((decision: TriageProposalDecision) => {
    const sliceErrors = errorsByRef.get(decision.taskId) ?? [];
    const hasConfidenceWarning =
      decision.confidence === "medium" || decision.confidence === "low";

    return {
      id: decision.taskId,
      title: decision.category,
      intendedHubStatus: decision.outcome,
      dependencies:
        decision.dependencySuggestions?.map(
          (dependency) => dependency.blockerTaskId,
        ) ?? [],
      validationState: resolveTaskCardValidationState(
        sliceErrors,
        hasConfidenceWarning,
      ),
      warnings: decision.needsInfoQuestions ?? [],
      confidence: decision.confidence,
      rationale: decision.rationale,
    };
  });
};

const resolveProposalStatus = (input: {
  readonly sessionArtifacts?: ProposalSessionArtifactsSnapshot;
  readonly proposalEvents: readonly HubRunEventRecord[];
}): HubProposalSessionStatus => {
  const applyStatus = readString(input.sessionArtifacts?.applyResult?.status);
  if (applyStatus === "applied") {
    return "applied";
  }
  if (applyStatus === "validation_failed") {
    return "validation_failed";
  }
  if (applyStatus === "blocked_mutations") {
    return "blocked_mutations";
  }
  if (applyStatus === "pending") {
    return "approved_pending_apply";
  }
  if (hasProposalEventType(input.proposalEvents, "session_cancelled")) {
    return "cancelled";
  }
  if (
    hasProposalEventType(input.proposalEvents, "session_failed") ||
    hasProposalEventType(input.proposalEvents, "finalization_failed")
  ) {
    return "failed";
  }
  if (input.sessionArtifacts?.finalProposal) {
    return "awaiting_approval";
  }
  if (hasProposalEventType(input.proposalEvents, "refinement_requested")) {
    return "refining";
  }
  return "drafting";
};

const buildSourceContext = (
  flowId: HubProposalFlowId,
  preparedContext: Readonly<Record<string, unknown>>,
  transcript: readonly ProposalTranscriptTurn[],
): HubProposalSourceContext => {
  const highlights: string[] = [];
  if (flowId === "prd-decomposition") {
    const prdRef = readString(preparedContext.prdRef);
    const prdTitle = readString(preparedContext.prdTitle);
    if (prdRef) {
      highlights.push(`PRD reference: ${prdRef}`);
    }
    if (prdTitle) {
      highlights.push(`PRD title: ${prdTitle}`);
    }
  } else {
    const taskQuery = readString(preparedContext.taskQuery);
    const taskCount = preparedContext.taskCount;
    if (taskQuery) {
      highlights.push(`Task query: ${taskQuery}`);
    }
    if (typeof taskCount === "number") {
      highlights.push(`Tasks under triage: ${taskCount}`);
    }
  }

  const summary = readString(preparedContext.summary);
  const explicitRequirements = readStringArray(preparedContext.requirements);
  const prdContent = readString(preparedContext.prdContent);
  const requirements =
    explicitRequirements.length > 0
      ? explicitRequirements
      : flowId === "prd-decomposition"
        ? extractRequirementItems(prdContent)
        : readStringArray(preparedContext.decisionItems);
  const extractedRequirementText =
    extractHighlightedRequirementText(preparedContext);
  const title = flowId === "triage" ? "Source document" : "Source document";

  return {
    title,
    summary,
    highlights,
    extractedRequirementText,
    requirements,
    transcriptExcerpt: transcript.slice(-4).map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
  };
};

const buildApplyState = (
  sessionArtifacts: ProposalSessionArtifactsSnapshot | undefined,
  validationErrors: readonly HubProposalValidationError[],
): HubProposalApplyState | undefined => {
  const applyResult = sessionArtifacts?.applyResult;
  const status = readString(applyResult?.status);
  if (!status) {
    return validationErrors.length > 0
      ? {
          status: "none",
          message:
            "Proposal has validation issues that must be resolved before apply.",
          nextStep:
            "Revise the proposal or reject it before attempting local writes.",
          artifactReferences: [],
        }
      : undefined;
  }

  if (status === "applied") {
    const taskIds = Array.isArray(applyResult?.taskIds)
      ? applyResult.taskIds.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return {
      status: "applied",
      message: "Local Beads tasks were created from this proposal.",
      nextStep:
        "Review the new tasks on the task board. Push or sync to GitHub only when you intend remote updates.",
      artifactReferences: taskIds,
    };
  }

  if (status === "validation_failed") {
    return {
      status: "validation_failed",
      message:
        readString(applyResult?.reason) ??
        "Proposal validation failed before local apply.",
      nextStep:
        "Refine the proposal session from the CLI, then reload this run directory.",
      artifactReferences: [],
    };
  }

  if (status === "blocked_mutations") {
    return {
      status: "blocked_mutations",
      message:
        readString(applyResult?.reason) ??
        "Unexpected repo or Beads mutations were detected.",
      nextStep:
        "Inspect repo and task-store changes, then restart the proposal flow from a clean state.",
      artifactReferences: [],
    };
  }

  return {
    status: "pending",
    message: "Proposal approved. Local apply is pending.",
    nextStep:
      "Complete apply from the CLI to write local Beads tasks. Remote sync remains separate.",
    artifactReferences: [],
  };
};

const taskStoreUnavailableReason = (
  status: HubProjectStatus | undefined,
): string | undefined => {
  if (!status) {
    return undefined;
  }
  if (!status.beadsAvailable) {
    return "Beads runtime is unavailable. Install dependencies or set ARCHLOOP_BD_PATH before apply.";
  }
  if (!status.taskStoreInitialized) {
    return `Local task store is not initialized. Run ${HUB_TASK_STORE_INIT_COMMAND} first.`;
  }
  return undefined;
};

const resolveApproveDisabledReason = (input: {
  readonly proposalStatus: HubProposalSessionStatus;
  readonly hasFinalProposal: boolean;
  readonly hasBlockingValidation: boolean;
  readonly taskStoreReason?: string;
}): string | undefined => {
  if (input.proposalStatus === "applied") {
    return "Proposal is already applied to the local task store.";
  }
  if (input.proposalStatus === "cancelled") {
    return "Proposal session was cancelled.";
  }
  if (!input.hasFinalProposal) {
    return "Final proposal is not available yet.";
  }
  if (input.hasBlockingValidation) {
    return "Resolve validation errors before approval.";
  }
  if (input.taskStoreReason) {
    return input.taskStoreReason;
  }
  return undefined;
};

const buildActions = (input: {
  readonly flowId: HubProposalFlowId;
  readonly proposalStatus: HubProposalSessionStatus;
  readonly validationErrors: readonly HubProposalValidationError[];
  readonly projectStatus?: HubProjectStatus;
  readonly hasFinalProposal: boolean;
  readonly runDir: string;
}): readonly HubProposalWorkbenchAction[] => {
  const cliFallback = resolveCliFallback(input.flowId);
  const taskStoreReason = taskStoreUnavailableReason(input.projectStatus);
  const hasBlockingValidation = input.validationErrors.some(
    isBlockingValidationError,
  );
  const approveDisabled = resolveApproveDisabledReason({
    proposalStatus: input.proposalStatus,
    hasFinalProposal: input.hasFinalProposal,
    hasBlockingValidation,
    taskStoreReason,
  });
  const approveBridgeParams = {
    runDir: input.runDir,
    ...(input.projectStatus?.repoRoot
      ? { cwd: input.projectStatus.repoRoot }
      : {}),
  };

  return [
    {
      id: "approve",
      label: "Approve & Apply to Beads",
      description:
        "Preview the local Beads write, then confirm approval. Remote sync stays separate.",
      kind: "bridge_preview",
      bridgeAction: "proposal.applyPreview",
      bridgeParams: approveBridgeParams,
      cliFallback,
      disabledReason: approveDisabled,
    },
    {
      id: "reject",
      label: "Reject",
      description: "Discard the proposal without creating local tasks.",
      kind: "cli_only",
      cliFallback,
      disabledReason:
        input.proposalStatus === "applied"
          ? "Proposal is already applied to the local task store."
          : `Desktop reject is not wired in v0. Re-open the proposal session with ${cliFallback} if you need to cancel or restart.`,
    },
    {
      id: "revise",
      label: "Revise",
      description:
        "Restart or refine the proposal session with additional maintainer feedback.",
      kind: "cli_only",
      cliFallback,
      disabledReason:
        input.proposalStatus === "applied"
          ? "Applied proposals must be changed on the task board instead."
          : `Desktop revise is not wired in v0. Re-open the proposal session with ${cliFallback} to refine it in the CLI.`,
    },
  ];
};

const buildSessionOptions = (
  runSummaries: readonly HubProjectRunSummary[],
  selectedRunDir: string | undefined,
): readonly HubProposalSessionOption[] =>
  filterProposalRunSummaries(runSummaries).map((run) => ({
    runId: run.runId,
    runDir: run.runDir,
    label: `${run.runId} · ${run.branch ?? "proposal"}`,
    active: run.runDir === selectedRunDir,
  }));

const buildMetadata = (
  run: HubProjectRunSummary,
  flowId: HubProposalFlowId,
  proposalStatus: HubProposalSessionStatus,
  transcript: readonly ProposalTranscriptTurn[],
  confidenceSummary: string,
): HubProposalSessionMetadata => {
  const artifactPaths = resolveProposalSessionArtifactPaths(run.runDir);
  const latestAssistant = [...transcript]
    .reverse()
    .find((turn) => turn.role === "assistant");

  return {
    runId: run.runId,
    runDir: run.runDir,
    flowId,
    branch: run.branch,
    proposalStatus,
    confidenceSummary,
    agentRationale: latestAssistant?.content,
    worktreeLeaseSummary: `${run.branch ?? `proposal/${flowId}`} · run ${run.runId}`,
    localWriteSummary:
      "Local Beads writes only. Remote GitHub sync stays separate.",
    agentLogPath: `${run.runDir.replace(/\/$/, "")}/logs/${flowId}-finalization.log`,
    artifactPaths: [
      { label: "Prepared context", path: artifactPaths.preparedContextPath },
      { label: "Transcript", path: artifactPaths.transcriptPath },
      { label: "Final proposal", path: artifactPaths.finalProposalPath },
      { label: "Apply result", path: artifactPaths.applyResultPath },
      { label: "Proposal events", path: artifactPaths.proposalEventsPath },
    ],
  };
};

export const resolveHubProposalWorkbenchGridClass = (
  viewportWidth: number,
): string =>
  viewportWidth < HUB_DESKTOP_LAYOUT.narrowBreakpointPx
    ? "hub-proposal-grid hub-proposal-grid-narrow"
    : "hub-proposal-grid";

export const buildHubProposalWorkbenchModel = (
  input: BuildHubProposalWorkbenchModelInput,
): HubProposalWorkbenchModel => {
  const baseCopy = {
    localWriteCopy: HUB_PROPOSAL_LOCAL_WRITE_COPY,
    remoteSyncCopy: HUB_PROPOSAL_REMOTE_SYNC_COPY,
  };

  if (input.loading) {
    return {
      phase: "loading",
      ...baseCopy,
      ...createEmptyProposalWorkbenchContent(),
    };
  }

  if (input.runtimeError) {
    return {
      phase: "runtime_unavailable",
      runtimeError: input.runtimeError,
      cliFallback: PROPOSAL_CLI_FALLBACK,
      ...baseCopy,
      ...createEmptyProposalWorkbenchContent(),
    };
  }

  const runSummaries = input.runSummaries ?? [];
  const sessionOptions = buildSessionOptions(
    runSummaries,
    input.selectedRunDir,
  );
  if (sessionOptions.length === 0) {
    return {
      phase: "empty",
      cliFallback: PROPOSAL_CLI_FALLBACK,
      ...baseCopy,
      ...createEmptyProposalWorkbenchContent(),
    };
  }

  const selectedRunDir =
    input.selectedRunDir ?? selectDefaultProposalRunDir(runSummaries);
  const selectedRun = filterProposalRunSummaries(runSummaries).find(
    (run) => run.runDir === selectedRunDir,
  );
  if (!selectedRun || !input.sessionArtifacts) {
    return {
      phase: "empty",
      cliFallback: PROPOSAL_CLI_FALLBACK,
      selectedRunDir,
      ...baseCopy,
      ...createEmptyProposalWorkbenchContent(),
      sessionOptions,
    };
  }

  const proposalEvents = input.proposalEvents ?? [];
  const preparedContext = input.sessionArtifacts.preparedContext;
  const flowId = resolveFlowId(selectedRun, preparedContext);
  const proposalStatus = resolveProposalStatus({
    sessionArtifacts: input.sessionArtifacts,
    proposalEvents,
  });

  let validationErrors: readonly HubProposalValidationError[] = [];
  let taskCards: readonly HubProposalTaskCard[] = [];
  const finalProposal = input.sessionArtifacts.finalProposal;

  if (isPrdProposal(finalProposal)) {
    validationErrors = collectPrdValidationErrors(finalProposal);
    taskCards = buildPrdTaskCards(finalProposal, validationErrors);
  } else if (isTriageProposal(finalProposal)) {
    const boardIds = Array.isArray(preparedContext.boardTaskCatalog)
      ? preparedContext.boardTaskCatalog
          .map((entry) => readObject(entry).id)
          .filter((entry): entry is string => typeof entry === "string")
      : [];
    validationErrors = collectTriageValidationErrors(
      finalProposal,
      boardIds.length > 0
        ? boardIds
        : finalProposal.decisions.map((decision) => decision.taskId),
    );
    taskCards = buildTriageTaskCards(finalProposal, validationErrors);
  } else if (finalProposal !== undefined) {
    validationErrors = [
      {
        kind: "schema_mismatch",
        message:
          "Final proposal does not match a supported PRD or triage schema.",
      },
    ];
  }

  if (proposalStatus === "blocked_mutations") {
    validationErrors = [
      ...validationErrors,
      {
        kind: "mutation_detection_failure",
        message:
          readString(input.sessionArtifacts.applyResult?.reason) ??
          "Unexpected mutations were detected during the proposal session.",
      },
    ];
  }

  const applyState = buildApplyState(input.sessionArtifacts, validationErrors);
  const confidenceSummary = summarizeConfidenceIndex({
    validationErrors,
    taskCards,
    applyState,
  });
  const metadata = buildMetadata(
    selectedRun,
    flowId,
    proposalStatus,
    input.sessionArtifacts.transcript,
    confidenceSummary,
  );
  const sourceContext = buildSourceContext(
    flowId,
    preparedContext,
    input.sessionArtifacts.transcript,
  );
  const actions = buildActions({
    flowId,
    proposalStatus,
    validationErrors,
    projectStatus: input.projectStatus,
    hasFinalProposal: finalProposal !== undefined,
    runDir: selectedRun.runDir,
  });

  return {
    phase: "ready",
    selectedRunDir,
    ...baseCopy,
    sessionOptions,
    metadata,
    sourceContext,
    taskCards,
    validationErrors,
    applyState,
    actions,
    cliFallback: resolveCliFallback(flowId),
  };
};
