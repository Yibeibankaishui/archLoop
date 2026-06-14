import * as clack from "@clack/prompts";

import { getAgent, listAgents } from "./InitService.js";
import type { HubAgentRole, HubAgentRoleEntry } from "./hubAgentConfig.js";

export const promptHubAgentRoleSetup = async (
  role: HubAgentRole,
): Promise<HubAgentRoleEntry> => {
  clack.intro(`Configure Hub agent role: ${role}`);

  const provider = await clack.select({
    message: "Agent provider",
    options: listAgents().map((agent) => ({
      value: agent.name,
      label: agent.label,
      hint: `default model: ${agent.defaultModel}`,
    })),
  });
  if (clack.isCancel(provider)) {
    clack.cancel("Hub agent role setup cancelled.");
    process.exit(0);
  }

  const selectedAgent = getAgent(String(provider));
  const model = await clack.text({
    message: "Model",
    placeholder: selectedAgent?.defaultModel ?? "model",
    defaultValue: selectedAgent?.defaultModel,
    validate: (value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed.length === 0 ? "Model is required" : undefined;
    },
  });
  if (clack.isCancel(model)) {
    clack.cancel("Hub agent role setup cancelled.");
    process.exit(0);
  }

  clack.outro(`Saved ${role} provider settings.`);
  return {
    provider: String(provider),
    model: String(model).trim(),
  };
};

export const createDefaultHubAgentRoleConfigurator = (): ((
  role: HubAgentRole,
) => Promise<HubAgentRoleEntry>) => promptHubAgentRoleSetup;
