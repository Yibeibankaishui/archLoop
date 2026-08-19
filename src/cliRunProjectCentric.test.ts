import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { exec } from "node:child_process";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClackDisplay, SilentDisplay, type DisplayEntry } from "./Display.js";
import { HUB_AGENT_ROLES, setHubAgentRole } from "./hubAgentConfig.js";
import type { RunHubFlowInput, RunHubFlowResult } from "./hubFlowExecution.js";
import {
  readHubProjectRegistry,
  registerHubProject,
  resolveHubProjectSelectionPath,
  selectHubProject,
} from "./hubProjectRegistry.js";
import {
  resolveArchloopUserDataDir,
  resolveGitRepoRoot,
  resolveHubProjectDir,
} from "./projectStatus.js";

const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockText = vi.fn();
const mockWaitForKeypress = vi.fn();
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

vi.mock("./keypress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keypress.js")>();
  return {
    ...actual,
    waitForKeypress: (...args: unknown[]) => mockWaitForKeypress(...args),
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

const runCliWithTerminalDisplay = async (
  args: string[],
  cwd = process.cwd(),
): Promise<readonly string[]> => {
  const { cli } = await import("./cli.js");
  const lines: string[] = [];
  const directWrites: string[] = [];
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    directWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    await Effect.runPromise(
      cli(["node", "archloop", ...args]).pipe(
        Effect.provide(ClackDisplay.layer),
        Effect.provide(NodeContext.layer),
      ),
    );
    expect(directWrites).toEqual([]);
    return lines;
  } finally {
    process.chdir(originalCwd);
    log.mockRestore();
    write.mockRestore();
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

const setStdoutColumns = (columns: number | undefined) => {
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
};

const setStdoutRows = (rows: number | undefined) => {
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: rows,
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
  let originalStdoutRows: number | undefined;
  let originalXdgDataHome: string | undefined;
  let originalExitCode: typeof process.exitCode;

  beforeEach(async () => {
    mockWaitForKeypress.mockReset();
    mockWaitForKeypress.mockResolvedValue("start");
    mockSelect.mockReset();
    mockConfirm.mockReset();
    mockText.mockReset();
    mockWaitForKeypress.mockReset();
    mockWaitForKeypress.mockResolvedValue("start");
    mockRunHubProposalFlowFromCli.mockReset();
    mockHandlePrdDecompositionFlowDisplay.mockReset();
    mockHandleTriageProposalFlowDisplay.mockReset();
    mockRunHubFlow.mockReset();

    originalCwd = process.cwd();
    originalStdinTTY = process.stdin.isTTY;
    originalStdoutTTY = process.stdout.isTTY;
    originalStdoutRows = process.stdout.rows;
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
    setStdoutRows(24);

    const repoAlphaRoot = resolveGitRepoRoot(repoAlpha);
    const repoBetaRoot = resolveGitRepoRoot(repoBeta);

    registerHubProject({
      repoPath: repoAlphaRoot,
      projectName: "alpha",
      env: process.env,
      initializeTaskStore: true,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    registerHubProject({
      repoPath: repoBetaRoot,
      projectName: "beta",
      env: process.env,
      initializeTaskStore: true,
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
    setStdoutRows(originalStdoutRows);
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
    const entries = await runCli(["run", "--flow", "no-review"]);
    const lines = entries.map((entry) => {
      expect(entry._tag).toBe("plain");
      return (entry as { readonly message: string }).message;
    });

    expect(lines[0]).toMatch(
      /^event=run_started hub_project="alpha" flow="no-review"/,
    );
    expect(lines.at(-1)).toContain('summary="Nothing to run"');
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

  it("defaults redirected task-board output to deterministic plain lines", async () => {
    const entries = await runCli(["run", "--flow", "no-review"]);
    const lines = entries.map((entry) => {
      expect(entry._tag).toBe("plain");
      return (entry as { readonly message: string }).message;
    });

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(
      /^event=run_started hub_project="alpha" flow="no-review"/,
    );
    expect(lines.at(-1)).toContain('outcome="completed"');
    expect(lines.join("\n")).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
  });

  it("defaults a capable TTY task-board run to bounded live output", async () => {
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockWaitForKeypress.mockResolvedValue("start");

    try {
      await runCli(["run", "--flow", "no-review"]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const output = chunks.join("");
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockWaitForKeypress).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 3000 }),
    );
    expect(output).toContain("archLoop");
    expect(output).toContain("alpha · no-review");
    expect(output).toContain("Nothing to run");
    expect(output).toContain("\x1b[?25h");
    expect(output).not.toContain("Nothing to run...");
    expect(output).not.toContain("\x1b[1A");
  });

  it("does not prompt for run-plan confirmation with --yes in an auto TTY", async () => {
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockWaitForKeypress.mockResolvedValue("cancel");

    try {
      await runCli(["run", "--flow", "no-review", "--yes"]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockWaitForKeypress).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(chunks.join("")).toContain("Nothing to run");
  });

  it("keeps auto live output active without color cues", async () => {
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockConfirm.mockResolvedValue(true);

    try {
      await runCli([
        "run",
        "--flow",
        "no-review",
        "--output",
        "auto",
        "--no-color",
      ]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const output = chunks.join("");
    expect(output).toContain("Nothing to run");
    expect(output).toContain("\x1b[?25h");
    expect(output).not.toMatch(/\x1b\[(?:3\d|9\d)m/);
    expect(output).not.toContain("\x1b[1A");
  });

  it("falls back to plain without prompting in CI", async () => {
    const originalCi = process.env.CI;
    const originalTerm = process.env.TERM;
    const originalColumns = process.stdout.columns;
    process.env.CI = "true";
    process.env.TERM = "xterm-256color";
    setTerminalTtyState(true);
    setStdoutColumns(120);

    try {
      const entries = await runCli(["run", "--flow", "no-review"]);
      expect(entries).toHaveLength(4);
      expect(entries.every((entry) => entry._tag === "plain")).toBe(true);
      expect(mockConfirm).not.toHaveBeenCalled();
    } finally {
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
      setStdoutColumns(originalColumns);
    }
  });

  it("keeps append-only live output when the terminal resizes narrower", async () => {
    const resizeListenerCountBeforeRun = process.stdout.listenerCount("resize");
    let resizeListenerCountDuringRun = -1;
    mockRunHubFlow.mockImplementation(async (input) => {
      const runId = "run-resize-live";
      const batchId = "batch-resize-live";
      const hubProjectDir = join(
        process.env.XDG_DATA_HOME!,
        "archloop",
        "hub",
        "projects",
        "resize-live",
      );
      input.onEvent?.({
        type: "run_started",
        runId,
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:40:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir,
        eventId: `${runId}:1`,
        sequence: 1,
      });
      setStdoutColumns(39);
      process.stdout.emit("resize");
      resizeListenerCountDuringRun = process.stdout.listenerCount("resize");
      return {
        flowId: "no-review",
        runId,
        batchId,
        runDir: join(hubProjectDir, "runs", runId),
        mode: "new_batch",
        completedBatchCount: 0,
        completedTaskCount: 0,
        stopReason: "no_ready_tasks",
        batchResults: [],
        selectedTaskIds: [],
        results: [],
        unfinishedBatchIds: [],
        projectDevelopmentContractPath: "/tmp/contract.md",
        projectDevelopmentContractCreatedGenericFallback: false,
      };
    });
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockWaitForKeypress.mockResolvedValue("start");

    let entries: readonly DisplayEntry[] = [];
    try {
      entries = await runCli(["run", "--flow", "no-review"]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    // ADR-0032: narrow resize stays on append-only live sections (no plain fallback).
    expect(entries.filter((entry) => entry._tag === "plain")).toHaveLength(0);
    expect(entries.some((entry) => entry._tag === "section")).toBe(true);
    expect(chunks.join("")).toContain("archLoop");
    expect(resizeListenerCountDuringRun).toBeGreaterThan(
      resizeListenerCountBeforeRun,
    );
  });

  it("falls back to the complete plain lifecycle when a live write fails", async () => {
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const chunks: string[] = [];
    let failNextWrite = true;
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        const text = String(chunk);
        if (failNextWrite) {
          failNextWrite = false;
          chunks.push(text.slice(0, "\x1b[?25l".length));
          throw new Error("simulated terminal write failure");
        }
        chunks.push(text);
        return true;
      });
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockConfirm.mockResolvedValue(true);

    let entries: readonly DisplayEntry[] = [];
    try {
      entries = await runCli(["run", "--flow", "no-review"]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const plainLines = entries.flatMap((entry) =>
      entry._tag === "plain" ? [entry.message] : [],
    );
    expect(plainLines.map((line) => line.match(/^event=([^ ]+)/)?.[1])).toEqual(
      ["run_started", "batch_started", "batch_planned", "run_completed"],
    );
    expect(process.exitCode).toBe(0);
    expect(chunks.join("")).toContain("\x1b[?25h");
  });

  it("falls back to a plain outcome when the final live write fails", async () => {
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    let failedFinalWrite = false;
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        const text = String(chunk);
        if (!failedFinalWrite && text.includes("Nothing to run")) {
          failedFinalWrite = true;
          throw new Error("simulated final terminal write failure");
        }
        return true;
      });
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockConfirm.mockResolvedValue(true);

    let entries: readonly DisplayEntry[] = [];
    try {
      entries = await runCli(["run", "--flow", "no-review"]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const plainLines = entries.flatMap((entry) =>
      entry._tag === "plain" ? [entry.message] : [],
    );
    expect(failedFinalWrite).toBe(true);
    expect(plainLines.map((line) => line.match(/^event=([^ ]+)/)?.[1])).toEqual(
      ["run_started", "batch_started", "batch_planned", "run_completed"],
    );
    expect(process.exitCode).toBe(0);
  });

  it("emits stdout-pure JSONL for a no-review run with nothing ready", async () => {
    const entries = await runCli([
      "run",
      "--flow",
      "no-review",
      "--output",
      "json",
    ]);
    const lines = entries.map((entry) => {
      expect(entry._tag).toBe("plain");
      return (entry as { readonly message: string }).message;
    });
    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );

    expect(records).toHaveLength(4);
    expect(records.map((record) => record.type)).toEqual([
      "run_started",
      "batch_started",
      "batch_planned",
      "run_completed",
    ]);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      hubProject: "alpha",
      flowId: "no-review",
    });
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 1,
      type: "run_completed",
      flowId: "no-review",
      outcome: "completed",
      summary: "Nothing to run",
      counts: {
        completed: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
        readyToMerge: 0,
      },
      completedBatchCount: 0,
      stopReason: "no_ready_tasks",
      exitCode: 0,
    });
    expect(process.exitCode).toBe(0);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
  });

  it("writes only JSONL through the real terminal stdout display", async () => {
    const lines = await runCliWithTerminalDisplay([
      "run",
      "--flow",
      "no-review",
      "--output",
      "json",
    ]);

    expect(lines).toHaveLength(4);
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_started" }),
        expect.objectContaining({
          type: "run_completed",
          outcome: "completed",
          exitCode: 0,
        }),
      ]),
    );
    expect(lines.join("\n")).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
  });

  it("honors an explicit Hub project override", async () => {
    const entries = await runCli([
      "run",
      "--project",
      "beta",
      "--flow",
      "no-review",
    ]);

    expect(entries[0]).toMatchObject({
      _tag: "plain",
      message: expect.stringContaining('hub_project="beta"'),
    });
  });

  it("accepts a positional Hub project override", async () => {
    const entries = await runCli(["run", "beta", "--flow", "no-review"]);

    expect(entries[0]).toMatchObject({
      _tag: "plain",
      message: expect.stringContaining('hub_project="beta"'),
    });
  });

  it("keeps legacy path targets working with guidance", async () => {
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
        _tag: "plain",
        message: expect.stringContaining('flow="with-review"'),
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
      mockWaitForKeypress.mockResolvedValue("start");
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
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockWaitForKeypress).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 3000 }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          _tag: "section",
          title: "",
          blocks: expect.arrayContaining([
            expect.objectContaining({
              kind: "header",
              title: "archLoop",
              subtitle: "run",
            }),
            expect.objectContaining({
              kind: "kv",
              rows: expect.arrayContaining([
                expect.objectContaining({
                  key: "flow",
                  value: "prd-decomposition",
                }),
                expect.objectContaining({
                  key: "project",
                  value: "beta",
                  secondary: expect.stringContaining(repoBetaRoot),
                }),
                expect.objectContaining({
                  key: "input",
                  value: expect.stringContaining("docs/prd/example.md"),
                }),
              ]),
            }),
            expect.objectContaining({
              kind: "footer",
              label: "tip",
              commands: expect.arrayContaining([
                expect.stringContaining("starting in 3s"),
              ]),
            }),
          ]),
        }),
      );
    } finally {
      process.chdir(originalCwd);
      setTerminalTtyState(originalTty.stdin, originalTty.stdout);
      restoreXdgDataHome(originalXdgDataHome);
    }
  });

  it("renders PRD proposal phases as deterministic plain output", async () => {
    await mkdir(join(repoAlpha, "docs"), { recursive: true });
    await writeFile(join(repoAlpha, "docs", "proposal.md"), "# Proposal\n");
    const runDir = join(hostDir, "proposal-run");
    mockRunHubProposalFlowFromCli.mockImplementation(
      async (input: {
        onPresentationEvent?: (event: Record<string, unknown>) => void;
      }) => {
        for (const [sequence, phase, status, data] of [
          [1, "input_preparation", "completed"],
          [2, "draft", "started"],
          [3, "draft", "completed"],
          [4, "apply", "completed", { applied: 2, dependencies: 1 }],
        ] as const) {
          const presentationEvent = {
            eventId: `proposal-plain:${sequence}`,
            sequence,
            createdAt: `2026-07-15T12:00:0${sequence}.000Z`,
            runId: "proposal-plain",
            runDir,
            flowId: "prd-decomposition",
            phase,
            status,
            ...(data ? { data } : {}),
          };
          input.onPresentationEvent?.(presentationEvent);
          if (sequence === 1) {
            input.onPresentationEvent?.(presentationEvent);
          }
        }
        return {
          flowId: "prd-decomposition",
          result: {
            outcome: "applied",
            runId: "proposal-plain",
            runDir,
            hubStatusMode: "inbox",
            proposal: {},
            tasks: [{ id: "bd-1" }, { id: "bd-2" }],
            dependencies: [{ dependentId: "bd-2", blockerId: "bd-1" }],
          },
        };
      },
    );

    const entries = await runCli([
      "run",
      "--flow",
      "prd-decomposition",
      "--input",
      "docs/proposal.md",
      "--output",
      "plain",
      "--yes",
    ]);
    const lines = entries.flatMap((entry) =>
      entry._tag === "plain" ? [entry.message] : [],
    );

    expect(entries.every((entry) => entry._tag === "plain")).toBe(true);
    expect(lines[0]).toContain(
      'event=proposal_phase hub_project="alpha" flow="prd-decomposition" phase="input_preparation"',
    );
    expect(
      lines.filter((line) => line.includes('phase="input_preparation"')),
    ).toHaveLength(1);
    expect(lines.at(-1)).toContain(
      'event=run_completed outcome="applied" summary="Proposal approved and applied" applied=2',
    );
    expect(mockHandlePrdDecompositionFlowDisplay).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("projects SIGTERM cancellation for a proposal run", async () => {
    await mkdir(join(repoAlpha, "docs"), { recursive: true });
    await writeFile(join(repoAlpha, "docs", "proposal.md"), "# Proposal\n");
    const listenersBefore = new Set(process.listeners("SIGTERM"));
    mockRunHubProposalFlowFromCli.mockImplementation(
      async (input: { signal?: AbortSignal }) => {
        expect(input.signal).toBeDefined();
        const runListener = process
          .listeners("SIGTERM")
          .find((listener) => !listenersBefore.has(listener));
        expect(runListener).toBeDefined();
        runListener?.("SIGTERM");
        input.signal?.throwIfAborted();
        throw new Error("Expected SIGTERM to abort the proposal run");
      },
    );

    const entries = await runCli([
      "run",
      "--flow",
      "prd-decomposition",
      "--input",
      "docs/proposal.md",
      "--output",
      "plain",
      "--yes",
    ]);
    const lines = entries.flatMap((entry) =>
      entry._tag === "plain" ? [entry.message] : [],
    );

    expect(process.exitCode).toBe(143);
    expect(lines.at(-1)).toContain(
      'event=run_completed outcome="cancelled" summary="Proposal cancelled"',
    );
    expect(process.listeners("SIGTERM")).toEqual([...listenersBefore]);
  });

  it("renders triage proposal phases and no-change outcome as stdout-pure JSONL", async () => {
    const runDir = join(hostDir, "triage-json-run");
    mockRunHubProposalFlowFromCli.mockImplementation(
      async (input: {
        onPresentationEvent?: (event: Record<string, unknown>) => void;
      }) => {
        for (const [sequence, phase, status, data] of [
          [1, "input_preparation", "completed"],
          [2, "validation", "completed"],
          [3, "apply", "no_change", { applied: 0, skipped: 1 }],
        ] as const) {
          input.onPresentationEvent?.({
            eventId: `triage-json:${sequence}`,
            sequence,
            createdAt: `2026-07-15T12:10:0${sequence}.000Z`,
            runId: "triage-json",
            runDir,
            flowId: "triage",
            phase,
            status,
            ...(data ? { data } : {}),
          });
        }
        return {
          flowId: "triage",
          result: {
            outcome: "applied",
            runId: "triage-json",
            runDir,
            proposal: {},
            appliedDecisions: [],
            skippedDecisions: [{ taskId: "bd-1", reason: "unconfirmed" }],
            dependencies: [],
            skippedDependencies: [],
          },
        };
      },
    );

    const entries = await runCli([
      "run",
      "--flow",
      "triage",
      "--input",
      "inbox",
      "--output",
      "json",
      "--yes",
    ]);
    const records = entries.map((entry) => {
      expect(entry._tag).toBe("plain");
      return JSON.parse((entry as { message: string }).message) as Record<
        string,
        unknown
      >;
    });

    expect(records).toHaveLength(4);
    expect(
      records.every(
        (record) =>
          record.schemaVersion === 1 &&
          typeof record.eventId === "string" &&
          typeof record.sequence === "number" &&
          typeof record.timestamp === "string",
      ),
    ).toBe(true);
    expect(records.at(-1)).toMatchObject({
      type: "run_completed",
      outcome: "no_change",
      exitCode: 0,
      counts: { applied: 0, skipped: 1, dependencies: 0 },
    });
    expect(mockHandleTriageProposalFlowDisplay).not.toHaveBeenCalled();
  });

  it("runs proposal phases in bounded live output on a capable TTY", async () => {
    await mkdir(join(repoAlpha, "docs"), { recursive: true });
    await writeFile(join(repoAlpha, "docs", "live.md"), "# Live proposal\n");
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const listenerCountBefore = process.stdout.listenerCount("resize");
    let listenerCountDuring = listenerCountBefore;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setTerminalTtyState(true);
    setStdoutColumns(120);
    setStdoutRows(30);
    process.env.TERM = "xterm-256color";
    mockConfirm.mockResolvedValue(true);
    mockRunHubProposalFlowFromCli.mockImplementation(
      async (input: {
        interactive?: boolean;
        onPresentationEvent?: (event: Record<string, unknown>) => void;
      }) => {
        listenerCountDuring = process.stdout.listenerCount("resize");
        expect(input.interactive).toBe(true);
        for (const [sequence, phase, status, data] of [
          [1, "input_preparation", "completed"],
          [2, "draft", "started"],
          [3, "draft", "completed"],
          [4, "apply", "completed", { applied: 1 }],
        ] as const) {
          input.onPresentationEvent?.({
            eventId: `proposal-live:${sequence}`,
            sequence,
            createdAt: `2026-07-15T12:20:0${sequence}.000Z`,
            runId: "proposal-live",
            runDir: "/tmp/proposal-live",
            flowId: "prd-decomposition",
            phase,
            status,
            ...(data ? { data } : {}),
          });
        }
        return {
          flowId: "prd-decomposition",
          result: {
            outcome: "applied",
            runId: "proposal-live",
            runDir: "/tmp/proposal-live",
            hubStatusMode: "inbox",
            proposal: {},
            tasks: [{ id: "bd-1" }],
            dependencies: [],
          },
        };
      },
    );

    try {
      await runCli([
        "run",
        "--flow",
        "prd-decomposition",
        "--input",
        "docs/live.md",
      ]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const output = chunks.join("");
    expect(listenerCountDuring).toBeGreaterThan(listenerCountBefore);
    expect(process.stdout.listenerCount("resize")).toBe(listenerCountBefore);
    expect(output).toContain(
      "archLoop run | Project alpha | Flow prd-decomposition",
    );
    expect(output).toContain("Generate draft | Completed");
    expect(output).toContain("Proposal approved and applied");
    expect(output.endsWith("\x1b[?25h")).toBe(true);
  });

  it("falls back to plain and continues when suspending live output for a prompt fails", async () => {
    await mkdir(join(repoAlpha, "docs"), { recursive: true });
    await writeFile(join(repoAlpha, "docs", "prompt.md"), "# Prompt\n");
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const chunks: string[] = [];
    let writeCount = 0;
    let promptContinued = false;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      writeCount += 1;
      if (writeCount === 2) {
        throw new Error("prompt suspend write failed");
      }
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setTerminalTtyState(true);
    setStdoutColumns(120);
    setStdoutRows(30);
    process.env.TERM = "xterm-256color";
    mockConfirm.mockResolvedValue(true);
    mockRunHubProposalFlowFromCli.mockImplementation(
      async (input: {
        beforePrompt?: () => void;
        afterPrompt?: () => void;
        onPresentationEvent?: (event: Record<string, unknown>) => void;
      }) => {
        const emit = (sequence: number, phase: string, status: string) =>
          input.onPresentationEvent?.({
            eventId: `prompt-fallback:${sequence}`,
            sequence,
            createdAt: `2026-07-15T12:30:0${sequence}.000Z`,
            runId: "prompt-fallback",
            runDir: "/tmp/prompt-fallback",
            flowId: "prd-decomposition",
            phase,
            status,
            ...(phase === "apply"
              ? { data: { applied: 1, dependencies: 0 } }
              : {}),
          });
        emit(1, "draft", "started");
        input.beforePrompt?.();
        promptContinued = true;
        input.afterPrompt?.();
        emit(2, "draft", "completed");
        emit(3, "apply", "completed");
        return {
          flowId: "prd-decomposition",
          result: {
            outcome: "applied",
            runId: "prompt-fallback",
            runDir: "/tmp/prompt-fallback",
            hubStatusMode: "inbox",
            proposal: {},
            tasks: [{ id: "bd-1" }],
            dependencies: [],
          },
        };
      },
    );

    let entries: readonly DisplayEntry[] = [];
    try {
      entries = await runCli([
        "run",
        "--flow",
        "prd-decomposition",
        "--input",
        "docs/prompt.md",
      ]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const lines = entries.flatMap((entry) =>
      entry._tag === "plain" ? [entry.message] : [],
    );
    expect(promptContinued).toBe(true);
    expect(lines.filter((line) => line.includes('phase="draft"'))).toHaveLength(
      2,
    );
    expect(lines.at(-1)).toContain('outcome="applied"');
    expect(chunks.join("")).toContain("\x1b[?25h");
    expect(process.exitCode).toBe(0);
  });

  it("keeps early proposal execution failures inside stdout-pure JSONL", async () => {
    mockRunHubProposalFlowFromCli.mockRejectedValue(
      new Error("proposal agent unavailable\nprivate stack"),
    );

    const entries = await runCli([
      "run",
      "--flow",
      "triage",
      "--input",
      "inbox",
      "--output",
      "json",
      "--yes",
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?._tag).toBe("plain");
    const record = JSON.parse(
      (entries[0] as { message: string }).message,
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: 1,
      type: "run_failed",
      outcome: "failed",
      diagnostic: "proposal agent unavailable",
      exitCode: 1,
    });
    expect(process.exitCode).toBe(1);
  });

  it("keeps proposal input validation failures inside stdout-pure JSONL", async () => {
    const entries = await runCli([
      "run",
      "--flow",
      "prd-decomposition",
      "--output",
      "json",
      "--yes",
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?._tag).toBe("plain");
    const record = JSON.parse(
      (entries[0] as { message: string }).message,
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: 1,
      type: "run_failed",
      outcome: "failed",
      flowId: "prd-decomposition",
      exitCode: 1,
    });
    expect(String(record.diagnostic)).toMatch(/input|required/i);
    expect(process.exitCode).toBe(1);
  });

  it("suppresses legacy target guidance from JSON stdout", async () => {
    const entries = await runCli([
      "run",
      repoAlpha,
      "--flow",
      "no-review",
      "--output",
      "json",
    ]);

    expect(entries.every((entry) => entry._tag === "plain")).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(() =>
        JSON.parse((entry as { readonly message: string }).message),
      ).not.toThrow();
    }
  });

  it("returns exit code 130 when the user cancels the run plan", async () => {
    setTerminalTtyState(true);
    mockWaitForKeypress.mockResolvedValue("cancel");

    const entries = await runCli(["run", "--flow", "no-review"]);

    expect(mockWaitForKeypress).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 3000 }),
    );
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        severity: "warn",
        message: "Run cancelled.",
      }),
    );
  });

  it("dry-run renders the run plan section and skips starting the flow", async () => {
    setTerminalTtyState(true);
    mockWaitForKeypress.mockResolvedValue("start");

    const entries = await runCli(["run", "--flow", "no-review", "--dry-run"]);

    expect(mockWaitForKeypress).not.toHaveBeenCalled();
    expect(mockRunHubFlow).not.toHaveBeenCalled();
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "section",
        title: "",
        blocks: expect.arrayContaining([
          expect.objectContaining({
            kind: "header",
            title: "archLoop",
            subtitle: "run",
          }),
          expect.objectContaining({
            kind: "kv",
            rows: expect.arrayContaining([
              expect.objectContaining({ key: "flow", value: "no-review" }),
            ]),
          }),
        ]),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        severity: "info",
        message: "Dry run — Hub flow not started.",
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

  it("keeps a blocking run outcome structured in JSONL", async () => {
    mockRunHubFlow.mockResolvedValue({
      flowId: "no-review",
      runId: "run-json-blocked",
      batchId: "batch-json-blocked",
      runDir: "/tmp/runs/run-json-blocked",
      mode: "new_batch",
      completedBatchCount: 0,
      completedTaskCount: 0,
      stopReason: "batch_failed",
      batchResults: [
        {
          batchId: "batch-json-blocked",
          selectedTaskIds: ["task-json-blocked"],
          completedTaskCount: 0,
          batchStatus: "failed",
        },
      ],
      selectedTaskIds: ["task-json-blocked"],
      results: [
        {
          taskId: "task-json-blocked",
          title: "Blocked task",
          branch: "archloop/task-json-blocked",
          outcome: "active_execution",
          hubStatus: "implementing",
          commitCount: 0,
        },
      ],
      unfinishedBatchIds: ["batch-json-blocked"],
      projectDevelopmentContractPath: "/tmp/contract.md",
      projectDevelopmentContractCreatedGenericFallback: false,
    });

    const entries = await runCli([
      "run",
      "--flow",
      "no-review",
      "--output",
      "json",
    ]);
    const records = entries.map((entry) =>
      JSON.parse((entry as { readonly message: string }).message),
    );

    expect(process.exitCode).toBe(1);
    expect(records.at(-1)).toMatchObject({
      type: "run_completed",
      outcome: "failed",
      counts: {
        completed: 0,
        failed: 0,
        blocked: 1,
        skipped: 0,
        readyToMerge: 0,
      },
      stopReason: "batch_failed",
      exitCode: 1,
    });
  });

  it("keeps lifecycle execution errors inside stdout-pure JSONL", async () => {
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-error",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:10:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: join(
          process.env.XDG_DATA_HOME!,
          "archloop",
          "hub",
          "projects",
          "failed",
        ),
        eventId: "run-error:1",
        sequence: 1,
      });
      throw new Error('execution "failed"\nraw agent details');
    });

    const lines = await runCliWithTerminalDisplay([
      "run",
      "--flow",
      "no-review",
      "--output",
      "json",
    ]);
    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );

    expect(process.exitCode).toBe(1);
    expect(records.map((record) => record.type)).toEqual([
      "run_started",
      "run_failed",
    ]);
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 1,
      type: "run_failed",
      runId: "run-error",
      flowId: "no-review",
      outcome: "failed",
      diagnostic: 'execution "failed"',
      exitCode: 1,
      logs: expect.stringContaining("run-error"),
    });
  });

  it("appends a deterministic plain failure outcome without decorated errors", async () => {
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-plain-error",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:15:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: "/tmp/hub-plain-error",
        eventId: "run-plain-error:1",
        sequence: 1,
      });
      throw new Error('execution "failed"\nraw agent details');
    });

    const lines = await runCliWithTerminalDisplay([
      "run",
      "--flow",
      "no-review",
      "--output",
      "plain",
    ]);

    expect(process.exitCode).toBe(1);
    expect(lines.map((line) => line.match(/^event=([^ ]+)/)?.[1])).toEqual([
      "run_started",
      "run_failed",
    ]);
    expect(lines.at(-1)).toBe(
      'event=run_failed outcome="failed" summary="Run failed" diagnostic="execution \\"failed\\"" completed=0 failed=0 blocked=0 skipped=0 ready_to_merge=0 completed_batches=0 run_id="run-plain-error" logs="/tmp/hub-plain-error/runs/run-plain-error" recovery="archloop run --flow no-review"',
    );
    expect(lines.join("\n")).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
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

  it("projects a real SIGINT listener through the run AbortSignal", async () => {
    const listenersBefore = new Set(process.listeners("SIGINT"));
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-sigint",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:10:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: join(
          process.env.XDG_DATA_HOME!,
          "archloop",
          "hub",
          "projects",
          "sigint",
        ),
        eventId: "run-sigint:1",
        sequence: 1,
      });
      expect(input.signal).toBeDefined();
      const runListener = process
        .listeners("SIGINT")
        .find((listener) => !listenersBefore.has(listener));
      expect(runListener).toBeDefined();
      runListener?.("SIGINT");
      input.signal?.throwIfAborted();
      throw new Error("Expected SIGINT to abort the run");
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
    expect(output).toContain('outcome="cancelled"');
    expect(output).toContain('run_id="run-sigint"');
    expect(process.listeners("SIGINT")).toEqual([...listenersBefore]);
  });

  it("renders cancellation as stdout-pure JSONL with exit code 130", async () => {
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-json-cancelled",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:20:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: join(
          process.env.XDG_DATA_HOME!,
          "archloop",
          "hub",
          "projects",
          "json-cancelled",
        ),
        eventId: "run-json-cancelled:1",
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
      "json",
    ]);
    const records = entries.map((entry) => {
      expect(entry._tag).toBe("plain");
      return JSON.parse(
        (entry as { readonly message: string }).message,
      ) as Record<string, unknown>;
    });

    expect(process.exitCode).toBe(130);
    expect(records.map((record) => record.type)).toEqual([
      "run_started",
      "run_completed",
    ]);
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 1,
      runId: "run-json-cancelled",
      flowId: "no-review",
      outcome: "cancelled",
      cancelled: true,
      stopReason: "cancelled",
      exitCode: 130,
    });
  });

  it("finalizes and restores a live terminal when execution is cancelled", async () => {
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-live-cancelled",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:30:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: join(
          process.env.XDG_DATA_HOME!,
          "archloop",
          "hub",
          "projects",
          "live-cancelled",
        ),
        eventId: "run-live-cancelled:1",
        sequence: 1,
      });
      input.onEvent?.({
        type: "task_review_failed",
        runId: "run-live-cancelled",
        batchId: "batch-live-cancelled",
        taskId: "task-live-failed",
        branch: "archloop/task-live-failed",
        createdAt: "2026-07-15T12:30:01.000Z",
        status: "failed",
        diagnosticSummary: "review failed before cancellation",
        diagnostics: { path: "/tmp/live-review.log" },
        eventId: "run-live-cancelled:2",
        sequence: 2,
      });
      input.onEvent?.({
        type: "task_claim_skipped",
        runId: "run-live-cancelled",
        batchId: "batch-live-cancelled",
        taskId: "task-live-skipped",
        branch: "archloop/task-live-skipped",
        createdAt: "2026-07-15T12:30:02.000Z",
        status: "ready_for_agent",
        eventId: "run-live-cancelled:3",
        sequence: 3,
      });
      const error = new Error("The run was cancelled");
      error.name = "AbortError";
      throw error;
    });
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockConfirm.mockResolvedValue(true);

    try {
      await runCli(["run", "--flow", "no-review"]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const output = chunks.join("");
    expect(process.exitCode).toBe(130);
    expect(output).toContain("task-live-failed");
    expect(output).toContain("review failed before cancellation");
    expect(output).toContain("Run cancelled");
    expect(output).toContain("\x1b[?25h");
    expect(output).not.toContain("\x1b[1A");
  });

  it("falls back to a plain cancellation when the final live write fails", async () => {
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-live-cancel-write-failed",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:32:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: join(
          process.env.XDG_DATA_HOME!,
          "archloop",
          "hub",
          "projects",
          "live-cancel-write-failed",
        ),
        eventId: "run-live-cancel-write-failed:1",
        sequence: 1,
      });
      const error = new Error("The run was cancelled");
      error.name = "AbortError";
      throw error;
    });
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    let failedFinalWrite = false;
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        const text = String(chunk);
        if (!failedFinalWrite && text.includes("Run cancelled")) {
          failedFinalWrite = true;
          throw new Error("simulated cancellation terminal write failure");
        }
        return true;
      });
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockConfirm.mockResolvedValue(true);

    let entries: readonly DisplayEntry[] = [];
    try {
      entries = await runCli(["run", "--flow", "no-review"]);
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const output = entries
      .flatMap((entry) => (entry._tag === "plain" ? [entry.message] : []))
      .join("\n");
    expect(failedFinalWrite).toBe(true);
    expect(output).toContain("event=run_started");
    expect(output).toContain('outcome="cancelled"');
    expect(process.exitCode).toBe(130);
  });

  it("finalizes actionable live output before surfacing an execution failure", async () => {
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-live-failed",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:35:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: join(
          process.env.XDG_DATA_HOME!,
          "archloop",
          "hub",
          "projects",
          "live-failed",
        ),
        eventId: "run-live-failed:1",
        sequence: 1,
      });
      input.onEvent?.({
        type: "task_implementation_failed",
        runId: "run-live-failed",
        batchId: "batch-live-failed",
        taskId: "task-live-failed",
        branch: "archloop/task-live-failed",
        createdAt: "2026-07-15T12:35:01.000Z",
        status: "failed",
        diagnosticSummary: "implementation failed before host error",
        diagnostics: { path: "/tmp/live-implementation.log" },
        eventId: "run-live-failed:2",
        sequence: 2,
      });
      throw new Error("host execution failed");
    });
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockConfirm.mockResolvedValue(true);

    try {
      await expect(
        runCli(["run", "--flow", "no-review"]),
      ).rejects.toMatchObject({ message: "host execution failed" });
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    const output = chunks.join("");
    expect(output).toContain("task-live-failed");
    expect(output).toContain("implementation failed before host error");
    expect(output).toContain("archloop tasks recover --stale");
    expect(output).not.toContain("--only-failed");
    expect(output).toContain("\x1b[?25h");
    expect(output).not.toContain("\x1b[1A");
  });

  it("preserves the execution error when the failed live outcome cannot be written", async () => {
    mockRunHubFlow.mockImplementation(async (input) => {
      input.onEvent?.({
        type: "run_started",
        runId: "run-live-failure-write-failed",
        branch: "flow/no-review",
        startedAt: "2026-07-15T12:38:00.000Z",
        repoRoot: repoAlpha,
        hubProjectDir: join(
          process.env.XDG_DATA_HOME!,
          "archloop",
          "hub",
          "projects",
          "live-failure-write-failed",
        ),
        eventId: "run-live-failure-write-failed:1",
        sequence: 1,
      });
      throw new Error("host execution failed");
    });
    const originalColumns = process.stdout.columns;
    const originalTerm = process.env.TERM;
    let failedFinalWrite = false;
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        const text = String(chunk);
        // The final scrollback summary is the one write that carries the
        // failed-run fix footer (`fix   archloop run` for an interrupted run
        // with no failed task). Match that summary — failed outcome marker
        // and the `archloop run` fix footer land in the same chunk — to
        // simulate a terminal write failure mid-finalization.
        if (
          !failedFinalWrite &&
          text.includes("fix") &&
          text.includes("archloop run") &&
          text.includes("✗")
        ) {
          failedFinalWrite = true;
          throw new Error("simulated failure terminal write failure");
        }
        return true;
      });
    setTerminalTtyState(true);
    setStdoutColumns(120);
    process.env.TERM = "xterm-256color";
    mockWaitForKeypress.mockResolvedValue("start");

    try {
      await expect(
        runCli(["run", "--flow", "no-review"]),
      ).rejects.toMatchObject({ message: "host execution failed" });
    } finally {
      write.mockRestore();
      setStdoutColumns(originalColumns);
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
    }

    expect(failedFinalWrite).toBe(true);
  });

  it("fails in non-interactive mode when flow is omitted", async () => {
    await expect(runCli(["run"])).rejects.toMatchObject({
      message:
        "No Hub flow was provided. Run `archloop run --flow <id>`, `archloop run <project-name> --flow <id>`, or `archloop run --project <name> --flow <id>`.",
    });
  });

  describe("registered hubProjectDir preservation", () => {
    const registeredHubProjectDir = (
      projectName: string,
    ): string | undefined =>
      readHubProjectRegistry({ env: process.env }).find(
        (project) => project.name === projectName,
      )?.hubProjectDir;

    const mockRunWithHubProjectDirCapture = (
      expectedDir: string | undefined,
    ) => {
      let capturedHubProjectDir: string | undefined;
      mockRunHubFlow.mockImplementation(async (input) => {
        capturedHubProjectDir = input.hubProjectDir;
        const runId = "run-hub-project-dir";
        return {
          flowId: "no-review",
          runId,
          batchId: "batch-hub-project-dir",
          runDir: join(expectedDir ?? "/tmp", "runs", runId),
          mode: "new_batch" as const,
          completedBatchCount: 0,
          completedTaskCount: 0,
          stopReason: "no_ready_tasks" as const,
          batchResults: [],
          selectedTaskIds: [],
          results: [],
          unfinishedBatchIds: [],
          projectDevelopmentContractPath: "/tmp/contract.md",
          projectDevelopmentContractCreatedGenericFallback: false,
        };
      });
      return () => capturedHubProjectDir;
    };

    it("passes the selected project's registered hubProjectDir for the default run target", async () => {
      const expectedDir = registeredHubProjectDir("alpha");
      expect(expectedDir).toBeDefined();
      expect(expectedDir).not.toBe(
        resolveHubProjectDir(
          resolveArchloopUserDataDir(process.env),
          resolveGitRepoRoot(repoAlpha),
        ),
      );
      const readCaptured = mockRunWithHubProjectDirCapture(expectedDir);
      await runCli(["run", "--flow", "no-review"]);
      expect(readCaptured()).toBe(expectedDir);
    });

    it("passes the explicit --project target's registered hubProjectDir", async () => {
      const expectedDir = registeredHubProjectDir("beta");
      expect(expectedDir).toBeDefined();
      const readCaptured = mockRunWithHubProjectDirCapture(expectedDir);
      await runCli(["run", "--project", "beta", "--flow", "no-review"]);
      expect(readCaptured()).toBe(expectedDir);
    });

    it("passes the positional project target's registered hubProjectDir", async () => {
      const expectedDir = registeredHubProjectDir("beta");
      expect(expectedDir).toBeDefined();
      const readCaptured = mockRunWithHubProjectDirCapture(expectedDir);
      await runCli(["run", "beta", "--flow", "no-review"]);
      expect(readCaptured()).toBe(expectedDir);
    });

    it("uses the path-hash fallback for legacy targets without a registered project", async () => {
      const unregisteredDir = await mkdtemp(
        join(tmpdir(), "cli-run-unregistered-"),
      );
      await initRepo(unregisteredDir);
      await commitFile(
        unregisteredDir,
        "solo.txt",
        "solo",
        "initial unregistered",
      );
      const repoRoot = resolveGitRepoRoot(unregisteredDir);
      const expectedDir = resolveHubProjectDir(
        resolveArchloopUserDataDir(process.env),
        repoRoot,
      );
      const readCaptured = mockRunWithHubProjectDirCapture(expectedDir);
      await runCli(["run", ".", "--flow", "no-review"], unregisteredDir);
      expect(readCaptured()).toBe(expectedDir);
    });

    it("passes the registered hubProjectDir for a legacy path target of a registered repo", async () => {
      const expectedDir = registeredHubProjectDir("alpha");
      expect(expectedDir).toBeDefined();
      const readCaptured = mockRunWithHubProjectDirCapture(expectedDir);
      await runCli(["run", ".", "--flow", "no-review"], repoAlpha);
      expect(readCaptured()).toBe(expectedDir);
    });
  });
});
