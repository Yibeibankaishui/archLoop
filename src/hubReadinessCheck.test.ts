import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HUB_AGENT_ROLES, setHubAgentRole } from "./hubAgentConfig.js";
import {
  collectHubReadinessChecks,
  formatHubReadinessCheckLines,
  type HubProviderSmokeCheckRunner,
} from "./hubReadinessCheck.js";

const makeStore = async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "hub-readiness-check-"));
  const dataDir = join(homeDir, "xdg-data");
  await mkdir(dataDir, { recursive: true });
  return {
    homeDir,
    env: { ...process.env, XDG_DATA_HOME: dataDir },
  };
};

const createMockTool = async (binDir: string, name: string, script: string) => {
  await mkdir(binDir, { recursive: true });
  const toolPath = join(binDir, name);
  await writeFile(toolPath, script);
  await chmod(toolPath, 0o755);
  return toolPath;
};

const setCodexRoles = (env: NodeJS.ProcessEnv) => {
  for (const role of HUB_AGENT_ROLES) {
    const options =
      role === "planning" || role === "triage"
        ? { effort: "medium" }
        : { effort: "high" };
    setHubAgentRole(
      role,
      { provider: "codex", model: "gpt-5.4-mini", options },
      { env },
    );
  }
};

const makeSmokeRunner = (): {
  readonly runner: HubProviderSmokeCheckRunner;
  readonly calls: Array<{ provider: string; model: string; roles: string[] }>;
} => {
  const calls: Array<{ provider: string; model: string; roles: string[] }> = [];
  return {
    calls,
    runner: async (input) => {
      calls.push({
        provider: input.provider,
        model: input.model,
        roles: [...input.roles],
      });
      return "ARCHLOOP_SMOKE_OK";
    },
  };
};

describe("hubReadinessCheck", () => {
  it("reports missing Hub agent roles with repair guidance", async () => {
    const { env } = await makeStore();

    const report = await collectHubReadinessChecks({ env });
    const output = formatHubReadinessCheckLines(report).join("\n");

    expect(report.hasErrors).toBe(true);
    expect(report.hasWarnings).toBe(true);
    expect(output).toContain("Missing Hub agent role config");
    expect(output).toContain("Skipping unconfigured Hub agent roles");
    expect(output).toContain("Skipped provider/model smoke checks for:");
    expect(output).toContain("archloop agent-config init");
    expect(output).toContain(
      "archloop agent-config set-role planning --provider <provider> --model <model>",
    );
  });

  it("deduplicates smoke checks by provider, model, and options", async () => {
    const { env } = await makeStore();
    const binDir = join(env.XDG_DATA_HOME!, "bin");
    await createMockTool(
      binDir,
      "codex",
      '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"<smoke>ARCHLOOP_SMOKE_OK</smoke>"}}\'\n',
    );

    const storeEnv = {
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      OPENAI_KEY: "test-openai-key",
    };
    setCodexRoles(storeEnv);

    const smoke = makeSmokeRunner();
    const report = await collectHubReadinessChecks({
      env: storeEnv,
      smokeCheckRunner: smoke.runner,
    });
    const output = formatHubReadinessCheckLines(report).join("\n");

    expect(smoke.calls).toEqual([
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        roles: ["implementation", "merge", "recovery", "review"],
      },
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        roles: ["planning", "triage"],
      },
    ]);
    expect(report.hasErrors).toBe(false);
    expect(output).toContain("Checking provider/model smoke");
    expect(output).toContain(
      "Roles covered: implementation, merge, recovery, review.",
    );
    expect(output).toContain("Roles covered: planning, triage.");
    expect(output).toContain("effort=high");
    expect(output).toContain("effort=medium");
    expect(output).toContain("Smoke response token: ARCHLOOP_SMOKE_OK.");
  });

  it("skips unconfigured roles while still smoke checking configured groups", async () => {
    const { env } = await makeStore();
    const binDir = join(env.XDG_DATA_HOME!, "bin");
    await createMockTool(
      binDir,
      "codex",
      '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"<smoke>ARCHLOOP_SMOKE_OK</smoke>"}}\'\n',
    );

    const storeEnv = {
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      OPENAI_KEY: "test-openai-key",
    };
    setHubAgentRole(
      "planning",
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        options: { effort: "medium" },
      },
      { env: storeEnv },
    );

    const smoke = makeSmokeRunner();
    const report = await collectHubReadinessChecks({
      env: storeEnv,
      smokeCheckRunner: smoke.runner,
    });
    const output = formatHubReadinessCheckLines(report).join("\n");

    expect(smoke.calls).toEqual([
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        roles: ["planning"],
      },
    ]);
    expect(report.hasErrors).toBe(true);
    expect(report.hasWarnings).toBe(true);
    expect(output).toContain("Skipping unconfigured Hub agent roles");
    expect(output).toContain("triage, implementation, review, merge, recovery");
    expect(output).toContain("Roles covered: planning.");
  });

  it("formats provider/auth smoke failures with repair guidance", async () => {
    const { env } = await makeStore();
    const binDir = join(env.XDG_DATA_HOME!, "bin");
    await createMockTool(
      binDir,
      "codex",
      '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"error","message":"codex authentication required"}\'\nexit 1\n',
    );

    const storeEnv = {
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      OPENAI_KEY: "test-openai-key",
    };
    setHubAgentRole(
      "planning",
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        options: { effort: "medium" },
      },
      { env: storeEnv },
    );

    const report = await collectHubReadinessChecks({
      env: storeEnv,
      smokeCheckRunner: async () => {
        throw new Error("codex authentication required");
      },
    });
    const output = formatHubReadinessCheckLines(report).join("\n");

    expect(report.hasErrors).toBe(true);
    expect(output).toContain(
      "Provider/model smoke check failed for planning: codex / gpt-5.4-mini [effort=medium].",
    );
    expect(output).toContain("archloop env set OPENAI_KEY <value>");
    expect(output).toContain("archloop auth login codex");
    expect(output).toContain("Original error: codex authentication required");
  });
});
