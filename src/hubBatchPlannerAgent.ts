import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { assertAgentCredentialsConfigured } from "./agentAuthGuidance.js";
import { resolveHubAgentProvider } from "./hubProposalAgent.js";
import { readHubAgentConfig, type HubAgentRole } from "./hubAgentConfig.js";
import { resolveHubFlowPromptPath } from "./hubFlows.js";
import {
  serializeHubBatchPlannerCandidates,
  type HubBatchPlannerCandidate,
} from "./hubBatchPlannerCandidates.js";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

export interface HubBatchPlannerInvokeInput {
  readonly flowId: string;
  readonly cwd: string;
  readonly runDir: string;
  readonly maxTasks: number;
  readonly candidates: readonly HubBatchPlannerCandidate[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export type HubBatchPlannerInvoker = (
  input: HubBatchPlannerInvokeInput,
) => Promise<string>;

const resolveHubBatchPlannerRoleEntry = (input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}) => {
  const config = readHubAgentConfig({
    env: input.env,
    homeDir: input.homeDir,
  });
  const role: HubAgentRole = "planning";
  const entry = config.roles[role];
  if (!entry) {
    throw new Error(`Missing Hub agent role config: ${role}`);
  }
  return entry;
};

export const createHubBatchPlannerInvoker = (input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): HubBatchPlannerInvoker => {
  const roleEntry = resolveHubBatchPlannerRoleEntry(input);
  const agent = resolveHubAgentProvider(roleEntry);

  return async (invokeInput) => {
    await assertAgentCredentialsConfigured({
      providerName: agent.name,
      cwd: invokeInput.cwd,
      env: invokeInput.env,
    });

    const logDir = join(invokeInput.runDir, "logs");
    mkdirSync(logDir, { recursive: true });

    const result = await run({
      agent,
      sandbox: noSandbox(),
      cwd: invokeInput.cwd,
      promptFile: resolveHubFlowPromptPath(invokeInput.flowId, "batchPlanner"),
      promptArgs: {
        CANDIDATES_JSON: serializeHubBatchPlannerCandidates(
          invokeInput.candidates,
        ),
        MAX_TASKS: String(invokeInput.maxTasks),
        FLOW_ID: invokeInput.flowId,
      },
      branchStrategy: { type: "head" },
      name: `batch-planner-${invokeInput.flowId}`,
      logging: {
        type: "file",
        path: join(logDir, `batch-planner-${invokeInput.flowId}.log`),
      },
      completionSignal: [],
      maxIterations: 1,
    });

    return result.stdout;
  };
};
