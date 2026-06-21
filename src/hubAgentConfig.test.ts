import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyHubAgentRoleEntryToAllRoles,
  ensureHubAgentRolesConfigured,
  formatHubAgentConfigShowLines,
  formatMissingHubAgentRolesMessage,
  HUB_AGENT_ROLES,
  initHubAgentConfig,
  listMissingHubAgentRoles,
  readHubAgentConfig,
  resolveHubAgentConfigPath,
  resolveHubAgentRoleEntry,
  setHubAgentRole,
  validateHubAgentRoleEntry,
} from "./hubAgentConfig.js";

const tempHome = async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-agent-config-"));
  const dataDir = join(dir, "xdg-data");
  await mkdir(dataDir, { recursive: true });
  return { dir, dataDir, env: { XDG_DATA_HOME: dataDir } as NodeJS.ProcessEnv };
};

describe("hub agent config store", () => {
  it("resolves the config path under the archLoop user data directory", async () => {
    const { dataDir } = await tempHome();
    expect(resolveHubAgentConfigPath({ env: { XDG_DATA_HOME: dataDir } })).toBe(
      join(dataDir, "archloop", "hub", "agent-roles.json"),
    );
  });

  it("returns an empty config when the file is missing", async () => {
    const { env } = await tempHome();
    expect(readHubAgentConfig({ env })).toEqual({ roles: {} });
  });

  it("persists provider, model, and options for a supported role", async () => {
    const { env } = await tempHome();
    const { config } = setHubAgentRole(
      "planning",
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        options: { effort: "medium" },
      },
      { env },
    );

    expect(config.roles.planning).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: { effort: "medium" },
    });
    expect(readHubAgentConfig({ env })).toEqual(config);
  });

  it("rejects invalid roles", () => {
    expect(() =>
      validateHubAgentRoleEntry("invalid", {
        provider: "codex",
        model: "gpt-5.4-mini",
      }),
    ).toThrow(/invalid/i);
  });

  it("rejects unknown providers", () => {
    expect(() =>
      validateHubAgentRoleEntry("planning", {
        provider: "unknown-provider",
        model: "gpt-5.4-mini",
      }),
    ).toThrow(/provider/i);
  });

  it("rejects credential-like option keys", () => {
    expect(() =>
      validateHubAgentRoleEntry("planning", {
        provider: "codex",
        model: "gpt-5.4-mini",
        options: { api_key: "secret" },
      }),
    ).toThrow(/credential|api key|token/i);
  });

  it("reports missing roles clearly in show output", async () => {
    const { env } = await tempHome();
    setHubAgentRole("planning", { provider: "cursor", model: "auto" }, { env });

    const output = formatHubAgentConfigShowLines(readHubAgentConfig({ env }), {
      env,
    }).join("\n");
    expect(output).toContain("planning");
    expect(output).toContain("cursor");
    expect(output).toContain("auto");
    expect(output).toContain("missing");
    expect(output).toContain("triage");
  });

  it("lists all supported roles as missing from an empty config", () => {
    expect(listMissingHubAgentRoles({ roles: {} }, HUB_AGENT_ROLES)).toEqual([
      ...HUB_AGENT_ROLES,
    ]);
  });

  it("applies one provider/model entry to every Hub agent role", async () => {
    const { env } = await tempHome();
    const entry = { provider: "codex", model: "gpt-5.4-mini" };

    const config = applyHubAgentRoleEntryToAllRoles(entry, { env });

    for (const role of HUB_AGENT_ROLES) {
      expect(config.roles[role]).toEqual(entry);
    }
    expect(readHubAgentConfig({ env })).toEqual(config);
  });

  it("init wizard applies one entry to all roles when confirmed", async () => {
    const { env } = await tempHome();
    const configured: string[] = [];

    const config = await initHubAgentConfig({
      env,
      confirmApplyToAll: async () => true,
      configureRole: async (role) => {
        configured.push(role);
        return { provider: "cursor", model: "auto" };
      },
    });

    expect(configured).toEqual(["planning"]);
    for (const role of HUB_AGENT_ROLES) {
      expect(config.roles[role]).toEqual({
        provider: "cursor",
        model: "auto",
      });
    }
  });

  it("init wizard walks each role when apply-to-all is declined", async () => {
    const { env } = await tempHome();
    const configured: string[] = [];

    const config = await initHubAgentConfig({
      env,
      confirmApplyToAll: async () => false,
      configureRole: async (role) => {
        configured.push(role);
        return { provider: "codex", model: `model-for-${role}` };
      },
    });

    expect(configured).toEqual([...HUB_AGENT_ROLES]);
    for (const role of HUB_AGENT_ROLES) {
      expect(config.roles[role]).toEqual({
        provider: "codex",
        model: `model-for-${role}`,
      });
    }
  });

  it("resolveHubAgentRoleEntry uses explicit provider and model flags", async () => {
    const entry = await resolveHubAgentRoleEntry({
      role: "planning",
      provider: "codex",
      model: "gpt-5.4-mini",
      isTTY: false,
    });

    expect(entry).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("resolveHubAgentRoleEntry prompts when flags are omitted in a TTY", async () => {
    const entry = await resolveHubAgentRoleEntry({
      role: "review",
      isTTY: true,
      configureRole: async (role) => {
        expect(role).toBe("review");
        return { provider: "cursor", model: "auto" };
      },
    });

    expect(entry).toEqual({ provider: "cursor", model: "auto" });
  });

  it("resolveHubAgentRoleEntry fails clearly when flags are omitted non-interactively", async () => {
    await expect(
      resolveHubAgentRoleEntry({
        role: "merge",
        isTTY: false,
      }),
    ).rejects.toThrow(/non-interactive/i);

    await expect(
      resolveHubAgentRoleEntry({
        role: "merge",
        isTTY: false,
      }),
    ).rejects.toThrow(/archloop agent-config set-role merge/i);
  });

  it("resolveHubAgentRoleEntry rejects partial provider/model flags", async () => {
    await expect(
      resolveHubAgentRoleEntry({
        role: "planning",
        provider: "codex",
        isTTY: false,
      }),
    ).rejects.toThrow(/both --provider and --model/i);
  });

  it("fails non-interactive startup with an actionable missing-role message", async () => {
    const { env } = await tempHome();

    await expect(
      ensureHubAgentRolesConfigured({
        requiredRoles: ["planning", "triage"],
        env,
        interactive: false,
      }),
    ).rejects.toThrow(/archloop agent-config set-role planning/i);

    const message = formatMissingHubAgentRolesMessage(["planning", "triage"]);
    expect(message).toContain("planning");
    expect(message).toContain("triage");
    expect(message).toContain("archloop agent-config set-role");
  });

  it("uses a TTY configurator hook to fill missing roles", async () => {
    const { env } = await tempHome();
    const configured: string[] = [];

    const config = await ensureHubAgentRolesConfigured({
      requiredRoles: ["planning"],
      env,
      interactive: true,
      configureRole: async (role) => {
        configured.push(role);
        return { provider: "codex", model: "gpt-5.4-mini" };
      },
    });

    expect(configured).toEqual(["planning"]);
    expect(config.roles.planning).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
    expect(readHubAgentConfig({ env }).roles.planning).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("does not persist credential fields when reading manually edited config", async () => {
    const { env, dataDir } = await tempHome();
    const configPath = resolveHubAgentConfigPath({ env });
    await mkdir(join(dataDir, "archloop", "hub"), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          roles: {
            planning: {
              provider: "codex",
              model: "gpt-5.4-mini",
              apiKey: "should-not-remain",
              options: { token: "nope" },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    expect(() => readHubAgentConfig({ env })).toThrow(
      /credential|token|api key/i,
    );
  });
});
