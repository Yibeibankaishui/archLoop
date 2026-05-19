import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_PROFILE,
  DEFAULT_PROJECT_PROFILE_NAME,
  getProjectProfile,
  listProjectProfiles,
  NODE_PROJECT_PROFILE,
} from "./projectProfiles.js";

describe("Project profile registry", () => {
  it("defaults to generic", () => {
    expect(DEFAULT_PROJECT_PROFILE_NAME).toBe("generic");
    expect(DEFAULT_PROJECT_PROFILE).toBe(getProjectProfile("generic"));
  });

  it("lists registered profiles", () => {
    const names = listProjectProfiles().map((profile) => profile.name);
    expect(names).toContain("generic");
    expect(names).toContain("node");
    expect(names).toContain("python");
    expect(names).toContain("cpp");
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

  it("resolves node profile from registry", () => {
    expect(getProjectProfile("node")).toBe(NODE_PROJECT_PROFILE);
    expect(NODE_PROJECT_PROFILE.label).toBe("Node");
    expect(NODE_PROJECT_PROFILE.containerfileTools).toBe("");
  });

  it("node profile bootstrap chooses install commands from lockfiles", () => {
    const script = NODE_PROJECT_PROFILE.bootstrapScript;
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("pnpm-lock.yaml");
    expect(script).toContain("pnpm install");
    expect(script).toContain("yarn.lock");
    expect(script).toContain("yarn install");
    expect(script).toContain("package-lock.json");
    expect(script).toContain("npm ci");
    expect(script).toContain("npm install");
    expect(script).toContain("No package.json found");
    expect(script).not.toContain("npm test");
    expect(script).not.toContain("npm run build");
  });

  describe("python profile", () => {
    const python = () => getProjectProfile("python")!;

    it("is listed in the registry", () => {
      expect(python().name).toBe("python");
      expect(
        listProjectProfiles().some((profile) => profile.name === "python"),
      ).toBe(true);
    });

    it("adds Python, pip, venv, and uv to containerfile tools", () => {
      const { containerfileTools } = python();
      expect(containerfileTools).toContain("python3");
      expect(containerfileTools).toContain("python3-pip");
      expect(containerfileTools).toContain("python3-venv");
      expect(containerfileTools).toContain("uv");
      expect(containerfileTools).not.toMatch(
        /pip install poetry|poetry install/i,
      );
    });

    it("bootstrap handles uv, pip, and Poetry guidance", () => {
      const script = python().bootstrapScript;
      expect(script).toContain("#!/usr/bin/env bash");
      expect(script).toContain("ensure_venv");
      expect(script).toContain("poetry.lock");
      expect(script).toMatch(/tool\\.poetry/);
      expect(script).toContain("uv sync");
      expect(script).toContain("requirements.txt");
      expect(script).toContain("python3 -m venv");
      expect(script).toContain("pip install");
      expect(script).not.toContain("pytest");
      expect(script).not.toContain("poetry install");
    });
  });

  describe("cpp profile", () => {
    const profile = () => getProjectProfile("cpp")!;

    it("adds common C++ containerfile tools", () => {
      const { containerfileTools } = profile();
      expect(containerfileTools).toContain("build-essential");
      expect(containerfileTools).toContain("cmake");
      expect(containerfileTools).toContain("ninja-build");
    });

    it("scaffolds setup-only bootstrap behavior", () => {
      const script = profile().bootstrapScript;
      expect(script).toContain("#!/usr/bin/env bash");
      expect(script).toContain("CMakeLists.txt");
      expect(script).toContain("cmake -S");
      expect(script).not.toContain("cmake --build");
      expect(script).toContain("Makefile");
      expect(script).not.toMatch(/\bmake\b[^l]/);
      expect(script).toContain("No supported C++ build signal found");
    });
  });

  it("returns undefined for unknown profiles", () => {
    expect(getProjectProfile("rust")).toBeUndefined();
  });
});
