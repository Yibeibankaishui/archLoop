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
import type { RunHubFlowInput, RunHubFlowResult } from "./hubFlowExecution.js";
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
const mockRunHubFlow =
  vi.fn<(input: RunHubFlowInput) => Promise<RunHubFlowResult>>();

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

vi.mock("./hubFlowExecution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hubFlowExecution.js")>();
  return {
    ...actual,
    runHubFlow: (input: RunHubFlowInput) =>
      mockRunHubFlow.getMockImplementation()
        ? mockRunHubFlow(input)
        : actual.runHubFlow(input),
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

const setTerminalTtyState = (
  stdinIsTTY: boolean | undefined,
  stdoutIsTTY = stdinIsTTY,
) => {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: stdinIsTTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: stdoutIsTTY,
  });
};

const restoreXdgDataHome = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env.XDG_DATA_HOME;
    return;
  }
  process.env.XDG_DATA_HOME = value;
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
  let originalExitCode: typeof process.exitCode;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalStdinTTY = process.stdin.isTTY;
    originalStdoutTTY = process.stdout.isTTY;
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    originalExitCode = process.exitCode;

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
    setTerminalTtyState(false);

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
      setHubAgentRole(
        role,
        { provider: "cursor", model: "auto" },
        { env: process.env },
      );
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setTerminalTtyState(originalStdinTTY, originalStdoutTTY);
    restoreXdgDataHome(originalXdgDataHome);
    process.exitCode = originalExitCode;
    vi.clearAllMocks();
    mockSelect.mockReset();
    mockConfirm.mockReset();
    mockText.mockReset();
    mockRunHubProposalFlowFromCli.mockReset();
    mockHandlePrdDecompositionFlowDisplay.mockReset();
    mockHandleTriageProposalFlowDisplay.mockReset();
    mockRunHubFlow.mockReset();
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
        message: expect.stringContaining(
          "Hub flow found no ready tasks to run.",
        ),
      }),
    );
  });

  it("emits a plain lifecycle for a no-review run with nothing ready", async () => {
    const entries = await runCli([
      "run",
      "--flow",
      "no-review",
      "--output",
      "plain",
    ]);
    const plainMessages = entries.flatMap((entry) =>
      (entry as { readonly _tag: string })._tag === "plain"
        ? [(entry as { readonly message: string }).message]
        : [],
    );

    expect(entries).toHaveLength(4);
    expect(plainMessages).toHaveLength(4);
    expect(plainMessages[0]).toMatch(
      /^event=run_started hub_project="alpha" flow="no-review" run_id="run-[^"]+" logs="[^"]+"$/,
    );
    expect(plainMessages[1]).toMatch(
      /^event=batch_started run_id="run-[^"]+" batch_id="batch-[^"]+" stage="Planning"$/,
    );
    expect(plainMessages[2]).toMatch(
      /^event=batch_planned run_id="run-[^"]+" batch_id="batch-[^"]+" selected_tasks=\[\]$/,
    );
    expect(plainMessages[3]).toMatch(
      /^event=run_completed outcome="completed" summary="Nothing to run" completed=0 failed=0 blocked=0 skipped=0 ready_to_merge=0 completed_batches=0 run_id="run-[^"]+" logs="[^"]+"$/,
    );
    expect(process.exitCode).toBe(0);
    expect(plainMessages.join("\n")).not.toContain("no_ready_tasks");
    expect(plainMessages.join("\n")).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
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

  it("accepts a positional Hub project override", async () => {
    const betaRoot = resolveGitRepoRoot(repoBeta);
    const entries = await runCli(["run", "beta", "--flow", "no-review"]);

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
    const entries = await runCli(
      ["run", ".", "--flow", "with-review"],
      repoAlpha,
    );

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
    setTerminalTtyState(true);
    process.chdir(otherDir);

    try {
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
    } finally {
      process.chdir(originalCwd);
      setTerminalTtyState(originalTty.stdin, originalTty.stdout);
      restoreXdgDataHome(originalXdgDataHome);
    }
  });

  it("returns exit code 130 when the user cancels the run plan", async () => {
    setTerminalTtyState(true);
    mockConfirm.mockResolvedValue(false);

    const entries = await runCli(["run", "--flow", "no-review"]);

    expect(process.exitCode).toBe(130);
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        severity: "warn",
        message: "Run cancelled.",
      }),
    );
  });

  it("returns a nonzero exit code for a blocking plain run outcome", async () => {
    mockRunHubFlow.mockResolvedValue({
      flowId: "no-review",
      runId: "run-failed",
      batchId: "batch-failed",
      runDir: "/tmp/runs/run-failed",
      mode: "new_batch",
      completedBatchCount: 0,
      completedTaskCount: 0,
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-failed",
          selectedTaskIds: ["task-failed"],
          completedTaskCount: 0,
          batchStatus: "failed",
        },
      ],
      selectedTaskIds: ["task-failed"],
      results: [
        {
          taskId: "task-failed",
          title: "Failed task",
          branch: "archloop/task-failed",
          outcome: "agent_failed",
          hubStatus: "failed",
          failureReason: "agent_failed",
          failureStage: "implementation",
          diagnosticSummary: "agent exited non-zero",
          logPath: "/tmp/runs/run-failed/logs/task-failed.log",
          commitCount: 0,
        },
      ],
      unfinishedBatchIds: [],
      projectDevelopmentContractPath: "/tmp/contract.md",
      projectDevelopmentContractCreatedGenericFallback: false,
    });

    const entries = await runCli([
      "run",
      "--flow",
      "no-review",
      "--output",
      "plain",
    ]);
    const output = entries
      .flatMap((entry) => (entry._tag === "plain" ? [entry.message] : []))
      .join("\n");

    expect(process.exitCode).toBe(1);
    expect(output).toContain('event=task_attention run_id="run-failed"');
    expect(output).toContain('outcome="failed"');
  });

  it("renders a cancelled plain outcome when run execution aborts", async () => {
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-cancelled",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:00:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: join(
          process.env.XDG_DATA_HOME!,
          "archloop",
          "hub",
          "projects",
          "cancelled",
        ),
        eventId: "run-cancelled:1",
        sequence: 1,
      });
      const error = new Error("The run was cancelled");
      error.name = "AbortError";
      throw error;
    });

    const entries = await runCli([
      "run",
      "--flow",
      "no-review",
      "--output",
      "plain",
    ]);
    const output = entries
      .flatMap((entry) => (entry._tag === "plain" ? [entry.message] : []))
      .join("\n");

    expect(process.exitCode).toBe(130);
    expect(output).toContain(
      'event=run_completed outcome="cancelled" summary="Run cancelled"',
    );
    expect(output).toContain('run_id="run-cancelled"');
  });

  it("fails in non-interactive mode when flow is omitted", async () => {
    await expect(runCli(["run"])).rejects.toMatchObject({
      message:
        "No Hub flow was provided. Run `archloop run --flow <id>`, `archloop run <project-name> --flow <id>`, or `archloop run --project <name> --flow <id>`.",
    });
  });
});
