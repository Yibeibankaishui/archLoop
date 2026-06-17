import * as clack from "@clack/prompts";
import { join } from "node:path";

import { TaskBoardError } from "./errors.js";
import type { PrdDecompositionProposal } from "./hubPrdDecomposition.js";
import {
  formatProposalWarningsDisplay,
  summarizePrdWarnings,
} from "./hubPrdWarning.js";
import type { ProposalSessionPhase } from "./hubProposalSession.js";

const PROPOSAL_DISPLAY_MAX_CHARS = 4_000;

const phaseLabels: Record<ProposalSessionPhase, string> = {
  draft: "Draft proposal",
  refinement: "Refined proposal",
  finalization: "Final proposal",
};

export const formatProposalAgentPhaseDisplay = (input: {
  readonly phase: ProposalSessionPhase;
  readonly flowId: string;
  readonly message: string;
  readonly runDir: string;
}): string => {
  const trimmed = input.message.trim();
  const truncated =
    trimmed.length > PROPOSAL_DISPLAY_MAX_CHARS
      ? `${trimmed.slice(0, PROPOSAL_DISPLAY_MAX_CHARS)}\n\n… (truncated)`
      : trimmed;
  const logPath = join(
    input.runDir,
    "logs",
    `${input.flowId}-${input.phase}.log`,
  );
  const transcriptPath = join(input.runDir, "artifacts", "transcript.json");

  return [
    truncated,
    "",
    `Agent log: ${logPath}`,
    `Transcript: ${transcriptPath}`,
  ].join("\n");
};

export const displayProposalAgentPhase = async (input: {
  readonly phase: ProposalSessionPhase;
  readonly flowId: string;
  readonly message: string;
  readonly runDir: string;
}): Promise<void> => {
  clack.note(formatProposalAgentPhaseDisplay(input), phaseLabels[input.phase]);
};

export const promptPrdDecompositionRefinement = async (): Promise<
  string | null
> => {
  const refineFurther = await clack.confirm({
    message: "Refine the PRD decomposition further?",
    initialValue: false,
  });
  if (clack.isCancel(refineFurther)) {
    throw new TaskBoardError({
      message: prdDecompositionCancelledMessage("refinement"),
    });
  }
  if (!refineFurther) {
    return null;
  }

  const result = await clack.text({
    message: "What should change in the decomposition?",
    placeholder: "Split slice 2, reorder dependencies, reclassify AFK/HITL...",
  });
  if (clack.isCancel(result)) {
    throw new TaskBoardError({
      message: prdDecompositionCancelledMessage("refinement"),
    });
  }

  const value = String(result).trim();
  if (value.length === 0) {
    clack.log.warn("Refinement feedback was empty. Skipping refinement.");
    return null;
  }

  return value;
};

export const formatPrdDecompositionApprovalHint = (
  proposal: PrdDecompositionProposal,
): string | undefined => {
  const summary = summarizePrdWarnings(proposal.warnings);
  if (summary.total === 0) {
    return undefined;
  }

  return `${summary.high} high · ${summary.medium} medium · ${summary.low} low PRD warning(s)`;
};

export const formatPrdProposalWarningsNote = (
  proposal: PrdDecompositionProposal,
): string => {
  const sliceTitleByTempId = new Map(
    proposal.slices.map((slice) => [slice.tempId, slice.title] as const),
  );

  return formatProposalWarningsDisplay({
    warnings: proposal.warnings,
    sliceTitleByTempId,
  }).join("\n");
};

export const displayPrdProposalWarnings = async (
  proposal: PrdDecompositionProposal,
): Promise<void> => {
  if (proposal.warnings.length === 0) {
    return;
  }

  clack.note(formatPrdProposalWarningsNote(proposal), "PRD warnings");

  const summary = summarizePrdWarnings(proposal.warnings);
  if (summary.high > 0) {
    clack.log.warn(
      "High-severity warnings block classified_ready. Use inbox or refine the decomposition.",
    );
  }
};

export const promptPrdDecompositionApproval = async (
  proposal?: PrdDecompositionProposal,
): Promise<boolean> => {
  const hint = proposal
    ? formatPrdDecompositionApprovalHint(proposal)
    : undefined;
  const result = await clack.confirm({
    message: hint
      ? `Approve this PRD decomposition and create Beads tasks?\n(${hint})`
      : "Approve this PRD decomposition and create Beads tasks?",
    initialValue: true,
  });
  if (clack.isCancel(result)) {
    throw new TaskBoardError({
      message: prdDecompositionCancelledMessage("approval"),
    });
  }
  return result;
};

export const promptPrdDecompositionApprovalWithProposal = (
  proposal: PrdDecompositionProposal,
): Promise<boolean> => promptPrdDecompositionApproval(proposal);

export const prdDecompositionCancelledMessage = (
  phase: "approval" | "refinement",
): string => {
  if (phase === "approval") {
    return "PRD task creation cancelled before creating Beads tasks.";
  }
  return "PRD task creation cancelled during refinement.";
};
