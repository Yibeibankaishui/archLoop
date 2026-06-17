import * as clack from "@clack/prompts";
import { Effect } from "effect";

import { Display } from "./Display.js";
import { TaskBoardError } from "./errors.js";
import {
  promptHubAgentRoleEntry,
  promptHubAgentRoleSetup,
} from "./hubAgentConfigPrompt.js";
import type { ValidatedHubFlowInput } from "./hubFlowInput.js";
import {
  formatPrdDecompositionProposalLines,
  runPrdDecompositionFlow,
  type PrdHubStatusMode,
  type RunPrdDecompositionFlowResult,
} from "./hubPrdDecomposition.js";
import {
  runTriageProposalFlow,
  type RunTriageProposalFlowResult,
} from "./hubTriageProposalFlow.js";
import { formatHubTriageOutcomeDisplayLabel } from "./hubTriage.js";

export type HubProposalFlowExecutionResult =
  | {
      readonly flowId: "prd-decomposition";
      readonly result: RunPrdDecompositionFlowResult;
    }
  | {
      readonly flowId: "triage";
      readonly result: RunTriageProposalFlowResult;
    };

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

const createTriageProposalInteraction = (): {
  readonly requestRefinement: () => Promise<string | null>;
  readonly requestApproval: () => Promise<boolean>;
} => ({
  requestRefinement: async () => {
    const message = await clack.text({
      message: "Refine the triage recommendations (leave blank to continue):",
      placeholder: "Ask for more context or adjust a recommendation",
    });
    if (clack.isCancel(message)) {
      return null;
    }
    const trimmed = String(message).trim();
    return trimmed.length > 0 ? trimmed : null;
  },
  requestApproval: async () => {
    const approved = await clack.confirm({
      message: "Apply the triage proposal?",
      initialValue: false,
    });
    if (clack.isCancel(approved)) {
      return false;
    }
    return approved;
  },
});

const confirmTriageRiskyDecisions = async (
  recommendations: readonly {
    readonly taskId: string;
  }[],
): Promise<boolean> => {
  const approved = await clack.confirm({
    message: `${recommendations.length} triage decision(s) require explicit confirmation. Apply them?`,
    initialValue: false,
  });
  if (clack.isCancel(approved)) {
    return false;
  }
  return approved;
};

export type TriageProposalFlowDisplayOutcome =
  | { readonly kind: "no_tasks" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "displayed" };

export const displayTriageProposalFlowResult = (
  result: RunTriageProposalFlowResult,
): Effect.Effect<TriageProposalFlowDisplayOutcome, never, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;

    if (result.preparedContext.tasks.length === 0) {
      yield* d.status("No inbox or needs_info tasks required triage.", "info");
      return { kind: "no_tasks" };
    }

    if (result.session.outcome === "cancelled") {
      yield* d.status("Triage proposal cancelled.", "info");
      return { kind: "cancelled" };
    }

    if (result.session.outcome === "failed") {
      return { kind: "failed", reason: result.session.reason };
    }

    if (!result.apply || result.apply.applied.length === 0) {
      if (result.apply?.blocked.length) {
        yield* d.status(
          "No triage decisions were applied automatically.",
          "warn",
        );
        for (const entry of result.apply.blocked) {
          yield* d.text(`  ${entry.taskId}: blocked (${entry.reason})`);
        }
        return { kind: "displayed" };
      }

      yield* d.status("No triage decisions were applied.", "info");
      return { kind: "displayed" };
    }

    yield* d.summary("Applied triage recommendations", {
      Applied: String(result.apply.applied.length),
      Blocked: String(result.apply.blocked.length),
      "Run id": result.session.runId,
    });
    for (const entry of result.apply.applied) {
      yield* d.text(
        `  ${entry.taskId}: ${formatHubTriageOutcomeDisplayLabel(entry.outcome)}`,
      );
    }
    for (const entry of result.apply.blocked) {
      yield* d.text(`  ${entry.taskId}: blocked (${entry.reason})`);
    }

    return { kind: "displayed" };
  });

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

export const handlePrdDecompositionFlowDisplay = <E>(
  result: RunPrdDecompositionFlowResult,
  fail: (message: string) => E,
): Effect.Effect<void, E, Display> =>
  Effect.gen(function* () {
    const displayOutcome = yield* displayPrdDecompositionFlowResult(result);
    if (displayOutcome.kind === "cancelled") {
      return yield* Effect.fail(fail("PRD task creation cancelled."));
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
    const displayOutcome = yield* displayTriageProposalFlowResult(result);
    if (displayOutcome.kind === "failed") {
      return yield* Effect.fail(fail(displayOutcome.reason));
    }
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

export const runTriageProposalFlowFromCli = async (input: {
  readonly cwd: string;
  readonly taskQuery: string;
  readonly yes: boolean;
  readonly isTTY?: boolean;
}): Promise<RunTriageProposalFlowResult> =>
  runTriageProposalFlow({
    cwd: input.cwd,
    taskQuery: input.taskQuery,
    yes: input.yes,
    interactive: !input.yes,
    isTTY: input.isTTY,
    configureRole: promptHubAgentRoleEntry,
    interaction: input.yes ? undefined : createTriageProposalInteraction(),
    confirmRiskyDecisions: input.yes ? undefined : confirmTriageRiskyDecisions,
  });

export const runHubProposalFlowFromCli = async (input: {
  readonly cwd: string;
  readonly validatedInput: ValidatedHubFlowInput;
  readonly yes: boolean;
  readonly isTTY?: boolean;
  readonly hubStatusMode?: PrdHubStatusMode;
  readonly dependencyOverride?: string;
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
        }),
      };
    case "triage":
      return {
        flowId: "triage",
        result: await runTriageProposalFlowFromCli({
          cwd: input.cwd,
          taskQuery: input.validatedInput.query,
          yes: input.yes,
          isTTY: input.isTTY,
        }),
      };
    default: {
      const unsupportedFlowId: never = flowId;
      throw new TaskBoardError({
        message: `Unsupported proposal flow "${unsupportedFlowId}".`,
      });
    }
  }
};
