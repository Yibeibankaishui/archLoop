import { join } from "node:path";

import { claudeCode, codex, cursor, opencode, pi } from "./AgentProvider.js";
import type { AgentProvider } from "./AgentProvider.js";
import {
  readHubAgentConfig,
  type HubAgentRole,
  type HubAgentRoleEntry,
} from "./hubAgentConfig.js";
import type {
  ProposalAgentInvokeInput,
  ProposalAgentInvokeResult,
  ProposalAgentInvoker,
} from "./hubProposalSession.js";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const resolveHubAgentProvider = (entry: HubAgentRoleEntry): AgentProvider => {
  const options = entry.options ?? {};
  switch (entry.provider) {
    case "cursor": {
      if (options.mode === "plan" || options.mode === "ask") {
        return cursor(entry.model, { mode: options.mode });
      }
      return cursor(entry.model);
    }
    case "codex": {
      const effort = options.effort;
      if (
        effort === "low" ||
        effort === "medium" ||
        effort === "high" ||
        effort === "xhigh"
      ) {
        return codex(entry.model, { effort });
      }
      return codex(entry.model);
    }
    case "claude-code":
      return claudeCode(entry.model);
    case "opencode":
      return opencode(entry.model);
    case "pi":
      return pi(entry.model);
    default:
      throw new Error(
        `Unsupported Hub agent provider "${entry.provider}" for proposal flows`,
      );
  }
};

export const createHubProposalAgentInvoker = (input: {
  readonly role: HubAgentRole;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): ProposalAgentInvoker => {
  const config = readHubAgentConfig({
    env: input.env,
    homeDir: input.homeDir,
  });
  const entry = config.roles[input.role];
  if (!entry) {
    throw new Error(`Missing Hub agent role config: ${input.role}`);
  }

  const agent = resolveHubAgentProvider(entry);

  return async (
    invokeInput: ProposalAgentInvokeInput,
  ): Promise<ProposalAgentInvokeResult> => {
    const result = await run({
      agent,
      sandbox: noSandbox(),
      cwd: input.cwd,
      prompt: invokeInput.prompt,
      branchStrategy: { type: "head" },
      name: `proposal-${invokeInput.flowId}-${invokeInput.phase}`,
      logging: {
        type: "file",
        path: join(
          invokeInput.runDir,
          "logs",
          `${invokeInput.flowId}-${invokeInput.phase}.log`,
        ),
      },
    });

    return { assistantMessage: result.stdout };
  };
};
