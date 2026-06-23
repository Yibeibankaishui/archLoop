export interface PrdProposalWarning {
  readonly tempId: string;
  readonly severity: "low" | "medium" | "high";
  readonly message: string;
}

export interface PrdProposalSlice {
  readonly tempId: string;
  readonly title: string;
  readonly description: string;
  readonly sliceType: "AFK" | "HITL";
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

export type HubTriageOutcome =
  | "needs_info"
  | "ready_for_agent"
  | "ready_for_human"
  | "wontfix";

export type TriageConfidence = "low" | "medium" | "high";

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

export interface ValidateTriageProposalOptions {
  readonly knownTaskIds: ReadonlySet<string> | readonly string[];
  readonly boardTaskIds?: readonly string[];
  readonly requiredTaskIds?: ReadonlySet<string> | readonly string[];
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

const detectPrdDependencyCycles = (
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

const toKnownTaskIdSet = (
  knownTaskIds: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> =>
  knownTaskIds instanceof Set ? knownTaskIds : new Set(knownTaskIds);

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

const detectTriageDependencyCycles = (
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

  const cycles = detectPrdDependencyCycles(
    proposal.slices,
    proposal.dependencies,
  );
  if (cycles.length > 0) {
    throw new Error(
      `PRD decomposition proposal contains dependency cycles involving: ${cycles.join(", ")}.`,
    );
  }

  if (
    options.unattendedReadyStates &&
    hasHighSeverityWarnings(proposal.warnings)
  ) {
    const highWarnings = proposal.warnings.filter(
      (warning) => warning.severity === "high",
    );
    const lines = [
      "High-severity warnings block unattended ready-state creation:",
      "",
    ];
    for (const warning of highWarnings) {
      lines.push(`  [high] ${warning.tempId}: ${warning.message}`);
    }
    lines.push(
      "",
      "Try:",
      "  · archloop tasks from-prd <prd> --status inbox",
      "  · or refine the decomposition to resolve these warnings",
    );
    throw new Error(lines.join("\n"));
  }
};

export const validateTriageProposal = (
  proposal: TriageProposal,
  options: ValidateTriageProposalOptions,
): void => {
  if (proposal.decisions.length === 0) {
    throw new Error("Triage proposal must include at least one decision.");
  }

  const knownTaskIds = toKnownTaskIdSet(options.knownTaskIds);

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
  const cycles = detectTriageDependencyCycles(edges);
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
