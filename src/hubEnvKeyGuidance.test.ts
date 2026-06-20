import { describe, expect, it } from "vitest";

import { HUB_ENV_KNOWN_KEYS } from "./hubEnv.js";
import {
  formatHubEnvKeyAcquisitionHint,
  formatHubEnvKeyGuidanceLines,
  getHubEnvKeyGuidance,
  HUB_ENV_BLANK_INPUT_NOTE,
} from "./hubEnvKeyGuidance.js";

describe("hubEnvKeyGuidance", () => {
  it("defines acquisition guidance for every known Hub env key", () => {
    for (const key of HUB_ENV_KNOWN_KEYS) {
      const guidance = getHubEnvKeyGuidance(key);
      expect(guidance.key).toBe(key);
      expect(guidance.service.length).toBeGreaterThan(0);
      expect(guidance.summary.length).toBeGreaterThan(0);
      expect(guidance.acquisition.length).toBeGreaterThan(0);
    }
  });

  it("includes stable URLs for provider API keys", () => {
    expect(formatHubEnvKeyGuidanceLines("OPENAI_KEY").join("\n")).toContain(
      "https://platform.openai.com/api-keys",
    );
    expect(
      formatHubEnvKeyGuidanceLines("ANTHROPIC_API_KEY").join("\n"),
    ).toContain("https://console.anthropic.com/settings/keys");
    expect(formatHubEnvKeyGuidanceLines("CURSOR_API_KEY").join("\n")).toContain(
      "https://cursor.com/docs/cli/reference/authentication",
    );
    expect(
      formatHubEnvKeyGuidanceLines("OPENCODE_API_KEY").join("\n"),
    ).toContain("https://opencode.ai/docs/providers/");
  });

  it("explains GH_TOKEN scopes and gh auth alternatives", () => {
    const lines = formatHubEnvKeyGuidanceLines("GH_TOKEN");
    const joined = lines.join("\n");
    expect(joined).toMatch(/GitHub/i);
    expect(joined).toMatch(/gh auth token|sandcastle auth login github/i);
    expect(joined).toMatch(/repo|issue/i);
  });

  it("clarifies Cursor headless API key vs interactive login", () => {
    const joined = formatHubEnvKeyGuidanceLines("CURSOR_API_KEY").join("\n");
    expect(joined).toMatch(/headless|automation|agent login/i);
  });

  it("clarifies OPENAI_KEY API billing vs Codex CLI login", () => {
    const joined = formatHubEnvKeyGuidanceLines("OPENAI_KEY").join("\n");
    expect(joined).toMatch(/OpenAI API/i);
    expect(joined).toMatch(/sandcastle auth login codex/i);
  });

  it("formats a short acquisition hint for env show", () => {
    expect(formatHubEnvKeyAcquisitionHint("CURSOR_API_KEY")).toContain(
      "Cursor",
    );
    expect(formatHubEnvKeyAcquisitionHint("CURSOR_API_KEY")).toContain(
      "https://",
    );
  });

  it("documents blank-input behavior for env init prompts", () => {
    expect(HUB_ENV_BLANK_INPUT_NOTE).toMatch(/blank/i);
    expect(HUB_ENV_BLANK_INPUT_NOTE).toMatch(/keep|unchanged|clear/i);
  });
});
