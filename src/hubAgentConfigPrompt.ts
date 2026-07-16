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
  ensureHubAgentRolesConfigured,
  HUB_AGENT_ROLES,
  type HubAgentConfig,
  type HubAgentConfigStoreOptions,
  type HubAgentRole,
  type HubAgentRoleEntry,
} from "./hubAgentConfig.js";

const HUB_AGENT_ROLE_SETUP_CANCELLED = "Hub agent role setup cancelled.";

type HubAgentPromptCancelHandler = () => never;

const throwHubAgentSetupCancelled: HubAgentPromptCancelHandler = () => {
  throw new TaskBoardError({
    message: HUB_AGENT_ROLE_SETUP_CANCELLED,
  });
};

const exitHubAgentSetupCancelled: HubAgentPromptCancelHandler = () => {
  clack.cancel(HUB_AGENT_ROLE_SETUP_CANCELLED);
  process.exit(0);
};

const buildAgentProviderSelectOptions = () =>
  listAgents().map((agent) => ({
    value: agent.name,
    label: agent.label,
    hint: `default model: ${agent.defaultModel}`,
  }));

const buildHubAgentRoleEntry = (
  providerName: string,
  model: string,
  options: HubAgentRoleEntry["options"],
): HubAgentRoleEntry => ({
  provider: providerName,
  model,
  ...(options ? { options } : {}),
});

const promptHubAgentModel = async (
  providerName: string,
  onCancel: HubAgentPromptCancelHandler,
): Promise<string> => {
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
    onCancel();
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
    onCancel();
  }

  return String(customModel).trim();
};

const promptHubAgentRoleOptions = async (
  providerName: string,
  onCancel: HubAgentPromptCancelHandler,
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
      onCancel();
    }

    const value = String(selected);
    if (value.length > 0) {
      selections[optionPrompt.key] = value;
    }
  }

  return buildHubAgentRoleOptionsFromSelections(providerName, selections);
};

const promptHubAgentRoleDetails = async (
  providerMessage: string,
  onCancel: HubAgentPromptCancelHandler,
): Promise<HubAgentRoleEntry> => {
  const providerSelection = await clack.select({
    message: providerMessage,
    options: buildAgentProviderSelectOptions(),
  });
  if (clack.isCancel(providerSelection)) {
    onCancel();
  }

  const providerName = String(providerSelection);
  const model = await promptHubAgentModel(providerName, onCancel);
  const options = await promptHubAgentRoleOptions(providerName, onCancel);
  return buildHubAgentRoleEntry(providerName, model, options);
};

export const promptHubAgentRoleEntry = async (
  role: HubAgentRole,
): Promise<HubAgentRoleEntry> =>
  promptHubAgentRoleDetails(
    `Select agent provider for ${role} role:`,
    throwHubAgentSetupCancelled,
  );

export const promptHubAgentRoleSetup = async (
  role: HubAgentRole,
): Promise<HubAgentRoleEntry> => {
  clack.intro(`Configure Hub agent role: ${role}`);

  const entry = await promptHubAgentRoleDetails(
    "Agent provider",
    exitHubAgentSetupCancelled,
  );

  clack.outro(`Saved ${role} provider settings.`);
  return entry;
};

export const promptInitHubAgentConfig = async (
  options: HubAgentConfigStoreOptions = {},
): Promise<HubAgentConfig> =>
  promptHubAgentConfig(
    async (storeOptions) =>
      initHubAgentConfig({
        env: storeOptions.env,
        homeDir: storeOptions.homeDir,
        confirmApplyToAll: async () => {
          const applyToAll = await clack.confirm({
            message:
              "Apply the same provider and model to all Hub agent roles?",
            initialValue: true,
          });
          if (clack.isCancel(applyToAll)) {
            clack.cancel(HUB_AGENT_ROLE_SETUP_CANCELLED);
            process.exit(0);
          }
          return Boolean(applyToAll);
        },
        configureRole: promptHubAgentRoleSetup,
      }),
    options,
  );

const promptHubAgentConfig = async (
  configure: (options: HubAgentConfigStoreOptions) => Promise<HubAgentConfig>,
  options: HubAgentConfigStoreOptions,
): Promise<HubAgentConfig> => {
  clack.intro("Configure Hub agent roles");
  const config = await configure(options);
  clack.outro("Hub agent roles configured.");
  return config;
};

export const promptInitializeHubAgentConfig = async (
  options: HubAgentConfigStoreOptions = {},
): Promise<HubAgentConfig> =>
  promptHubAgentConfig(
    (storeOptions) =>
      ensureHubAgentRolesConfigured({
        env: storeOptions.env,
        homeDir: storeOptions.homeDir,
        requiredRoles: HUB_AGENT_ROLES,
        interactive: true,
        configureRole: promptHubAgentRoleSetup,
      }),
    options,
  );
