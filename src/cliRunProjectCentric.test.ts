import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { exec } from "node:child_process";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { HUB_AGENT_ROLES, setHubAgentRole } from "./hubAgentConfig.js";
import {
  registerHubProject,
  resolveHubProjectSelectionPath,
  selectHubProject,
} from "./hubProjectRegistry.js";
import { initHubTaskStore } from "./hubTaskStore.js";
import { resolveGitRepoRoot } from "./projectStatus.js";

const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockText = vi.fn();
const mockRunHubProposalFlowFromCli = vi.fn();
const mockHandlePrdDecompositionFlowDisplay = vi.fn();
const mockHandleTriageProposalFlowDisplay = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    select: (...args: unknown[]) => mockSelect(...args),
    confirm: (...args: unknown[]) => mockConfirm(...args),
    text: (...args: unknown[]) => mockText(...args),
  };
});

vi.mock("./hubProposalFlowCli.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runHubProposalFlowFromCli: (...args: unknown[]) =>
      mockRunHubProposalFlowFromCli(...args),
    handlePrdDecompositionFlowDisplay: (...args: unknown[]) =>
      mockHandlePrdDecompositionFlowDisplay(...args),
    handleTriageProposalFlowDisplay: (...args: unknown[]) =>
      mockHandleTriageProposalFlowDisplay(...args),
  };
});

vi.setConfig({ hookTimeout: 60_000, testTimeout: 120_000 });

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const runCli = async (args: string[], cwd = process.cwd()) => {
  const { cli } = await import("./cli.js");
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli(["node", "archloop", ...args]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
        return yield* Ref.get(ref);
      }),
    );
  } finally {
    process.chdir(originalCwd);
  }
};

