import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHubProposalAgentInvoker,
  resolveHubAgentProvider,
} from "./hubProposalAgent.js";

describe("resolveHubAgentProvider", () => {
  it("passes claude-code effort options from Hub role config", () => {
    const provider = resolveHubAgentProvider({
      provider: "claude-code",
      model: "claude-opus-4-6",
      options: { effort: "high" },
    });

    expect(
      provider.buildPrintCommand({
        prompt: "test",
        dangerouslySkipPermissions: true,
      }).command,
    ).toContain("--effort high");
  });
});

describe("createHubProposalAgentInvoker", () => {
  let originalXdgDataHome: string | undefined;
  let originalCursorApiKey: string | undefined;

  beforeEach(async () => {
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    originalCursorApiKey = process.env.CURSOR_API_KEY;
    process.env.XDG_DATA_HOME = await mkdtemp(
      join(tmpdir(), "hub-proposal-xdg-"),
    );
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalCursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = originalCursorApiKey;
  });

  it("fails fast with archloop env guidance when credentials are missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-proposal-preflight-"));
    const invoker = createHubProposalAgentInvoker({
      cwd,
      roleEntry: {
        provider: "cursor",
        model: "auto",
      },
      env: { ...process.env, CURSOR_API_KEY: "" },
    });

    await expect(
      invoker({
        flowId: "test-flow",
        phase: "draft",
        prompt: "test prompt",
        transcript: [],
        preparedContext: {},
        runDir: cwd,
      }),
    ).rejects.toThrow(/archloop env init/);
  });
});
