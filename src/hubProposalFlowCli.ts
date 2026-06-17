import * as clack from "@clack/prompts";
import { Effect } from "effect";

import { Display } from "./Display.js";
import { TaskBoardError } from "./errors.js";
import { promptHubAgentRoleSetup } from "./hubAgentConfigPrompt.js";
import {
  displayPrdProposalWarnings,
  displayProposalAgentPhase,
  formatPrdDecompositionApprovalHint,
  prdDecompositionCancelledMessage,
  promptPrdDecompositionApprovalWithProposal,
  promptPrdDecompositionRefinement,
} from "./hubProposalDisplay.js";
import {
  formatPrdDecompositionProposalLines,
  runPrdDecompositionFlow,
  type PrdDecompositionProposal,
  type PrdHubStatusMode,
  type RunPrdDecompositionFlowResult,
} from "./hubPrdDecomposition.js";
import {
  formatPrdWarningListSuffix,
  summarizePrdWarnings,
} from "./hubPrdWarning.js";

export type PrdDecompositionFlowDisplayOutcome =
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "displayed" };

export const displayPrdDecompositionFlowResult = (
  result: RunPrdDecompositionFlowResult,
): Effect.Effect<PrdDecompositionFlowDisplayOutcome, never, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;

    if (result.outcome === "cancelled") {
      return {
        kind: "cancelled",
        reason: prdDecompositionCancelledMessage(result.phase),
      };
    }

    if (result.outcome === "failed") {
      return { kind: "failed", reason: result.reason };
    }

    for (const line of formatPrdDecompositionProposalLines(result.proposal)) {
      yield* d.text(line);
    }

    const warningSummary = summarizePrdWarnings(result.proposal.warnings);
    const summaryRows: Record<string, string> = {
      PRD: result.proposal.prdTitle,
      Reference: result.proposal.prdRef,
      "Proposal run": result.runId,
      Status: result.hubStatusMode,
      Tasks: String(result.tasks.length),
      Dependencies: String(result.dependencies.length),
    };
    if (warningSummary.total > 0) {
      summaryRows.Warnings = `${warningSummary.high} high · ${warningSummary.medium} medium · ${warningSummary.low} low`;
    }

    yield* d.summary("Created PRD-derived Beads tasks", summaryRows);

    for (const task of result.tasks) {
      const warningSuffix = task.prdWarning
        ? ` ${formatPrdWarningListSuffix(task.prdWarning.severity)}`
        : "";
      yield* d.text(`  ${task.id}: ${task.title}${warningSuffix}`);
    }
    for (const dependency of result.dependencies) {
      yield* d.text(
        `  ${dependency.dependentId} depends on ${dependency.blockerId}`,
      );
    }

    if (warningSummary.high > 0) {
      yield* d.text(
        "Tip: high-severity warnings block classified_ready. Use inbox or refine the decomposition.",
      );
    }

    return { kind: "displayed" };
  });

const promptPrdHubStatusMode = async (
  proposal: PrdDecompositionProposal,
): Promise<PrdHubStatusMode> => {
  const warningHint = formatPrdDecompositionApprovalHint(proposal);
  const selected = await clack.select({
    message: warningHint
      ? `Initial Hub status for PRD-derived tasks (${warningHint}):`
      : "Initial Hub status for PRD-derived tasks (defaults to inbox):",
    options: [
      {
        value: "inbox",
        label: "inbox",
        hint: "needs triage",
      },
      {
        value: "classified_ready",
        label: "classified_ready",
        hint: "AFK -> ready_for_agent, HITL -> ready_for_human",
      },
    ],
    initialValue: "inbox",
  });
  if (clack.isCancel(selected)) {
    throw new TaskBoardError({
      message: "PRD task creation cancelled.",
    });
  }

  const hubStatusMode = selected as PrdHubStatusMode;
  if (
    hubStatusMode === "classified_ready" &&
    summarizePrdWarnings(proposal.warnings).high > 0
  ) {
    clack.log.warn(
      "High-severity warnings block classified_ready. Choose inbox or refine the decomposition.",
    );
  }

  return hubStatusMode;
};

const createPrdDecompositionInteraction = (): {
  readonly onAssistantMessage: typeof displayProposalAgentPhase;
  readonly requestRefinement: typeof promptPrdDecompositionRefinement;
  readonly requestApproval: typeof promptPrdDecompositionApprovalWithProposal;
} => ({
  onAssistantMessage: displayProposalAgentPhase,
  requestRefinement: promptPrdDecompositionRefinement,
  requestApproval: promptPrdDecompositionApprovalWithProposal,
});

export const runPrdDecompositionProposalFlowFromCli = async (input: {
  readonly cwd: string;
  readonly prdRef: string;
  readonly yes: boolean;
  readonly hubStatusMode?: PrdHubStatusMode;
  readonly dependencyOverride?: string;
  readonly isTTY?: boolean;
}): Promise<RunPrdDecompositionFlowResult> => {
  let latestProposal: PrdDecompositionProposal | undefined;

  return runPrdDecompositionFlow({
    cwd: input.cwd,
    prdRef: input.prdRef,
    yes: input.yes,
    hubStatusMode: input.hubStatusMode,
    resolveHubStatusMode:
      input.yes || input.hubStatusMode
        ? undefined
        : async () => {
            if (!latestProposal) {
              throw new TaskBoardError({
                message: "PRD decomposition proposal was not ready.",
              });
            }
            return promptPrdHubStatusMode(latestProposal);
          },
    dependencyOverride: input.dependencyOverride,
    interaction: input.yes ? undefined : createPrdDecompositionInteraction(),
    configureHubAgentRole: promptHubAgentRoleSetup,
    isTTY: input.isTTY,
    onProposalReady: async (proposal) => {
      latestProposal = proposal;
      await displayPrdProposalWarnings(proposal);
    },
  });
};
