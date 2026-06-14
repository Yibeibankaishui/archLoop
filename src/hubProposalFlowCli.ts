import * as clack from "@clack/prompts";

import { TaskBoardError } from "./errors.js";
import { promptHubAgentRoleSetup } from "./hubAgentConfigPrompt.js";
import { setHubAgentRole, type HubAgentRoleEntry } from "./hubAgentConfig.js";
import type { ValidatedHubFlowInput } from "./hubFlowInput.js";
import {
  runPrdDecompositionFlow,
  type PrdHubStatusMode,
  type RunPrdDecompositionFlowResult,
} from "./hubPrdDecomposition.js";
import {
  runTriageProposalFlow,
  type RunTriageProposalFlowResult,
} from "./hubTriageProposalFlow.js";
import { listAgents } from "./InitService.js";
import type { HubAgentRole } from "./hubAgentConfig.js";

export type HubProposalFlowExecutionResult =
  | {
      readonly flowId: "prd-decomposition";
      readonly result: RunPrdDecompositionFlowResult;
    }
  | {
      readonly flowId: "triage";
      readonly result: RunTriageProposalFlowResult;
    };

const promptHubAgentRoleEntry = async (
  role: HubAgentRole,
): Promise<HubAgentRoleEntry> => {
  const providers = listAgents();
  const providerSelection = await clack.select({
    message: `Select agent provider for ${role} role:`,
    options: providers.map((provider) => ({
      value: provider.name,
      label: provider.label,
    })),
  });
  if (clack.isCancel(providerSelection)) {
    throw new TaskBoardError({
      message: "Hub agent role setup cancelled.",
    });
  }

  const model = await clack.text({
    message: `Model for ${role} role:`,
    defaultValue: "auto",
  });
  if (clack.isCancel(model)) {
    throw new TaskBoardError({
      message: "Hub agent role setup cancelled.",
    });
  }

  return {
    provider: String(providerSelection),
    model: String(model),
  };
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
    return approved === true;
  },
});

const createTriageRiskyDecisionConfirmation = (): ((
  recommendations: readonly {
    readonly taskId: string;
  }[],
) => Promise<boolean>) => {
  return async (recommendations) => {
    const approved = await clack.confirm({
      message: `${recommendations.length} triage decision(s) require explicit confirmation. Apply them?`,
      initialValue: false,
    });
    if (clack.isCancel(approved)) {
      return false;
    }
    return approved === true;
  };
};

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
    configureRole: async (role) => {
      const entry = await promptHubAgentRoleEntry(role);
      setHubAgentRole(role, entry);
      return entry;
    },
    interaction: input.yes ? undefined : createTriageProposalInteraction(),
    confirmRiskyDecisions: input.yes
      ? undefined
      : createTriageRiskyDecisionConfirmation(),
  });

export const runHubProposalFlowFromCli = async (input: {
  readonly cwd: string;
  readonly validatedInput: ValidatedHubFlowInput;
  readonly yes: boolean;
  readonly isTTY?: boolean;
  readonly hubStatusMode?: PrdHubStatusMode;
  readonly dependencyOverride?: string;
}): Promise<HubProposalFlowExecutionResult> => {
  switch (input.validatedInput.flowId) {
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
      const unsupportedFlow: never = input.validatedInput;
      throw new TaskBoardError({
        message: `Unsupported proposal flow "${unsupportedFlow}".`,
      });
    }
  }
};
