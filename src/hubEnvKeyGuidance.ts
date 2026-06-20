import type { HubEnvKnownKey } from "./hubEnv.js";

export interface HubEnvKeyGuidance {
  readonly key: HubEnvKnownKey;
  readonly service: string;
  readonly summary: string;
  readonly acquisition: string;
  readonly url?: string;
  readonly alternate?: string;
}

type HubEnvKeyGuidanceDefinition = Omit<HubEnvKeyGuidance, "key">;

export const HUB_ENV_BLANK_INPUT_NOTE =
  "Leave blank to keep the existing value (does not clear it).";

const HUB_ENV_KEY_GUIDANCE: Record<
  HubEnvKnownKey,
  HubEnvKeyGuidanceDefinition
> = {
  OPENAI_KEY: {
    service: "OpenAI API",
    summary: "OpenAI platform API key for Codex API billing.",
    acquisition:
      "Create an API key in the OpenAI dashboard (Settings → API keys).",
    url: "https://platform.openai.com/api-keys",
    alternate:
      "For a Codex/ChatGPT CLI login session instead of API billing, run `sandcastle auth login codex`.",
  },
  ANTHROPIC_API_KEY: {
    service: "Anthropic Console",
    summary: "Anthropic API key for Claude Code and Pi agents.",
    acquisition: "Create an API key in the Anthropic Console.",
    url: "https://console.anthropic.com/settings/keys",
  },
  CURSOR_API_KEY: {
    service: "Cursor",
    summary:
      "Cursor user API key for headless Hub automation (`agent --print`).",
    acquisition:
      "Generate a user API key from Cursor Dashboard → API Keys. Interactive `agent login` is not enough for automation.",
    url: "https://cursor.com/docs/cli/reference/authentication",
  },
  GH_TOKEN: {
    service: "GitHub",
    summary: "GitHub token for GitHub Issues sync and `gh` CLI operations.",
    acquisition:
      "Use a personal access token with repo and issues access, or run `gh auth token` after `gh auth login`.",
    url: "https://github.com/settings/tokens",
    alternate:
      "For a reusable Hub-owned GitHub session, run `sandcastle auth login github`.",
  },
  OPENCODE_API_KEY: {
    service: "OpenCode",
    summary: "OpenCode provider credential passed to the OpenCode CLI.",
    acquisition:
      "Connect a provider with `opencode auth login` or copy the provider API key from your OpenCode setup.",
    url: "https://opencode.ai/docs/providers/",
  },
};

export const getHubEnvKeyGuidance = (
  key: HubEnvKnownKey,
): HubEnvKeyGuidance => ({
  key,
  ...HUB_ENV_KEY_GUIDANCE[key],
});

export const formatHubEnvKeyGuidanceLines = (
  key: HubEnvKnownKey,
): readonly string[] => {
  const guidance = getHubEnvKeyGuidance(key);
  return [
    `${guidance.service}: ${guidance.summary}`,
    guidance.acquisition,
    ...(guidance.url ? [guidance.url] : []),
    ...(guidance.alternate ? [guidance.alternate] : []),
  ];
};

export const formatHubEnvKeyAcquisitionHint = (key: HubEnvKnownKey): string => {
  const guidance = getHubEnvKeyGuidance(key);
  const urlPart = guidance.url ? ` ${guidance.url}` : "";
  return `${guidance.service} — ${guidance.acquisition}${urlPart}`;
};
