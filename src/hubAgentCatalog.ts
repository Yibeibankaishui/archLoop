import { getAgent } from "./InitService.js";

export const HUB_AGENT_CUSTOM_MODEL_VALUE = "__custom__" as const;

export interface HubAgentSelectChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface HubAgentRoleOptionPrompt {
  readonly key: string;
  readonly message: string;
  readonly choices: readonly HubAgentSelectChoice[];
  readonly skipLabel?: string;
}

const hubAgentChoice = (
  value: string,
  hint?: string,
): HubAgentSelectChoice => ({
  value,
  label: value,
  ...(hint ? { hint } : {}),
});

const hubAgentEffortChoices = (
  extra: HubAgentSelectChoice,
): readonly HubAgentSelectChoice[] => [
  hubAgentChoice("low"),
  hubAgentChoice("medium"),
  hubAgentChoice("high"),
  extra,
];

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
): HubAgentSelectChoice[] => {
  const agent = getAgent(providerName);
  const defaultModel = agent?.defaultModel ?? "";
  const options = listKnownHubAgentModels(providerName).map((model) =>
    hubAgentChoice(model, model === defaultModel ? "default" : undefined),
  );

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
          choices: hubAgentEffortChoices(hubAgentChoice("xhigh")),
          skipLabel: "None (default)",
        },
      ];
    case "claude-code":
      return [
        {
          key: "effort",
          message: "Claude Code reasoning effort",
          choices: hubAgentEffortChoices(hubAgentChoice("max")),
          skipLabel: "None (default)",
        },
      ];
    case "cursor":
      return [
        {
          key: "mode",
          message: "Cursor agent mode",
          choices: [
            hubAgentChoice("plan", "planning mode"),
            hubAgentChoice("ask", "Q&A mode"),
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
            hubAgentChoice("low"),
            hubAgentChoice("high"),
            hubAgentChoice("max"),
            hubAgentChoice("minimal"),
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
    if (value) {
      options[prompt.key] = value;
    }
  }

  return Object.keys(options).length > 0 ? options : undefined;
};
