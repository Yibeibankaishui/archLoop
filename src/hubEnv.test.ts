import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectHubEnvKeysForAgentConfig,
  ensureHubEnvFile,
  formatHubEnvShowLines,
  mergeHubAndProjectEnv,
  readHubEnvFile,
  resolveHubEnv,
  resolveHubEnvPath,
  upsertHubEnvKey,
  writeHubEnvFile,
} from "./hubEnv.js";
import { readHubAgentConfig, setHubAgentRole } from "./hubAgentConfig.js";

const makeStore = async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "hub-env-test-"));
  const dataDir = join(homeDir, "xdg-data");
  await mkdir(dataDir, { recursive: true });
  const env = { ...process.env, XDG_DATA_HOME: dataDir };
  return { homeDir, dataDir, env };
};

describe("hubEnv", () => {
  it("resolves Hub env path under the archLoop user data directory", async () => {
    const { dataDir, env } = await makeStore();
    expect(resolveHubEnvPath({ env })).toBe(join(dataDir, "archloop", ".env"));
  });

  it("creates a default Hub env template on first use", async () => {
    const { env } = await makeStore();
    const { created, path } = ensureHubEnvFile({ env });
    expect(created).toBe(true);
    expect(readHubEnvFile({ env })).toMatchObject({
      CURSOR_API_KEY: "",
      GH_TOKEN: "",
    });
    expect(path).toContain(".env");
  });

  it("lets process.env override Hub file values", async () => {
    const { env } = await makeStore();
    writeHubEnvFile({ CURSOR_API_KEY: "hub-key" }, { env });

    const orig = process.env.CURSOR_API_KEY;
    try {
      process.env.CURSOR_API_KEY = "runtime-key";
      expect(
        resolveHubEnv({ env: { ...env, CURSOR_API_KEY: "runtime-key" } })
          .CURSOR_API_KEY,
      ).toBe("runtime-key");
    } finally {
      if (orig === undefined) {
        delete process.env.CURSOR_API_KEY;
      } else {
        process.env.CURSOR_API_KEY = orig;
      }
    }
  });

  it("merges project env ahead of Hub env for shared keys", () => {
    const merged = mergeHubAndProjectEnv({
      hubFileEnv: { CURSOR_API_KEY: "hub-key", GH_TOKEN: "hub-gh" },
      projectFileEnv: { CURSOR_API_KEY: "project-key" },
      runtimeEnv: {},
    });
    expect(merged).toEqual({
      CURSOR_API_KEY: "project-key",
      GH_TOKEN: "hub-gh",
    });
  });

  it("falls back from empty project values to process.env then Hub", () => {
    const merged = mergeHubAndProjectEnv({
      hubFileEnv: { CURSOR_API_KEY: "hub-key" },
      projectFileEnv: { CURSOR_API_KEY: "" },
      runtimeEnv: { CURSOR_API_KEY: "runtime-key" },
    });
    expect(merged.CURSOR_API_KEY).toBe("runtime-key");
  });

  it("collects provider env keys from configured Hub agent roles", async () => {
    const { env } = await makeStore();
    setHubAgentRole("planning", { provider: "cursor", model: "auto" }, { env });
    setHubAgentRole(
      "implementation",
      { provider: "codex", model: "gpt-5.4-mini" },
      { env },
    );

    expect(
      collectHubEnvKeysForAgentConfig(readHubAgentConfig({ env })),
    ).toEqual(["CURSOR_API_KEY", "OPENAI_KEY"]);
  });

  it("upserts a single Hub env key", async () => {
    const { env } = await makeStore();
    upsertHubEnvKey("CURSOR_API_KEY", "saved-key", { env });
    expect(readHubEnvFile({ env }).CURSOR_API_KEY).toBe("saved-key");
  });

  it("shows acquisition hints for empty known keys", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "hub-env-show-hints-"));
    const dataDir = join(homeDir, "xdg-data");
    await mkdir(dataDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: dataDir };
    ensureHubEnvFile({ env });
    writeHubEnvFile({ CURSOR_API_KEY: "saved-key" }, { env });

    const lines = formatHubEnvShowLines({ env });
    const joined = lines.join("\n");
    expect(joined).toContain("CURSOR_API_KEY");
    expect(joined).not.toMatch(/CURSOR_API_KEY:.*\n\s+hint:/);
    expect(joined).toMatch(/OPENAI_KEY: \(empty\)/);
    expect(joined).toMatch(/hint:.*OpenAI API/);
    expect(joined).toMatch(/https:\/\/platform\.openai\.com\/api-keys/);
    expect(joined).toContain(
      "Run `archloop env init` for guided credential setup.",
    );
  });

  it("treats placeholder undefined and null strings as empty values", async () => {
    const { env } = await makeStore();
    writeHubEnvFile(
      {
        OPENAI_KEY: "undefined",
        ANTHROPIC_API_KEY: " null ",
        GH_TOKEN: "real-token",
      },
      { env },
    );

    expect(readHubEnvFile({ env })).toMatchObject({
      OPENAI_KEY: "",
      ANTHROPIC_API_KEY: "",
      GH_TOKEN: "real-token",
    });
    expect(resolveHubEnv({ env })).toEqual({ GH_TOKEN: "real-token" });

    const merged = mergeHubAndProjectEnv({
      hubFileEnv: { OPENAI_KEY: "undefined" },
      projectFileEnv: { OPENAI_KEY: "null" },
      runtimeEnv: { OPENAI_KEY: "undefined" },
    });
    expect(merged).toEqual({});

    const lines = formatHubEnvShowLines({ env }).join("\n");
    expect(lines).toMatch(/OPENAI_KEY: \(empty\)/);
    expect(lines).toMatch(/ANTHROPIC_API_KEY: \(empty\)/);
    expect(lines).not.toContain("undefined");
  });
});
