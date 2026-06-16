import * as clack from "@clack/prompts";

import { getAgent, listAgents } from "./InitService.js";
import {
  initHubAgentConfig,
  type HubAgentConfig,
  type HubAgentConfigStoreOptions,
  type HubAgentRole,
  type HubAgentRoleEntry,
} from "./hubAgentConfig.js";

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

export const promptInitHubAgentConfig = async (
  options: HubAgentConfigStoreOptions = {},
): Promise<HubAgentConfig> => {
  clack.intro("Configure Hub agent roles");

  const config = await initHubAgentConfig({
    env: options.env,
    homeDir: options.homeDir,
    confirmApplyToAll: async () => {
      const applyToAll = await clack.confirm({
        message: "Apply the same provider and model to all Hub agent roles?",
        initialValue: true,
      });
      if (clack.isCancel(applyToAll)) {
        clack.cancel("Hub agent role setup cancelled.");
        process.exit(0);
      }
      return Boolean(applyToAll);
    },
    configureRole: promptHubAgentRoleSetup,
  });

  clack.outro("Hub agent roles configured.");
  return config;
};
