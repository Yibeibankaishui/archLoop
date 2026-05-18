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

  it("rejects unknown project profiles", () => {
    expect(() => renderBootstrapScript("node")).toThrow(
      'Unknown project profile "node"',
    );
  });
});
