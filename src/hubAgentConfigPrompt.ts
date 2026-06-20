import * as clack from "@clack/prompts";

import { TaskBoardError } from "./errors.js";
import { getAgent, listAgents } from "./InitService.js";
import {
  buildHubAgentModelSelectOptions,
  buildHubAgentRoleOptionsFromSelections,
  HUB_AGENT_CUSTOM_MODEL_WARNING,
  isHubAgentCustomModelSelection,
  listHubAgentRoleOptionPrompts,
} from "./hubAgentCatalog.js";
import {
  initHubAgentConfig,
  type HubAgentConfig,
  type HubAgentConfigStoreOptions,
  type HubAgentRole,
  type HubAgentRoleEntry,
} from "./hubAgentConfig.js";

const promptHubAgentModel = async (providerName: string): Promise<string> => {
  const selectedAgent = getAgent(providerName);
  const modelOptions = buildHubAgentModelSelectOptions(providerName);
  const defaultModel = selectedAgent?.defaultModel;
  const initialValue =
    defaultModel && modelOptions.some((option) => option.value === defaultModel)
      ? defaultModel
      : modelOptions[0]?.value;

  const modelSelection = await clack.select({
    message: "Model",
    initialValue,
    options: modelOptions.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
  });
  if (clack.isCancel(modelSelection)) {
    throw new TaskBoardError({
      message: "Hub agent role setup cancelled.",
    });
  }

  if (!isHubAgentCustomModelSelection(String(modelSelection))) {
    return String(modelSelection);
  }

  clack.log.warn(HUB_AGENT_CUSTOM_MODEL_WARNING);
  const customModel = await clack.text({
    message: "Custom model name",
    placeholder: selectedAgent?.defaultModel ?? "model",
    validate: (value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed.length === 0 ? "Model is required" : undefined;
    },
  });
  if (clack.isCancel(customModel)) {
    throw new TaskBoardError({
      message: "Hub agent role setup cancelled.",
    });
  }

  return String(customModel).trim();
};

const promptHubAgentRoleOptions = async (
  providerName: string,
): Promise<HubAgentRoleEntry["options"]> => {
  const selections: Record<string, string | undefined> = {};

  for (const optionPrompt of listHubAgentRoleOptionPrompts(providerName)) {
    const selected = await clack.select({
      message: optionPrompt.message,
      options: [
        ...optionPrompt.choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
          hint: choice.hint,
        })),
        ...(optionPrompt.skipLabel
          ? [{ value: "", label: optionPrompt.skipLabel }]
          : []),
      ],
    });
    if (clack.isCancel(selected)) {
      throw new TaskBoardError({
        message: "Hub agent role setup cancelled.",
      });
    }

    const value = String(selected);
    if (value.length > 0) {
      selections[optionPrompt.key] = value;
    }
  }

  return buildHubAgentRoleOptionsFromSelections(providerName, selections);
};

export const promptHubAgentRoleEntry = async (
  role: HubAgentRole,
): Promise<HubAgentRoleEntry> => {
  const providers = listAgents();
  const providerSelection = await clack.select({
    message: `Select agent provider for ${role} role:`,
    options: providers.map((provider) => ({
      value: provider.name,
      label: provider.label,
      hint: `default model: ${provider.defaultModel}`,
    })),
  });
  if (clack.isCancel(providerSelection)) {
    throw new TaskBoardError({
      message: "Hub agent role setup cancelled.",
    });
  }

  const providerName = String(providerSelection);
  const model = await promptHubAgentModel(providerName);
  const options = await promptHubAgentRoleOptions(providerName);

  return {
    provider: providerName,
    model,
    ...(options ? { options } : {}),
  };
};

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

  const providerName = String(provider);
  const model = await promptHubAgentModel(providerName);
  const options = await promptHubAgentRoleOptions(providerName);

  clack.outro(`Saved ${role} provider settings.`);
  return {
    provider: providerName,
    model,
    ...(options ? { options } : {}),
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
