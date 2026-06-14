import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { claudeCode, codex, cursor, opencode, pi } from "./AgentProvider.js";
import type { AgentProvider } from "./AgentProvider.js";
import type { HubAgentRoleEntry } from "./hubAgentConfig.js";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import type {
  ProposalAgentInvokeInput,
  ProposalAgentInvokeResult,
  ProposalAgentInvoker,
} from "./hubProposalSession.js";

const resolveCodexOptions = (
  options: HubAgentRoleEntry["options"],
): { readonly effort?: "low" | "medium" | "high" | "xhigh" } => {
  const effort = options?.effort;
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return { effort };
  }
  return {};
};

const resolveCursorOptions = (
  options: HubAgentRoleEntry["options"],
): { readonly mode?: "plan" | "ask" } => {
  const mode = options?.mode;
  if (mode === "plan" || mode === "ask") {
    return { mode };
  }
  return {};
};

const resolveOpenCodeOptions = (
  options: HubAgentRoleEntry["options"],
): { readonly variant?: string } => {
  const variant = options?.variant?.trim();
  return variant ? { variant } : {};
};

export const resolveHubAgentProvider = (
  entry: HubAgentRoleEntry,
): AgentProvider => {
  switch (entry.provider) {
    case "cursor":
      return cursor(entry.model, resolveCursorOptions(entry.options));
    case "codex":
      return codex(entry.model, resolveCodexOptions(entry.options));
    case "claude-code":
      return claudeCode(entry.model);
    case "opencode":
      return opencode(entry.model, resolveOpenCodeOptions(entry.options));
    case "pi":
      return pi(entry.model);
    default:
      throw new Error(
        `Unsupported Hub agent provider "${entry.provider}" for proposal flows.`,
      );
  }
};

export const createHubProposalAgentInvoker = (input: {
  readonly cwd: string;
  readonly roleEntry: HubAgentRoleEntry;
  readonly env?: NodeJS.ProcessEnv;
}): ProposalAgentInvoker => {
  const agent = resolveHubAgentProvider(input.roleEntry);

  return async (
    invokeInput: ProposalAgentInvokeInput,
  ): Promise<ProposalAgentInvokeResult> => {
    const logDir = join(invokeInput.runDir, "logs");
    mkdirSync(logDir, { recursive: true });

    const result = await run({
      agent,
      sandbox: noSandbox(),
      cwd: input.cwd,
      prompt: invokeInput.prompt,
      name: `proposal-${invokeInput.flowId}-${invokeInput.phase}`,
      logging: {
        type: "file",
        path: join(logDir, `${invokeInput.phase}.log`),
      },
      completionSignal: [],
      maxIterations: 1,
    });

    return { assistantMessage: result.stdout };
  };
};
