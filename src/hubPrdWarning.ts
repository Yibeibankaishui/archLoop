import type {
  PrdProposalWarning,
  PrdWarningSeverity,
} from "./hubPrdDecomposition.js";
import type { HubTaskProjection } from "./taskBoard.js";

export interface IndexedPrdWarning {
  readonly severity: PrdWarningSeverity;
  readonly message: string;
}

export interface PersistedPrdWarning {
  readonly sliceTempId: string;
  readonly severity: PrdWarningSeverity;
  readonly message: string;
}

export interface PrdWarningSummary {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly total: number;
}

const SEVERITY_RANK: Record<PrdWarningSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export const PRD_WARNING_LABELS: Readonly<Record<PrdWarningSeverity, string>> =
  {
    low: "prd-warning-low",
    medium: "prd-warning-medium",
    high: "prd-warning-high",
  };

export const prdWarningLabelForSeverity = (
  severity: PrdWarningSeverity,
): string => PRD_WARNING_LABELS[severity];

export const indexWarningsByTempId = (
  warnings: readonly PrdProposalWarning[],
): ReadonlyMap<string, IndexedPrdWarning> => {
  const indexed = new Map<string, IndexedPrdWarning>();

  for (const warning of warnings) {
    const existing = indexed.get(warning.tempId);
    if (
      !existing ||
      SEVERITY_RANK[warning.severity] > SEVERITY_RANK[existing.severity]
    ) {
      indexed.set(warning.tempId, {
        severity: warning.severity,
        message: warning.message,
      });
    }
  }

  return indexed;
};

export const summarizePrdWarnings = (
  warnings: readonly PrdProposalWarning[],
): PrdWarningSummary => {
  const summary = {
    high: 0,
    medium: 0,
    low: 0,
    total: warnings.length,
  };

  for (const warning of warnings) {
    summary[warning.severity] += 1;
  }

  return summary;
};

export const formatPrdWarningDescriptionSection = (
  warning: IndexedPrdWarning,
): string => `## PRD warning\n- **[${warning.severity}]** ${warning.message}`;

export const readPrdWarningFromMetadata = (
  metadata: Readonly<Record<string, unknown>>,
): PersistedPrdWarning | undefined => {
  const severity = metadata.warning_severity;
  const message = metadata.warning_message;
  const sliceTempId = metadata.slice_temp_id;

  if (
    (severity !== "low" && severity !== "medium" && severity !== "high") ||
    typeof message !== "string" ||
    message.trim().length === 0 ||
    typeof sliceTempId !== "string" ||
    sliceTempId.trim().length === 0
  ) {
    return undefined;
  }

  return {
    sliceTempId: sliceTempId.trim(),
    severity,
    message: message.trim(),
  };
};

export const readPrdWarningFromTask = (
  task: HubTaskProjection,
): PersistedPrdWarning | undefined => {
  const fromMetadata = readPrdWarningFromMetadata(task.metadata);
  if (fromMetadata) {
    return fromMetadata;
  }

  for (const label of task.labels) {
    if (label === PRD_WARNING_LABELS.high) {
      return {
        sliceTempId: String(task.metadata.slice_temp_id ?? ""),
        severity: "high",
        message: String(task.metadata.warning_message ?? "PRD warning"),
      };
    }
    if (label === PRD_WARNING_LABELS.medium) {
      return {
        sliceTempId: String(task.metadata.slice_temp_id ?? ""),
        severity: "medium",
        message: String(task.metadata.warning_message ?? "PRD warning"),
      };
    }
    if (label === PRD_WARNING_LABELS.low) {
      return {
        sliceTempId: String(task.metadata.slice_temp_id ?? ""),
        severity: "low",
        message: String(task.metadata.warning_message ?? "PRD warning"),
      };
    }
  }

  return undefined;
};

const formatWarningGroupLines = (input: {
  readonly heading: string;
  readonly warnings: readonly PrdProposalWarning[];
  readonly sliceTitleByTempId: ReadonlyMap<string, string>;
}): readonly string[] => {
  if (input.warnings.length === 0) {
    return [];
  }

  const lines = [input.heading];
  for (const warning of input.warnings) {
    const title = input.sliceTitleByTempId.get(warning.tempId);
    const titleSuffix = title ? `  ${title}` : "";
    lines.push(
      `  · [${warning.severity}] ${warning.tempId}${titleSuffix}`,
      `    ${warning.message}`,
    );
  }
  return lines;
};

export const formatProposalWarningsDisplay = (input: {
  readonly warnings: readonly PrdProposalWarning[];
  readonly sliceTitleByTempId: ReadonlyMap<string, string>;
}): readonly string[] => {
  if (input.warnings.length === 0) {
    return ["No PRD warnings."];
  }

  const summary = summarizePrdWarnings(input.warnings);
  const lines = [
    `${summary.high} high · ${summary.medium} medium · ${summary.low} low  (${summary.total} warnings)`,
    "",
  ];

  const bySeverity = {
    high: input.warnings.filter((warning) => warning.severity === "high"),
    medium: input.warnings.filter((warning) => warning.severity === "medium"),
    low: input.warnings.filter((warning) => warning.severity === "low"),
  };

  lines.push(
    ...formatWarningGroupLines({
      heading: "HIGH",
      warnings: bySeverity.high,
      sliceTitleByTempId: input.sliceTitleByTempId,
    }),
    ...(bySeverity.high.length > 0 && bySeverity.medium.length > 0 ? [""] : []),
    ...formatWarningGroupLines({
      heading: "MEDIUM",
      warnings: bySeverity.medium,
      sliceTitleByTempId: input.sliceTitleByTempId,
    }),
    ...(bySeverity.medium.length > 0 && bySeverity.low.length > 0 ? [""] : []),
    ...formatWarningGroupLines({
      heading: "LOW",
      warnings: bySeverity.low,
      sliceTitleByTempId: input.sliceTitleByTempId,
    }),
  );

  return lines.filter(
    (line, index, all) => !(line === "" && all[index + 1] === ""),
  );
};

export const formatHighSeverityValidationMessage = (
  warnings: readonly PrdProposalWarning[],
): string => {
  const highWarnings = warnings.filter(
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

  return lines.join("\n");
};

export const formatPrdWarningListSuffix = (
  severity: PrdWarningSeverity,
): string => `[${severity}]`;

export const formatPrdWarningSummaryLine = (
  summary: PrdWarningSummary,
): string | undefined => {
  if (summary.total === 0) {
    return undefined;
  }

  return `PRD warnings: ${summary.high} high · ${summary.medium} medium · ${summary.low} low`;
};

export const formatPrdWarningDetailsRow = (
  warning: PersistedPrdWarning,
  proposalRunId?: string,
): string => {
  const parts = [
    `[${warning.severity}]`,
    warning.message,
    `Slice: ${warning.sliceTempId}`,
  ];
  if (proposalRunId) {
    parts.push(`Proposal run: ${proposalRunId}`);
  }
  return parts.join(" · ");
};

export const matchesPrdWarningFilter = (
  task: HubTaskProjection,
  filter: PrdWarningSeverity,
): boolean => readPrdWarningFromTask(task)?.severity === filter;

export const summarizeTasksPrdWarnings = (
  tasks: readonly HubTaskProjection[],
): PrdWarningSummary => {
  const summary = {
    high: 0,
    medium: 0,
    low: 0,
    total: 0,
  };

  for (const task of tasks) {
    const warning = readPrdWarningFromTask(task);
    if (!warning) {
      continue;
    }
    summary[warning.severity] += 1;
    summary.total += 1;
  }

  return summary;
};
