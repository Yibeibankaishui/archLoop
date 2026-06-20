import { describe, expect, it } from "vitest";

import {
  buildHubAgentModelSelectOptions,
  buildHubAgentRoleOptionsFromSelections,
  HUB_AGENT_CUSTOM_MODEL_VALUE,
  HUB_AGENT_CUSTOM_MODEL_WARNING,
  isHubAgentCustomModelSelection,
  listHubAgentRoleOptionPrompts,
  listKnownHubAgentModels,
} from "./hubAgentCatalog.js";

describe("hub agent catalog", () => {
  it("lists known codex models with the provider default marked", () => {
    const options = buildHubAgentModelSelectOptions("codex");

    expect(options.map((option) => option.value)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.5",
      HUB_AGENT_CUSTOM_MODEL_VALUE,
    ]);
    expect(
      options.find((option) => option.value === "gpt-5.4-mini")?.hint,
    ).toBe("default");
    expect(options.at(-1)?.label).toBe("Custom model...");
  });

  it("includes the provider default when it is missing from the catalog", () => {
    expect(listKnownHubAgentModels("cursor")).toEqual(["auto"]);
  });

  it("describes provider-specific role options", () => {
    expect(
      listHubAgentRoleOptionPrompts("codex").map((option) => option.key),
    ).toEqual(["effort"]);
    expect(
      listHubAgentRoleOptionPrompts("claude-code").map((option) => option.key),
    ).toEqual(["effort"]);
    expect(
      listHubAgentRoleOptionPrompts("cursor").map((option) => option.key),
    ).toEqual(["mode"]);
    expect(listHubAgentRoleOptionPrompts("pi")).toEqual([]);
  });

  it("builds persisted role options from interactive selections", () => {
    expect(
      buildHubAgentRoleOptionsFromSelections("codex", { effort: "medium" }),
    ).toEqual({ effort: "medium" });
    expect(
      buildHubAgentRoleOptionsFromSelections("codex", { effort: "" }),
    ).toBeUndefined();
    expect(
      buildHubAgentRoleOptionsFromSelections("cursor", { mode: "plan" }),
    ).toEqual({ mode: "plan" });
  });

  it("identifies custom model selections and warns about availability", () => {
    expect(isHubAgentCustomModelSelection(HUB_AGENT_CUSTOM_MODEL_VALUE)).toBe(
      true,
    );
    expect(HUB_AGENT_CUSTOM_MODEL_WARNING).toMatch(/not validated/i);
  });
});
