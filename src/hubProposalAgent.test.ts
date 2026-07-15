import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHubProposalAgentInvoker,
  resolveHubAgentProvider,
} from "./hubProposalAgent.js";

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock("./run.js", () => ({ run: runMock }));

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
    runMock.mockReset();
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

  it("suppresses direct startup output from the proposal agent run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-proposal-startup-"));
    const env = { ...process.env, CURSOR_API_KEY: "test-key" };
    runMock.mockResolvedValue({ stdout: "proposal response" });
    const abortController = new AbortController();
    const invoker = createHubProposalAgentInvoker({
      cwd,
      roleEntry: {
        provider: "cursor",
        model: "auto",
      },
      env,
      signal: abortController.signal,
    });

    await invoker({
      flowId: "test-flow",
      phase: "draft",
      prompt: "test prompt",
      transcript: [],
      preparedContext: {},
      runDir: cwd,
    });

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: abortController.signal,
        logging: expect.objectContaining({
          type: "file",
          showStartup: false,
        }),
      }),
    );
  });
});
