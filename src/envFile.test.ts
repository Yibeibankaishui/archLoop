import { describe, expect, it } from "vitest";

import {
  maskEnvValue,
  parseEnvFileContent,
  serializeEnvFile,
} from "./envFile.js";

describe("envFile", () => {
  it("parses env file content", () => {
    expect(
      parseEnvFileContent(`# comment\nCURSOR_API_KEY="abc"\nGH_TOKEN=\n`),
    ).toEqual({
      CURSOR_API_KEY: "abc",
      GH_TOKEN: "",
    });
  });

  it("serializes env files with headers", () => {
    expect(serializeEnvFile({ CURSOR_API_KEY: "abc" }, ["# header"])).toBe(
      "# header\n\nCURSOR_API_KEY=abc\n",
    );
  });

  it("masks credential-like values", () => {
    expect(maskEnvValue("CURSOR_API_KEY", "sk-1234567890")).toContain("sk-1");
    expect(maskEnvValue("PLAIN", "visible")).toBe("visible");
  });
});
