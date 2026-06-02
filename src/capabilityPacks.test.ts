import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPABILITY_PACK_ID,
  getCapabilityPackDefinition,
  listCapabilityPacksForInit,
  resolveCapabilityInitOptions,
  validateCapabilityRegistries,
  type CapabilityInitInputs,
} from "./capabilityPacks.js";

describe("capability pack registry", () => {
  it("validateCapabilityRegistries passes", () => {
    expect(() => validateCapabilityRegistries()).not.toThrow();
  });

  it("lists generic and miniprogram packs for init", () => {
    const ids = listCapabilityPacksForInit().map((p) => p.value);
    expect(ids).toContain("generic");
    expect(ids).toContain("miniprogram");
  });

  it("generic pack has no defaults that alter init", () => {
    const pack = getCapabilityPackDefinition("generic")!;
    expect(pack.defaultTemplate).toBeUndefined();
    expect(pack.defaultProjectProfile).toBeUndefined();
    expect(pack.defaultPresetAgentIds).toBeUndefined();
    expect(pack.defaultVariant).toBeUndefined();
    expect(pack.verification).toBeUndefined();
    expect(pack.addons).toEqual([]);
  });

  it("miniprogram pack declares defaults and verification metadata", () => {
    const pack = getCapabilityPackDefinition("miniprogram")!;
    expect(pack.defaultTemplate).toBe("parallel-planner-with-review");
    expect(pack.defaultProjectProfile).toBe("node");
    expect(pack.defaultPresetAgentIds).toEqual(["miniprogram"]);
    expect(pack.defaultVariant).toBe("native");
    expect(pack.verification).toEqual({
      entrypoint: ".sandcastle/verify.sh",
      diagnosticLog: "debug/wx-check.log",
    });
    expect(pack.addons.map((a) => a.id)).toContain("runtime-debug");
  });

  it("miniprogram runtime-debug add-on requires no-sandbox", () => {
    const pack = getCapabilityPackDefinition("miniprogram")!;
    const addon = pack.addons.find((a) => a.id === "runtime-debug");
    expect(addon).toBeDefined();
    expect(addon!.compatibleSandboxProviders).toEqual(["no-sandbox"]);
    expect(addon!.requiresHostState).toBe(true);
  });
});

describe("resolveCapabilityInitOptions", () => {
  const base: CapabilityInitInputs = {
    capabilityId: "generic",
  };

  it("defaults to generic when capability is omitted", () => {
    const resolved = resolveCapabilityInitOptions({});
    expect(resolved.capabilityId).toBe(DEFAULT_CAPABILITY_PACK_ID);
    expect(resolved.templateName).toBe("blank");
    expect(resolved.projectProfileName).toBe("generic");
    expect(resolved.presetAgentIds).toEqual([]);
    expect(resolved.addonIds).toEqual([]);
  });

  it("generic leaves explicit init choices unchanged", () => {
    const resolved = resolveCapabilityInitOptions({
      ...base,
      explicitTemplate: "simple-loop",
      explicitProjectProfile: "python",
      explicitPresetAgentIds: ["reviewer"],
    });
    expect(resolved.templateName).toBe("simple-loop");
    expect(resolved.projectProfileName).toBe("python");
    expect(resolved.presetAgentIds).toEqual(["reviewer"]);
  });

  it("miniprogram applies pack defaults when init flags are omitted", () => {
    const resolved = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
    });
    expect(resolved.capabilityId).toBe("miniprogram");
    expect(resolved.variant).toBe("native");
    expect(resolved.templateName).toBe("parallel-planner-with-review");
    expect(resolved.projectProfileName).toBe("node");
    expect(resolved.presetAgentIds).toEqual(["miniprogram"]);
  });

  it("explicit init flags override miniprogram defaults", () => {
    const resolved = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
      explicitTemplate: "blank",
      explicitProjectProfile: "generic",
      explicitPresetAgentIds: ["planner"],
    });
    expect(resolved.templateName).toBe("blank");
    expect(resolved.projectProfileName).toBe("generic");
    expect(resolved.presetAgentIds).toEqual(["planner"]);
  });

  it("rejects unknown capability pack id", () => {
    expect(() =>
      resolveCapabilityInitOptions({ capabilityId: "not-a-pack" }),
    ).toThrow(/Unknown capability pack/);
  });

  it("rejects unknown add-on for the selected pack", () => {
    expect(() =>
      resolveCapabilityInitOptions({
        capabilityId: "generic",
        addonIds: ["runtime-debug"],
      }),
    ).toThrow(/Unknown capability add-on/);
  });

  it("rejects runtime-debug add-on with docker sandbox", () => {
    expect(() =>
      resolveCapabilityInitOptions({
        capabilityId: "miniprogram",
        addonIds: ["runtime-debug"],
        sandboxProviderName: "docker",
      }),
    ).toThrow(/not compatible with sandbox provider "docker"/);
  });

  it("accepts runtime-debug add-on with no-sandbox", () => {
    const resolved = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
      addonIds: ["runtime-debug"],
      sandboxProviderName: "no-sandbox",
    });
    expect(resolved.addonIds).toEqual(["runtime-debug"]);
  });
});