describe("archloop run project targeting", () => {
  let hostDir: string;
  let otherDir: string;
  let repoAlpha: string;
  let repoBeta: string;
  let originalCwd: string;
  let originalStdinTTY: boolean | undefined;
  let originalStdoutTTY: boolean | undefined;
  let originalXdgDataHome: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalStdinTTY = process.stdin.isTTY;
    originalStdoutTTY = process.stdout.isTTY;
    originalXdgDataHome = process.env.XDG_DATA_HOME;

    hostDir = await mkdtemp(join(tmpdir(), "cli-run-target-"));
    otherDir = await mkdtemp(join(tmpdir(), "cli-run-other-"));
    repoAlpha = join(hostDir, "repo-alpha");
    repoBeta = join(hostDir, "repo-beta");

    await mkdir(repoAlpha, { recursive: true });
    await mkdir(repoBeta, { recursive: true });
    await initRepo(repoAlpha);
    await initRepo(repoBeta);
    await commitFile(repoAlpha, "alpha.txt", "alpha", "initial alpha");
    await commitFile(repoBeta, "beta.txt", "beta", "initial beta");

    process.env.XDG_DATA_HOME = join(hostDir, "xdg-data");
    process.chdir(otherDir);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    const repoAlphaRoot = resolveGitRepoRoot(repoAlpha);
    const repoBetaRoot = resolveGitRepoRoot(repoBeta);
    initHubTaskStore(repoAlphaRoot);
    initHubTaskStore(repoBetaRoot);

    registerHubProject({
      repoPath: repoAlphaRoot,
      projectName: "alpha",
      env: process.env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    registerHubProject({
      repoPath: repoBetaRoot,
      projectName: "beta",
      env: process.env,
      now: new Date("2026-07-04T12:01:00.000Z"),
    });
    selectHubProject({
      projectSelector: "alpha",
      env: process.env,
      now: new Date("2026-07-04T12:02:00.000Z"),
    });

    for (const role of HUB_AGENT_ROLES) {
      setHubAgentRole(role, { provider: "cursor", model: "auto" }, { env: process.env });
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinTTY,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutTTY,
    });
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    vi.clearAllMocks();
    mockSelect.mockReset();
    mockConfirm.mockReset();
    mockText.mockReset();
    mockRunHubProposalFlowFromCli.mockReset();
    mockHandlePrdDecompositionFlowDisplay.mockReset();
    mockHandleTriageProposalFlowDisplay.mockReset();
  });

  it("uses the selected Hub project from any directory", async () => {
    const alphaRoot = resolveGitRepoRoot(repoAlpha);
    const entries = await runCli(["run", "--flow", "no-review"]);

    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "summary",
        title: "Hub run plan",
        rows: expect.objectContaining({
          "Hub project": "alpha",
          "Hub flow": "no-review",
          "Repository root": alphaRoot,
        }),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        severity: "info",
        message: expect.stringContaining("Hub flow found no ready tasks to run."),
      }),
    );
  });

  it("honors an explicit Hub project override", async () => {
    const betaRoot = resolveGitRepoRoot(repoBeta);
    const entries = await runCli([
      "run",
      "--project",
      "beta",
      "--flow",
      "no-review",
    ]);

    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "summary",
        title: "Hub run plan",
        rows: expect.objectContaining({
          "Hub project": "beta",
          "Hub flow": "no-review",
          "Repository root": betaRoot,
        }),
      }),
    );
  });

  it("keeps legacy path targets working with guidance", async () => {
    const alphaRoot = resolveGitRepoRoot(repoAlpha);
    const entries = await runCli(["run", ".", "--flow", "with-review"], repoAlpha);

    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        severity: "warn",
        message: expect.stringContaining("Legacy path target detected."),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "summary",
        title: "Hub run plan",
        rows: expect.objectContaining({
          "Legacy path target": ".",
          "Repository root": alphaRoot,
          "Hub flow": "with-review",
        }),
      }),
    );
  });

  it("opens the interactive project, flow, and input wizard in TTYs", async () => {
    const wizardHostDir = await mkdtemp(join(tmpdir(), "cli-run-wizard-"));
    const wizardDataDir = join(wizardHostDir, "xdg-data");
    const originalTty = {
      stdin: process.stdin.isTTY,
      stdout: process.stdout.isTTY,
    };
    const originalCwd = process.cwd();
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = wizardDataDir;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    process.chdir(otherDir);

    mockSelect.mockImplementation(async (opts: { message: string }) => {
      if (opts.message === "Select a Hub project:") {
        return "beta";
      }
      if (opts.message === "Select a Hub flow:") {
        return "prd-decomposition";
      }
      throw new Error(`Unexpected select prompt: ${opts.message}`);
    });
    mockText.mockImplementation(async (opts: { message: string }) => {
      if (opts.message === "PRD file path") {
        return "docs/prd/example.md";
      }
      throw new Error(`Unexpected text prompt: ${opts.message}`);
    });
    mockConfirm.mockImplementation(async (opts: { message: string }) => {
      if (opts.message === "Run this Hub flow now?") {
        return true;
      }
      throw new Error(`Unexpected confirm prompt: ${opts.message}`);
    });
    mockRunHubProposalFlowFromCli.mockResolvedValue({
      flowId: "prd-decomposition",
      result: { outcome: "cancelled", phase: "approval" },
    });
    mockHandlePrdDecompositionFlowDisplay.mockReturnValue(Effect.void);
    mockHandleTriageProposalFlowDisplay.mockReturnValue(Effect.void);

    const repoAlphaRoot = resolveGitRepoRoot(repoAlpha);
    const repoBetaRoot = resolveGitRepoRoot(repoBeta);
    await mkdir(join(repoBeta, "docs", "prd"), { recursive: true });
    await writeFile(
      join(repoBeta, "docs", "prd", "example.md"),
      "# Example PRD\n",
    );
    registerHubProject({
      repoPath: repoAlphaRoot,
      projectName: "alpha",
      env: process.env,
      now: new Date("2026-07-04T12:03:00.000Z"),
    });
    registerHubProject({
      repoPath: repoBetaRoot,
      projectName: "beta",
      env: process.env,
      now: new Date("2026-07-04T12:04:00.000Z"),
    });
    await unlink(resolveHubProjectSelectionPath({ env: process.env }));

    const entries = await runCli(["run"]);

    expect(mockSelect).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select a Hub project:" }),
    );
    expect(mockSelect).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select a Hub flow:" }),
    );
    expect(mockText).toHaveBeenCalledWith(
      expect.objectContaining({ message: "PRD file path" }),
    );
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Run this Hub flow now?" }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "summary",
        title: "Hub run plan",
        rows: expect.objectContaining({
          "Hub project": "beta",
          "Hub flow": "prd-decomposition",
          "Repository root": repoBetaRoot,
          "Flow input": expect.stringContaining("docs/prd/example.md"),
        }),
      }),
    );

    process.chdir(originalCwd);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalTty.stdin,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalTty.stdout,
    });
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
  });

  it("fails in non-interactive mode when flow is omitted", async () => {
    await expect(runCli(["run"])).rejects.toMatchObject({
      message:
        "No Hub flow was provided. Run `archloop run --flow <id>`, `archloop run <project-name> --flow <id>`, or `archloop run --project <name> --flow <id>`.",
    });
  });
});
