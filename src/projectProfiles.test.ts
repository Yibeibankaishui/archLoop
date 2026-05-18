import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_PROFILE,
  DEFAULT_PROJECT_PROFILE_NAME,
  getProjectProfile,
  listProjectProfiles,
} from "./projectProfiles.js";

describe("Project profile registry", () => {
  it("defaults to generic", () => {
    expect(DEFAULT_PROJECT_PROFILE_NAME).toBe("generic");
    expect(DEFAULT_PROJECT_PROFILE).toBe(getProjectProfile("generic"));
  });

  it("lists generic profile", () => {
    const profiles = listProjectProfiles();
    expect(profiles.some((profile) => profile.name === "generic")).toBe(true);
  });

  it("generic profile does not add containerfile tools", () => {
    expect(DEFAULT_PROJECT_PROFILE.containerfileTools).toBe("");
  });

  it("generic profile scaffolds a no-op bootstrap script", () => {
    const script = DEFAULT_PROJECT_PROFILE.bootstrapScript;
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("exit 0");
    expect(script).not.toContain("npm install");
    expect(script).not.toContain("pip install");
  });

  it("returns undefined for unknown profiles", () => {
    expect(getProjectProfile("python")).toBeUndefined();
  });
});
