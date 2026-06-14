import { writeFileSync } from "node:fs";

import { createHubProposalAgentInvoker } from "./hubProposalAgent.js";
import {
  ensureHubAgentRolesConfigured,
  type HubAgentRoleConfigurator,
} from "./hubAgentConfig.js";
import { readHubFlowPrompt } from "./hubFlows.js";
import {
  applyTriageProposal,
  createTriageProposalOutput,
  injectPreparedContextIntoPrompt,
  partitionTriageRecommendations,
  prepareTriageProposalContext,
  validateTriageProposalAgainstContext,
  type ApplyTriageProposalResult,
  type TriagePreparedContext,
  type TriageProposal,
  type TriageTaskRecommendation,
} from "./hubTriageProposal.js";
import {
  runProposalSession,
  resolveProposalSessionArtifactPaths,
  type ProposalAgentInvoker,
  type ProposalSessionInteraction,
  type RunProposalSessionResult,
} from "./hubProposalSession.js";

export interface RunTriageProposalFlowInput {
  readonly cwd?: string;
  readonly taskQuery: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly agentInvoker?: ProposalAgentInvoker;
  readonly interaction?: ProposalSessionInteraction;
  readonly refinements?: readonly string[];
  readonly approve?: boolean;
  readonly oneShot?: boolean;
  readonly yes?: boolean;
  readonly allowRiskyDecisions?: boolean;
  readonly confirmRiskyDecisions?: (
    recommendations: readonly TriageTaskRecommendation[],
  ) => Promise<boolean>;
  readonly configureRole?: HubAgentRoleConfigurator;
  readonly interactive?: boolean;
  readonly isTTY?: boolean;
}

export interface RunTriageProposalFlowResult {
  readonly preparedContext: TriagePreparedContext;
  readonly session: RunProposalSessionResult<TriageProposal>;
  readonly apply?: ApplyTriageProposalResult;
}

const writeApplyResult = (
  runDir: string,
  value: Record<string, unknown>,
): void => {
  const paths = resolveProposalSessionArtifactPaths(runDir);
  writeFileSync(
    paths.applyResultPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
};

export const runTriageProposalFlow = async (
  input: RunTriageProposalFlowInput,
): Promise<RunTriageProposalFlowResult> => {
  const cwd = input.cwd ?? process.cwd();
  const preparedContext = prepareTriageProposalContext({
    cwd,
    taskQuery: input.taskQuery,
    env: input.env,
  });

  if (preparedContext.tasks.length === 0) {
    return {
      preparedContext,
      session: {
        outcome: "failed",
        flowId: "triage",
        runId: "none",
        runDir: "",
        phase: "draft",
        reason: "No inbox or needs_info tasks matched the triage query.",
      },
    };
  }

  let agentInvoker = input.agentInvoker;
  if (!agentInvoker) {
    await ensureHubAgentRolesConfigured({
      requiredRoles: ["triage"],
      env: input.env,
      homeDir: input.homeDir,
      interactive: input.interactive,
      yes: input.yes,
      isTTY: input.isTTY,
      configureRole: input.configureRole,
    });
    agentInvoker = createHubProposalAgentInvoker({
      role: "triage",
      cwd,
      env: input.env,
      homeDir: input.homeDir,
    });
  }

  const draftPrompt = injectPreparedContextIntoPrompt(
    readHubFlowPrompt("triage", "draft"),
    preparedContext,
  );
  const finalizationPrompt = injectPreparedContextIntoPrompt(
    readHubFlowPrompt("triage", "finalization"),
    preparedContext,
  );

  const session = await runProposalSession({
    flowId: "triage",
    cwd,
    env: input.env,
    preparedContext: preparedContext as unknown as Readonly<
      Record<string, unknown>
    >,
    draftPrompt,
    finalizationPrompt,
    output: createTriageProposalOutput(),
    agentInvoker,
    interaction: input.interaction,
    refinements: input.refinements,
    approve: input.approve ?? input.yes,
    oneShot: input.oneShot ?? input.yes,
  });

  if (session.outcome !== "completed") {
    return { preparedContext, session };
  }

  validateTriageProposalAgainstContext(session.finalProposal, preparedContext);

  let allowRiskyDecisions = input.allowRiskyDecisions ?? false;
  if (!input.yes && !allowRiskyDecisions) {
    const { requiresConfirmation } = partitionTriageRecommendations(
      session.finalProposal.recommendations,
    );
    if (requiresConfirmation.length > 0 && input.confirmRiskyDecisions) {
      allowRiskyDecisions =
        await input.confirmRiskyDecisions(requiresConfirmation);
    }
  }

  const apply = applyTriageProposal({
    cwd,
    proposal: session.finalProposal,
    runId: session.runId,
    env: input.env,
    yesMode: input.yes,
    allowRiskyDecisions,
  });

  writeApplyResult(session.runDir, {
    status: "applied",
    appliedCount: apply.applied.length,
    blockedCount: apply.blocked.length,
    applied: apply.applied,
    blocked: apply.blocked,
  });

  return { preparedContext, session, apply };
};
