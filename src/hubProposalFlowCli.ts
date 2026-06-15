import * as clack from "@clack/prompts";
import { Effect } from "effect";

import { Display } from "./Display.js";
import { TaskBoardError } from "./errors.js";
import { promptHubAgentRoleSetup } from "./hubAgentConfigPrompt.js";
import {
  formatPrdDecompositionProposalLines,
  runPrdDecompositionFlow,
  type PrdHubStatusMode,
  type RunPrdDecompositionFlowResult,
} from "./hubPrdDecomposition.js";

export type PrdDecompositionFlowDisplayOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "displayed" };

export const displayPrdDecompositionFlowResult = (
  result: RunPrdDecompositionFlowResult,
): Effect.Effect<PrdDecompositionFlowDisplayOutcome, never, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;

    if (result.outcome === "cancelled") {
      return { kind: "cancelled" };
    }

    if (result.outcome === "failed") {
      return { kind: "failed", reason: result.reason };
    }

    for (const line of formatPrdDecompositionProposalLines(result.proposal)) {
      yield* d.text(line);
    }

    yield* d.summary("Created PRD-derived Beads tasks", {
      PRD: result.proposal.prdTitle,
      Reference: result.proposal.prdRef,
      "Proposal run": result.runId,
      Status: result.hubStatusMode,
      Tasks: String(result.tasks.length),
      Dependencies: String(result.dependencies.length),
    });
    for (const task of result.tasks) {
      yield* d.text(`  ${task.id}: ${task.title}`);
    }
    for (const dependency of result.dependencies) {
      yield* d.text(
        `  ${dependency.dependentId} depends on ${dependency.blockerId}`,
      );
    }

    return { kind: "displayed" };
  });

const promptPrdHubStatusMode = async (): Promise<PrdHubStatusMode> => {
  const selected = await clack.select({
    message: "Initial Hub status for PRD-derived tasks (defaults to inbox):",
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
  return selected as PrdHubStatusMode;
};

const createPrdDecompositionInteraction = (): {
  readonly requestRefinement: () => Promise<string | null>;
  readonly requestApproval: () => Promise<boolean>;
} => ({
  requestRefinement: async () => {
    const result = await clack.text({
      message: "Refine the PRD decomposition (leave empty to stop refining):",
      placeholder:
        "Split slice 2, reorder dependencies, reclassify AFK/HITL...",
      defaultValue: "",
    });
    if (clack.isCancel(result)) {
      throw new TaskBoardError({
        message: "PRD task creation cancelled.",
      });
    }
    const value = String(result).trim();
    return value.length > 0 ? value : null;
  },
  requestApproval: async () => {
    const result = await clack.confirm({
      message: "Approve this PRD decomposition and create Beads tasks?",
      initialValue: true,
    });
    if (clack.isCancel(result)) {
      throw new TaskBoardError({
        message: "PRD task creation cancelled.",
      });
    }
    return result;
  },
});

export const runPrdDecompositionProposalFlowFromCli = async (input: {
  readonly cwd: string;
  readonly prdRef: string;
  readonly yes: boolean;
  readonly hubStatusMode?: PrdHubStatusMode;
  readonly dependencyOverride?: string;
  readonly isTTY?: boolean;
}): Promise<RunPrdDecompositionFlowResult> =>
  runPrdDecompositionFlow({
    cwd: input.cwd,
    prdRef: input.prdRef,
    yes: input.yes,
    hubStatusMode: input.hubStatusMode,
    resolveHubStatusMode:
      input.yes || input.hubStatusMode ? undefined : promptPrdHubStatusMode,
    dependencyOverride: input.dependencyOverride,
    interaction: input.yes ? undefined : createPrdDecompositionInteraction(),
    configureHubAgentRole: promptHubAgentRoleSetup,
    isTTY: input.isTTY,
  });
