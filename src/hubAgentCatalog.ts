import { getAgent } from "./InitService.js";

export const HUB_AGENT_CUSTOM_MODEL_VALUE = "__custom__" as const;

export interface HubAgentModelSelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface HubAgentRoleOptionChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface HubAgentRoleOptionPrompt {
  readonly key: string;
  readonly message: string;
  readonly choices: readonly HubAgentRoleOptionChoice[];
  readonly skipLabel?: string;
}

const HUB_AGENT_MODEL_CATALOG: Readonly<Record<string, readonly string[]>> = {
  "claude-code": [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ],
  pi: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"],
  codex: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
  cursor: ["auto"],
  opencode: ["opencode/big-pickle"],
};

export const listKnownHubAgentModels = (
  providerName: string,
): readonly string[] => {
  const agent = getAgent(providerName);
  if (!agent) {
    return [];
  }

  const catalog = HUB_AGENT_MODEL_CATALOG[providerName] ?? [];
  if (catalog.length === 0) {
    return [agent.defaultModel];
  }

  const models = [...catalog];
  if (!models.includes(agent.defaultModel)) {
    models.unshift(agent.defaultModel);
  }
  return models;
};

export const buildHubAgentModelSelectOptions = (
  providerName: string,
): HubAgentModelSelectOption[] => {
  const agent = getAgent(providerName);
  const defaultModel = agent?.defaultModel ?? "";
  const options = listKnownHubAgentModels(providerName).map((model) => ({
    value: model,
    label: model,
    hint: model === defaultModel ? "default" : undefined,
  }));

  options.push({
    value: HUB_AGENT_CUSTOM_MODEL_VALUE,
    label: "Custom model...",
    hint: "availability not guaranteed",
  });

  return options;
};

export const isHubAgentCustomModelSelection = (value: string): boolean =>
  value === HUB_AGENT_CUSTOM_MODEL_VALUE;

export const HUB_AGENT_CUSTOM_MODEL_WARNING =
  "Custom models are not validated. Availability depends on your provider account and CLI version.";

export const listHubAgentRoleOptionPrompts = (
  providerName: string,
): readonly HubAgentRoleOptionPrompt[] => {
  switch (providerName) {
    case "codex":
      return [
        {
          key: "effort",
          message: "Codex reasoning effort",
          choices: [
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
            { value: "xhigh", label: "xhigh" },
          ],
          skipLabel: "None (default)",
        },
      ];
    case "claude-code":
      return [
        {
          key: "effort",
          message: "Claude Code reasoning effort",
          choices: [
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
            { value: "max", label: "max" },
          ],
          skipLabel: "None (default)",
        },
      ];
    case "cursor":
      return [
        {
          key: "mode",
          message: "Cursor agent mode",
          choices: [
            { value: "plan", label: "plan", hint: "planning mode" },
            { value: "ask", label: "ask", hint: "Q&A mode" },
          ],
          skipLabel: "Full coding mode (default)",
        },
      ];
    case "opencode":
      return [
        {
          key: "variant",
          message: "OpenCode variant",
          choices: [
            { value: "low", label: "low" },
            { value: "high", label: "high" },
            { value: "max", label: "max" },
            { value: "minimal", label: "minimal" },
          ],
          skipLabel: "None (default)",
        },
      ];
    default:
      return [];
  }
};

export const buildHubAgentRoleOptionsFromSelections = (
  providerName: string,
  selections: Readonly<Record<string, string | undefined>>,
): Record<string, string> | undefined => {
  const options: Record<string, string> = {};
  for (const prompt of listHubAgentRoleOptionPrompts(providerName)) {
    const value = selections[prompt.key]?.trim();
    if (value && value.length > 0) {
      options[prompt.key] = value;
    }
  }

  return Object.keys(options).length > 0 ? options : undefined;
};
