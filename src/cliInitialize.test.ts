import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SilentDisplay, type DisplayEntry } from "./Display.js";
import {
  resolveHubProjectRegistryPath,
  resolveHubProjectSelectionPath,
} from "./hubProjectRegistry.js";

const mockPromptInitializeHubAgentConfig = vi.fn();
const mockPromptInitializeHubEnv = vi.fn();
const mockCollectHubReadinessChecks = vi.fn();
const mockFormatHubReadinessCheckLines = vi.fn();
const mockFormatHubAuthShowLines = vi.fn();

vi.mock("./hubAgentConfigPrompt.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promptInitializeHubAgentConfig: (...args: unknown[]) =>
      mockPromptInitializeHubAgentConfig(...args),
  };
});

vi.mock("./hubEnvPrompt.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promptInitializeHubEnv: (...args: unknown[]) =>
      mockPromptInitializeHubEnv(...args),
  };
});

vi.mock("./hubReadinessCheck.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    collectHubReadinessChecks: (...args: unknown[]) =>
      mockCollectHubReadinessChecks(...args),
    formatHubReadinessCheckLines: (...args: unknown[]) =>
      mockFormatHubReadinessCheckLines(...args),
  };
});

vi.mock("./hubAuth.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    formatHubAuthShowLines: (...args: unknown[]) =>
      mockFormatHubAuthShowLines(...args),
  };
});

import { cli } from "./cli.js";

describe("archloop initialize", () => {
  let hostDir: string;
  let dataDir: string;
  let originalXdgDataHome: string | undefined;
  let originalTtyState: {
    stdin: boolean | undefined;
    stdout: boolean | undefined;
  };

  beforeEach(async () => {
    hostDir = await mkdtemp(join(tmpdir(), "cli-initialize-host-"));
    dataDir = join(hostDir, "xdg-data");
    await mkdir(dataDir, { recursive: true });
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    originalTtyState = {
      stdin: process.stdin.isTTY,
      stdout: process.stdout.isTTY,
    };
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    mockPromptInitializeHubAgentConfig.mockResolvedValue(undefined);
    mockPromptInitializeHubEnv.mockResolvedValue(undefined);
    mockCollectHubReadinessChecks.mockResolvedValue({
      sections: [{ title: "Checking Hub agent roles", findings: [] }],
      hasWarnings: false,
      hasErrors: false,
    });
    mockFormatHubReadinessCheckLines.mockReturnValue([
      "Hub readiness check",
      "",
      "Checking Hub agent roles",
      "  SUCCESS: Hub agent roles",
      "    All required Hub agent roles are configured and validated.",
      "",
      "Hub readiness check passed.",
    ]);
    mockFormatHubAuthShowLines.mockReturnValue([
      "Hub auth directory: /tmp/archloop/hub/auth",
      "",
      "  codex: missing",
      "    Login: archloop auth login codex",
    ]);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalTtyState.stdin,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalTtyState.stdout,
    });

    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    vi.clearAllMocks();
  });

  const runInitialize = async (args: string) => {
    const ref = await Effect.runPromise(
      Ref.make<ReadonlyArray<DisplayEntry>>([]),
    );
    await Effect.runPromise(
      cli(["node", "archloop", ...args.trim().split(/\s+/)]).pipe(
        Effect.provide(SilentDisplay.layer(ref)),
        Effect.provide(NodeContext.layer),
      ),
    );
    return Effect.runPromise(Ref.get(ref));
  };

  it("runs shared Hub setup, the default quick check, and ends with project add", async () => {
    const entries = await runInitialize("initialize");

    expect(mockPromptInitializeHubAgentConfig).toHaveBeenCalledOnce();
    expect(mockPromptInitializeHubEnv).toHaveBeenCalledOnce();
    expect(mockCollectHubReadinessChecks).toHaveBeenCalledOnce();
    expect(mockFormatHubAuthShowLines).toHaveBeenCalledOnce();
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message:
          "Quick Hub check may make a small provider/model call. Run `archloop initialize --skip-check` to skip it.",
      }),
    );
    expect(entries.at(-1)).toEqual({
      _tag: "text",
      message: "archloop project add",
    });
    await expect(
      access(resolveHubProjectRegistryPath({ env: process.env })),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(resolveHubProjectSelectionPath({ env: process.env })),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips the quick check when requested", async () => {
    const entries = await runInitialize("initialize --skip-check");

    expect(mockPromptInitializeHubAgentConfig).toHaveBeenCalledOnce();
    expect(mockPromptInitializeHubEnv).toHaveBeenCalledOnce();
    expect(mockCollectHubReadinessChecks).not.toHaveBeenCalled();
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        severity: "info",
        message: "Skipped the quick Hub check.",
      }),
    );
    expect(entries.at(-1)).toEqual({
      _tag: "text",
      message: "archloop project add",
    });
  });

  it("surfaces quick check failures before the project add next step", async () => {
    mockCollectHubReadinessChecks.mockResolvedValueOnce({
      sections: [{ title: "Checking Hub agent roles", findings: [] }],
      hasWarnings: false,
      hasErrors: true,
    });
    mockFormatHubReadinessCheckLines.mockReturnValueOnce([
      "Hub readiness check",
      "",
      "Checking Hub agent roles",
      "  ERROR: Missing Hub agent roles",
      "    Configure the required roles before running this flow.",
      "",
      "Hub readiness check failed.",
    ]);

    const ref = await Effect.runPromise(
      Ref.make<ReadonlyArray<DisplayEntry>>([]),
    );

    await expect(
      Effect.runPromise(
        cli(["node", "archloop", "initialize"]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        ),
      ),
    ).rejects.toThrow(/Hub readiness check failed/);

    const entries = await Effect.runPromise(Ref.get(ref));
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: "Hub readiness check failed.",
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: "archloop project add",
      }),
    );
  });
});
