import { describe, expect, it } from "vitest";
import { renderBootstrapScript } from "./bootstrap.js";

describe("renderBootstrapScript", () => {
  it("renders a no-op generic bootstrap script", () => {
    const script = renderBootstrapScript("generic");
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("exit 0");
    expect(script).not.toContain("npm install");
    expect(script).not.toContain("pip install");
  });

  it("renders node bootstrap with lockfile-based install commands", () => {
    const script = renderBootstrapScript("node");
    expect(script).toContain("pnpm-lock.yaml");
    expect(script).toContain("npm ci");
    expect(script).toContain("No package.json found");
  });

  it("renders a Python bootstrap script with uv, pip, and Poetry guidance", () => {
    const script = renderBootstrapScript("python");
    expect(script).toContain("ensure_venv");
    expect(script).toContain("uv sync");
    expect(script).toContain("requirements.txt");
    expect(script).toContain("Poetry");
    expect(script).not.toContain("pytest");
    expect(script).not.toContain("poetry install");
  });

  it("renders cpp bootstrap with setup-only cmake and makefile handling", () => {
    const script = renderBootstrapScript("cpp");
    expect(script).toContain("cmake -S");
    expect(script).not.toContain("cmake --build");
    expect(script).toContain("Makefile");
    expect(script).not.toMatch(/\bmake\b[^l]/);
    expect(script).toContain("No supported C++ build signal found");
  });

  it("rejects unknown project profiles", () => {
    expect(() => renderBootstrapScript("rust")).toThrow(
      'Unknown project profile "rust"',
    );
  });
});
