import * as clack from "@clack/prompts";
import { Effect } from "effect";

import { Display } from "./Display.js";
import { ProposalPromptCancelledError, TaskBoardError } from "./errors.js";
import { promptHubAgentRoleSetup } from "./hubAgentConfigPrompt.js";
import type { ValidatedHubFlowInput } from "./hubFlowInput.js";
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
import {
  displayTriageProposalFlowResult,
  runTriageProposalFlowFromCli,
  type TriageProposalFlowDisplayOutcome,
} from "./hubTriageProposalCli.js";
import type { RunTriageProposalFlowResult } from "./hubTriageProposal.js";
import type { HubProposalPresentationEvent } from "./hubProposalSession.js";

export type HubProposalFlowExecutionResult =
  | {
      readonly flowId: "prd-decomposition";
      readonly result: RunPrdDecompositionFlowResult;
    }
  | {
      readonly flowId: "triage";
      readonly result: RunTriageProposalFlowResult;
    };

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
    throw new ProposalPromptCancelledError({
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

const withPromptLifecycle = async <T>(
  prompt: () => Promise<T>,
  beforePrompt?: () => void,
  afterPrompt?: () => void,
): Promise<T> => {
  beforePrompt?.();
  try {
    return await prompt();
  } finally {
    afterPrompt?.();
  }
};

const createPrdDecompositionInteraction = (input: {
  readonly showAgentMessages: boolean;
  readonly beforePrompt?: () => void;
  readonly afterPrompt?: () => void;
}) => ({
  ...(input.showAgentMessages
    ? { onAssistantMessage: displayProposalAgentPhase }
    : {}),
  requestRefinement: () =>
    withPromptLifecycle(
      promptPrdDecompositionRefinement,
      input.beforePrompt,
      input.afterPrompt,
    ),
  requestApproval: (proposal: PrdDecompositionProposal) =>
    withPromptLifecycle(
      () => promptPrdDecompositionApprovalWithProposal(proposal),
      input.beforePrompt,
      input.afterPrompt,
    ),
});

export const runPrdDecompositionProposalFlowFromCli = async (input: {
  readonly cwd: string;
  readonly prdRef: string;
  readonly yes: boolean;
  readonly hubStatusMode?: PrdHubStatusMode;
  readonly dependencyOverride?: string;
  readonly isTTY?: boolean;
  readonly interactive?: boolean;
  readonly showDecoratedOutput?: boolean;
  readonly onPresentationEvent?: (event: HubProposalPresentationEvent) => void;
  readonly beforePrompt?: () => void;
  readonly afterPrompt?: () => void;
  readonly signal?: AbortSignal;
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
            const proposal = latestProposal;
            return withPromptLifecycle(
              () => promptPrdHubStatusMode(proposal),
              input.beforePrompt,
              input.afterPrompt,
            );
          },
    dependencyOverride: input.dependencyOverride,
    interaction:
      input.interactive === false || input.yes
        ? undefined
        : createPrdDecompositionInteraction({
            showAgentMessages: input.showDecoratedOutput !== false,
            beforePrompt: input.beforePrompt,
            afterPrompt: input.afterPrompt,
          }),
    configureHubAgentRole:
      input.interactive === false
        ? undefined
        : (role) =>
            withPromptLifecycle(
              () => promptHubAgentRoleSetup(role),
              input.beforePrompt,
              input.afterPrompt,
            ),
    isTTY: input.interactive === false ? false : input.isTTY,
    onPresentationEvent: input.onPresentationEvent,
    signal: input.signal,
    onProposalReady: async (proposal) => {
      latestProposal = proposal;
      if (input.showDecoratedOutput !== false) {
        await displayPrdProposalWarnings(proposal);
      }
    },
  });
};

export { runTriageProposalFlowFromCli } from "./hubTriageProposalCli.js";

export const handlePrdDecompositionFlowDisplay = <E>(
  result: RunPrdDecompositionFlowResult,
  fail: (message: string) => E,
): Effect.Effect<void, E, Display> =>
  Effect.gen(function* () {
    const displayOutcome = yield* displayPrdDecompositionFlowResult(result);
    if (displayOutcome.kind === "cancelled") {
      return yield* Effect.fail(fail(displayOutcome.reason));
    }
    if (displayOutcome.kind === "failed") {
      return yield* Effect.fail(fail(displayOutcome.reason));
    }
  });

export const handleTriageProposalFlowDisplay = <E>(
  result: RunTriageProposalFlowResult,
  fail: (message: string) => E,
): Effect.Effect<void, E, Display> =>
  Effect.gen(function* () {
    const displayOutcome: TriageProposalFlowDisplayOutcome =
      yield* displayTriageProposalFlowResult(result);
    if (displayOutcome.kind === "cancelled") {
      return yield* Effect.fail(fail(displayOutcome.reason));
    }
    if (displayOutcome.kind === "failed") {
      return yield* Effect.fail(fail(displayOutcome.reason));
    }
  });

export const runHubProposalFlowFromCli = async (input: {
  readonly cwd: string;
  readonly validatedInput: ValidatedHubFlowInput;
  readonly yes: boolean;
  readonly isTTY?: boolean;
  readonly hubStatusMode?: PrdHubStatusMode;
  readonly dependencyOverride?: string;
  readonly interactive?: boolean;
  readonly showDecoratedOutput?: boolean;
  readonly onPresentationEvent?: (event: HubProposalPresentationEvent) => void;
  readonly beforePrompt?: () => void;
  readonly afterPrompt?: () => void;
  readonly signal?: AbortSignal;
}): Promise<HubProposalFlowExecutionResult> => {
  const flowId = input.validatedInput.flowId;
  switch (flowId) {
    case "prd-decomposition":
      return {
        flowId: "prd-decomposition",
        result: await runPrdDecompositionProposalFlowFromCli({
          cwd: input.cwd,
          prdRef: input.validatedInput.ref,
          yes: input.yes,
          hubStatusMode: input.hubStatusMode,
          dependencyOverride: input.dependencyOverride,
          isTTY: input.isTTY,
          interactive: input.interactive,
          showDecoratedOutput: input.showDecoratedOutput,
          onPresentationEvent: input.onPresentationEvent,
          beforePrompt: input.beforePrompt,
          afterPrompt: input.afterPrompt,
          signal: input.signal,
        }),
      };
    case "triage": {
      const triageInput = input.validatedInput;
      const taskIds =
        triageInput.selection.type === "task-id"
          ? [triageInput.selection.taskId]
          : undefined;
      const query =
        triageInput.selection.type === "statuses"
          ? triageInput.query
          : undefined;

      return {
        flowId: "triage",
        result: await runTriageProposalFlowFromCli({
          cwd: input.cwd,
          taskIds,
          query,
          yes: input.yes,
          isTTY: input.isTTY,
          interactive: input.interactive,
          showDecoratedOutput: input.showDecoratedOutput,
          onPresentationEvent: input.onPresentationEvent,
          beforePrompt: input.beforePrompt,
          afterPrompt: input.afterPrompt,
          signal: input.signal,
        }),
      };
    }
    default: {
      const unsupportedFlowId: never = flowId;
      throw new TaskBoardError({
        message: `Unsupported proposal flow "${unsupportedFlowId}".`,
      });
    }
  }
};
