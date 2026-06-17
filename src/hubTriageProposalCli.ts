import * as clack from "@clack/prompts";
import { Effect } from "effect";

import { Display } from "./Display.js";
import { TaskBoardError } from "./errors.js";
import { promptHubAgentRoleSetup } from "./hubAgentConfigPrompt.js";
import { displayProposalAgentPhase } from "./hubProposalDisplay.js";
import {
  formatTriageProposalLines,
  runTriageProposalFlow,
  type RunTriageProposalFlowResult,
  type TriageConfirmationReason,
  type TriageProposal,
  type TriageProposalDecision,
} from "./hubTriageProposal.js";
import {
  HUB_TRIAGE_SOURCE_STATUSES,
  isHubTriageSourceStatus,
} from "./hubTriage.js";
import type { HubTaskBoard } from "./taskBoard.js";

const TRIAGE_ALL_SENTINEL = "__all__";

export type TriageProposalFlowDisplayOutcome =
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "displayed" };

export const triageProposalCancelledMessage = (
  phase: "approval" | "refinement",
): string => {
  if (phase === "approval") {
    return "Triage proposal cancelled before applying Beads task updates.";
  }
  return "Triage proposal cancelled during refinement.";
};

const formatConfirmationReason = (reason: TriageConfirmationReason): string => {
  switch (reason) {
    case "wontfix":
      return "This decision closes the task as wontfix.";
    case "dependency_change":
      return "This decision adds dependency edges.";
    case "medium_confidence":
      return "Confidence is medium.";
    case "low_confidence":
      return "Confidence is low.";
  }
};

export const promptTriageRefinement = async (): Promise<string | null> => {
  const refineFurther = await clack.confirm({
    message: "Refine the triage recommendations further?",
    initialValue: false,
  });
  if (clack.isCancel(refineFurther)) {
    throw new TaskBoardError({
      message: triageProposalCancelledMessage("refinement"),
    });
  }
  if (!refineFurther) {
    return null;
  }

  const result = await clack.text({
    message: "What should change in the triage recommendations?",
    placeholder:
      "Change outcome for bd-42, adjust confidence, rewrite comment...",
  });
  if (clack.isCancel(result)) {
    throw new TaskBoardError({
      message: triageProposalCancelledMessage("refinement"),
    });
  }

  const value = String(result).trim();
  if (value.length === 0) {
    clack.log.warn("Refinement feedback was empty. Skipping refinement.");
    return null;
  }

  return value;
};

export const promptTriageApprovalWithProposal = async (
  proposal: TriageProposal,
): Promise<boolean> => {
  const result = await clack.confirm({
    message: `Approve this triage proposal for ${proposal.decisions.length} task(s)?`,
    initialValue: true,
  });
  if (clack.isCancel(result)) {
    throw new TaskBoardError({
      message: triageProposalCancelledMessage("approval"),
    });
  }
  return result;
};

export const promptTriageApplyConfirmation = async (
  decision: TriageProposalDecision,
  reason: TriageConfirmationReason,
): Promise<boolean> => {
  const result = await clack.confirm({
    message: `Apply triage for ${decision.taskId}? Outcome: ${decision.outcome}. Confidence: ${decision.confidence}. ${formatConfirmationReason(reason)}`,
    initialValue: reason !== "low_confidence",
  });
  if (clack.isCancel(result)) {
    throw new TaskBoardError({
      message: triageProposalCancelledMessage("approval"),
    });
  }
  return result;
};

export const promptTriageTaskSelection = async (input: {
  readonly board: HubTaskBoard;
}): Promise<string[]> => {
  const candidates = input.board.tasks.filter((task) =>
    isHubTriageSourceStatus(task.hubStatus),
  );

  if (candidates.length === 0) {
    throw new TaskBoardError({
      message: `No ${HUB_TRIAGE_SOURCE_STATUSES.join(" or ")} tasks are available for triage.`,
    });
  }

  const selected = await clack.multiselect({
    message: "Select tasks to triage",
    options: [
      {
        value: TRIAGE_ALL_SENTINEL,
        label: "All inbox and needs_info tasks",
        hint: `${candidates.length} task(s)`,
      },
      ...candidates.map((task) => ({
        value: task.id,
        label: `${task.id}: ${task.title}`,
        hint: task.hubStatus,
      })),
    ],
    required: true,
  });

  if (clack.isCancel(selected)) {
    throw new TaskBoardError({
      message: "Triage task selection cancelled.",
    });
  }

  const values = selected as string[];
  if (values.includes(TRIAGE_ALL_SENTINEL)) {
    return candidates.map((task) => task.id);
  }

  return values;
};

const createTriageInteraction = (): {
  readonly onAssistantMessage: typeof displayProposalAgentPhase;
  readonly requestRefinement: typeof promptTriageRefinement;
  readonly requestApproval: typeof promptTriageApprovalWithProposal;
} => ({
  onAssistantMessage: displayProposalAgentPhase,
  requestRefinement: promptTriageRefinement,
  requestApproval: promptTriageApprovalWithProposal,
});

export const displayTriageProposalFlowResult = (
  result: RunTriageProposalFlowResult,
): Effect.Effect<TriageProposalFlowDisplayOutcome, never, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;

    if (result.outcome === "cancelled") {
      return {
        kind: "cancelled",
        reason: triageProposalCancelledMessage(result.phase),
      };
    }

    if (result.outcome === "failed") {
      return { kind: "failed", reason: result.reason };
    }

    for (const line of formatTriageProposalLines(result.proposal)) {
      yield* d.text(line);
    }

    yield* d.summary("Applied triage decisions", {
      "Proposal run": result.runId,
      Applied: String(result.appliedDecisions.length),
      Skipped: String(result.skippedDecisions.length),
      Dependencies: String(result.dependencies.length),
    });

    for (const taskId of result.appliedDecisions) {
      yield* d.text(`  applied: ${taskId}`);
    }
    for (const skipped of result.skippedDecisions) {
      yield* d.text(`  skipped ${skipped.taskId}: ${skipped.reason}`);
    }
    for (const dependency of result.dependencies) {
      yield* d.text(
        `  ${dependency.dependentId} depends on ${dependency.blockerId}`,
      );
    }
    for (const skipped of result.skippedDependencies) {
      yield* d.text(
        `Skipped dependency: ${skipped.dependentTaskId} blocked by ${skipped.blockerTaskId} (${skipped.reason})`,
      );
    }

    return { kind: "displayed" };
  });

export const runTriageProposalFlowFromCli = async (input: {
  readonly cwd: string;
  readonly taskIds?: readonly string[];
  readonly query?: string;
  readonly yes: boolean;
  readonly isTTY?: boolean;
}): Promise<RunTriageProposalFlowResult> =>
  runTriageProposalFlow({
    cwd: input.cwd,
    taskIds: input.taskIds,
    query: input.query,
    yes: input.yes,
    interaction: input.yes ? undefined : createTriageInteraction(),
    applyConfirmation:
      input.yes && input.isTTY !== true
        ? undefined
        : promptTriageApplyConfirmation,
    configureHubAgentRole: promptHubAgentRoleSetup,
    isTTY: input.isTTY,
  });
