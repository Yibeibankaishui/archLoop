import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createHubFlowRunMerger,
  createHubFlowRunVerifier,
  formatHubBatchMergeResultLines,
  runHubBatchMerge,
  type HubFlowMerger,
  type HubFlowVerifier,
  type HubMergeBranchInspector,
  type HubMergeWorktreeInspector,
  type HubTaskCloser,
} from "./hubBatchMerge.js";
import { createHubRunContext } from "./hubExecution.js";
import { selectHubBatchMergeTasks, loadHubTaskBoard } from "./taskBoard.js";

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

const readJsonl = async (path: string): Promise<unknown[]> => {
  const content = await readFile(path, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
};

interface MockBeadsTask {
  id: string;
  title: string;
  status: string;
  labels: string[];
  metadata: Record<string, unknown>;
}

const writeMockBd = async (
  repoDir: string,
  stateFile: string,
  initialTasks: MockBeadsTask[],
  options?: { readonly failCloseFor?: string },
) => {
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));

  const failCloseFor = options?.failCloseFor ?? "";
  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const failCloseFor = ${JSON.stringify(failCloseFor)};
const args = process.argv.slice(2);
const [command, id] = args;
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const findTask = (state, taskId) => state.find((task) => task.id === taskId);

if (command === "list" && args.includes("--json")) {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}

if (command === "show" && id) {
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "update" && id) {
  if (failCloseFor && id === failCloseFor) {
    const statusIndex = args.indexOf("--status");
    if (statusIndex >= 0 && args[statusIndex + 1] === "closed") {
      process.exit(1);
    }
  }
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  const statusIndex = args.indexOf("--status");
  if (statusIndex >= 0) {
    task.status = args[statusIndex + 1];
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--add-label") {
      const label = args[index + 1];
      if (!task.labels.includes(label)) task.labels.push(label);
    }
    if (args[index] === "--remove-label") {
      const label = args[index + 1];
      task.labels = task.labels.filter((entry) => entry !== label);
    }
  }
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = JSON.parse(args[metadataIndex + 1]);
  }
  writeState(state);
  process.exit(0);
}

process.exit(1);
`,
  );
  await chmod(bdPath, 0o755);

  return {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SANDCASTLE_BD_PATH: bdPath,
      BD_STATE_FILE: stateFile,
    },
  };
};

const createMergeContext = (
  repoDir: string,
  batchId: string,
  hubProjectDir: string,
) => {
  const context = createHubRunContext({
    cwd: repoDir,
    hubProjectDir,
    branch: "flow/no-review",
    batchId,
    runId: "run-merge-test",
  });
  return context;
};

const successMerger: HubFlowMerger = async () => ({ outcome: "success" });
const successVerifier: HubFlowVerifier = async () => ({ outcome: "success" });
const branchReadyInspector: HubMergeBranchInspector = async () => ({
  exists: true,
  hasUnmergedWork: true,
});
const cleanWorktreeInspector: HubMergeWorktreeInspector = async () => ({
  dirtySourceFiles: [],
  dirtyTaskStoreFiles: [],
});

describe("Hub batch merge selection", () => {
  it("selects waiting_for_merge tasks for the current batch id", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-select-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-merge",
        title: "Merge me",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-1",
            batchId: "batch-1",
            branch: "sandcastle/bd-merge-merge-me",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
      {
        id: "bd-other-batch",
        title: "Other batch",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-2",
            batchId: "batch-2",
            branch: "sandcastle/bd-other-batch-other-batch",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const board = loadHubTaskBoard(repoDir, env);
    expect(
      selectHubBatchMergeTasks(board, "batch-1").map((task) => task.id),
    ).toEqual(["bd-merge"]);
  });
});

describe("runHubBatchMerge", () => {
  it("merges eligible tasks with per-task events and closes them locally", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-success-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-success";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-72",
        title: "Merge task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "sandcastle/bd-72-merge-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const hubProjectDir = join(repoDir, "data", "sandcastle", "hub");
    const context = createMergeContext(repoDir, batchId, hubProjectDir);

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: successMerger,
      verifier: successVerifier,
      branchInspector: branchReadyInspector,
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.batchStatus).toBe("done");
    expect(result.results).toEqual([
      expect.objectContaining({
        taskId: "bd-72",
        outcome: "merged",
        hubStatus: "done",
      }),
    ]);

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("closed");
    expect(finalState[0]?.labels).toContain("done");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      [
        "merge_started",
        "merge_succeeded",
        "verification_started",
        "verification_passed",
        "task_close_started",
        "task_closed",
        "task_status_advanced",
      ],
    );

    const batchEvents = await readJsonl(
      join(context.runDir, "events", "batch.jsonl"),
    );
    expect(
      batchEvents.map((event) => (event as { type: string }).type),
    ).toEqual([
      "batch_merge_selection",
      "batch_merge_started",
      "batch_merge_completed",
    ]);
    expect(formatHubBatchMergeResultLines(result).join("\n")).toContain(
      "bd-72: merged -> done",
    );
  });

  it("records selected and skipped task selection reasons before merging", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-reasons-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-selection";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-selected",
        title: "Selected task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-selected",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
      {
        id: "bd-status",
        title: "Wrong status",
        status: "in_progress",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-status",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
      {
        id: "bd-other-batch",
        title: "Other batch",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId: "batch-other",
            branch: "branch-other",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
      {
        id: "bd-missing-claim",
        title: "Missing claim",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
        },
      },
      {
        id: "bd-missing-branch",
        title: "Missing branch",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
      {
        id: "bd-no-work",
        title: "No unmerged work",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-no-work",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "sandcastle", "hub"),
    );

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: successMerger,
      verifier: successVerifier,
      branchInspector: async (branch) => ({
        exists: branch !== "branch-missing",
        hasUnmergedWork: branch !== "branch-no-work",
      }),
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.selectedTaskIds).toEqual(["bd-selected"]);
    expect(
      result.selectionDiagnostics.map(({ taskId, decision, reason }) => ({
        taskId,
        decision,
        reason,
      })),
    ).toEqual([
      {
        taskId: "bd-missing-branch",
        decision: "skipped",
        reason: "missing_branch",
      },
      {
        taskId: "bd-missing-claim",
        decision: "skipped",
        reason: "missing_claim",
      },
      { taskId: "bd-no-work", decision: "skipped", reason: "no_unmerged_work" },
      {
        taskId: "bd-other-batch",
        decision: "skipped",
        reason: "batch_mismatch",
      },
      { taskId: "bd-selected", decision: "selected", reason: "selected" },
      { taskId: "bd-status", decision: "skipped", reason: "status_mismatch" },
    ]);

    const batchEvents = await readJsonl(
      join(context.runDir, "events", "batch.jsonl"),
    );
    expect(batchEvents).toContainEqual(
      expect.objectContaining({
        type: "batch_merge_selection",
        selectedTaskIds: ["bd-selected"],
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            taskId: "bd-no-work",
            decision: "skipped",
            reason: "no_unmerged_work",
          }),
        ]),
      }),
    );

    const summary = formatHubBatchMergeResultLines(result).join("\n");
    expect(summary).toContain("Selection diagnostics:");
    expect(summary).toContain("bd-selected: selected branch-selected");
    expect(summary).toContain("bd-status: skipped status_mismatch");
    expect(summary).toContain("bd-other-batch: skipped batch_mismatch");
    expect(summary).toContain("bd-missing-claim: skipped missing_claim");
    expect(summary).toContain("bd-missing-branch: skipped missing_branch");
    expect(summary).toContain("bd-no-work: skipped no_unmerged_work");
  });

  it("blocks merge preflight when the source worktree has dirty source files", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-dirty-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    await writeFile(join(repoDir, "dirty-source.txt"), "uncommitted");

    const batchId = "batch-dirty";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-dirty",
        title: "Dirty source task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-dirty",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "sandcastle", "hub"),
    );
    let mergeCalls = 0;

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: async () => {
        mergeCalls += 1;
        return { outcome: "success" };
      },
      verifier: successVerifier,
      branchInspector: branchReadyInspector,
    });

    expect(mergeCalls).toBe(0);
    expect(result.batchStatus).toBe("skipped");
    expect(result.selectedTaskIds).toEqual([]);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-dirty",
        decision: "blocked",
        reason: "dirty_worktree",
        message: expect.stringContaining("dirty-source.txt"),
      }),
    );
    expect(formatHubBatchMergeResultLines(result).join("\n")).toContain(
      "bd-dirty: blocked dirty_worktree branch-dirty",
    );
  });

  it("does not block merge preflight for dirty Beads runtime/export files in the source worktree", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-beads-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-beads-dirty";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-beads-dirty",
        title: "Beads dirty task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-beads-dirty",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "sandcastle", "hub"),
    );
    let mergeCalls = 0;

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: async () => {
        mergeCalls += 1;
        return { outcome: "success" };
      },
      verifier: successVerifier,
      branchInspector: branchReadyInspector,
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [
          ".beads/issues.jsonl",
          ".beads/interactions.jsonl",
        ],
      }),
    });

    expect(mergeCalls).toBe(1);
    expect(result.batchStatus).toBe("done");
    expect(result.selectedTaskIds).toEqual(["bd-beads-dirty"]);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-beads-dirty",
        decision: "selected",
        reason: "selected",
        taskStoreDirtyFiles: [
          ".beads/issues.jsonl",
          ".beads/interactions.jsonl",
        ],
      }),
    );
    expect(formatHubBatchMergeResultLines(result).join("\n")).toContain(
      "task-store dirty: .beads/issues.jsonl, .beads/interactions.jsonl",
    );
  });

  it("blocks task branches that include Beads runtime/export files in their diff", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-beads-diff-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-beads-diff";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-beads-diff",
        title: "Beads branch diff",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-beads-diff",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "sandcastle", "hub"),
    );
    let mergeCalls = 0;

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: async () => {
        mergeCalls += 1;
        return { outcome: "success" };
      },
      verifier: successVerifier,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
        changedFiles: [".beads/issues.jsonl"],
      }),
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(mergeCalls).toBe(0);
    expect(result.batchStatus).toBe("skipped");
    expect(result.selectedTaskIds).toEqual([]);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-beads-diff",
        decision: "blocked",
        reason: "task_store_dirty",
        branch: "branch-beads-diff",
        taskStoreBranchFiles: [".beads/issues.jsonl"],
      }),
    );
    expect(formatHubBatchMergeResultLines(result).join("\n")).toContain(
      "bd-beads-diff: blocked task_store_dirty branch-beads-diff",
    );
  });

  it("marks verification failure as failed and reverts remaining tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-verify-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-verify-fail";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-first",
        title: "First task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-a",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
      {
        id: "bd-second",
        title: "Second task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-b",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "sandcastle", "hub"),
    );
    let verifyCalls = 0;
    const verifier: HubFlowVerifier = async (input) => {
      verifyCalls += 1;
      if (input.taskId === "bd-first") {
        return { outcome: "failed", message: "verification failed" };
      }
      return { outcome: "success" };
    };

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: successMerger,
      verifier,
      branchInspector: branchReadyInspector,
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.batchStatus).toBe("partial_failed");
    expect(result.results).toEqual([
      expect.objectContaining({
        taskId: "bd-first",
        outcome: "verification_failed",
        hubStatus: "failed",
        failureReason: "verification_failure",
      }),
      expect.objectContaining({
        taskId: "bd-second",
        outcome: "skipped",
        hubStatus: "waiting_for_merge",
      }),
    ]);
    expect(verifyCalls).toBe(1);

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState.find((task) => task.id === "bd-first")?.labels).toContain(
      "failed",
    );
    expect(
      finalState.find((task) => task.id === "bd-second")?.labels,
    ).toContain("waiting-for-merge");
  });

  it("marks merge conflicts as failed and skips remaining tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-conflict-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-conflict";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-conflict",
        title: "Conflict task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "sandcastle/bd-conflict-conflict-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
      {
        id: "bd-later",
        title: "Later task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "sandcastle/bd-later-later-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "sandcastle", "hub"),
    );
    const merger: HubFlowMerger = async () => ({
      outcome: "merge_conflict",
      message: "merge conflict",
    });

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger,
      verifier: successVerifier,
      branchInspector: branchReadyInspector,
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.batchStatus).toBe("partial_failed");
    expect(result.results[0]).toMatchObject({
      taskId: "bd-conflict",
      outcome: "merge_conflict",
      failureReason: "merge_conflict",
    });
    expect(result.results[1]).toMatchObject({
      taskId: "bd-later",
      outcome: "skipped",
      hubStatus: "waiting_for_merge",
    });

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(
      taskEvents.map((event) => (event as { type: string }).type),
    ).toContain("merge_failed");
  });

  it("preserves generic merge failure diagnostics in events and result output", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-failed-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-merge-failed";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-failed",
        title: "Failed task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "sandcastle/bd-failed-failed-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "sandcastle", "hub"),
    );
    const merger: HubFlowMerger = async () => ({
      outcome: "failed",
      message: "git merge exited 128",
      diagnostics: {
        exitCode: 128,
        stdout: "Auto-merging config.json",
        stderr: "fatal: refusing to merge unrelated histories",
        details: { command: "git merge branch-a" },
      },
    });

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger,
      verifier: successVerifier,
      branchInspector: branchReadyInspector,
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.batchStatus).toBe("partial_failed");
    expect(result.results[0]).toMatchObject({
      taskId: "bd-failed",
      outcome: "merge_failed",
      failureReason: "merge_failed",
      diagnosticSummary:
        "git merge exited 128 (exit 128): fatal: refusing to merge unrelated histories",
      diagnostics: {
        exitCode: 128,
        stdout: "Auto-merging config.json",
        stderr: "fatal: refusing to merge unrelated histories",
        details: { command: "git merge branch-a" },
      },
    });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.metadata.failureReason).toBe("merge_failed");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    const mergeFailedEvent = taskEvents.find(
      (event) => (event as { type: string }).type === "merge_failed",
    );
    expect(mergeFailedEvent).toMatchObject({
      type: "merge_failed",
      taskId: "bd-failed",
      failureReason: "merge_failed",
      diagnosticSummary:
        "git merge exited 128 (exit 128): fatal: refusing to merge unrelated histories",
      diagnostics: {
        exitCode: 128,
        stdout: "Auto-merging config.json",
        stderr: "fatal: refusing to merge unrelated histories",
        details: { command: "git merge branch-a" },
      },
    });

    const batchEvents = await readJsonl(
      join(context.runDir, "events", "batch.jsonl"),
    );
    expect(batchEvents.at(-1)).toMatchObject({
      type: "batch_merge_completed",
      batchStatus: "partial_failed",
      failedTaskId: "bd-failed",
      failureReason: "merge_failed",
      failureSummary:
        "bd-failed merge_failed: git merge exited 128 (exit 128): fatal: refusing to merge unrelated histories",
    });
    expect(formatHubBatchMergeResultLines(result).join("\n")).toContain(
      "bd-failed: merge_failed -> failed; git merge exited 128 (exit 128): fatal: refusing to merge unrelated histories",
    );
  });

  it("marks close failures as failed and reverts remaining tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-close-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-close-fail";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-close",
        title: "Close fail task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "sandcastle/bd-close-close-fail-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
      {
        id: "bd-queued",
        title: "Queued task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "sandcastle/bd-queued-queued-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "sandcastle", "hub"),
    );
    const closer: HubTaskCloser = async () => {
      throw new Error("close failed");
    };

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: successMerger,
      verifier: successVerifier,
      closer,
      branchInspector: branchReadyInspector,
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.batchStatus).toBe("partial_failed");
    expect(result.results[0]).toMatchObject({
      taskId: "bd-close",
      outcome: "close_failed",
      failureReason: "close_failed",
    });
    expect(result.results[1]).toMatchObject({
      taskId: "bd-queued",
      outcome: "skipped",
      hubStatus: "waiting_for_merge",
    });

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(
      taskEvents.map((event) => (event as { type: string }).type),
    ).toContain("task_close_failed");
  });

  it("uses git merge in the default merger helper", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-git-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "main.txt", "main", "initial commit");

    const branch = "sandcastle/bd-git-feature";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const merger = createHubFlowRunMerger({ cwd: repoDir });
    const result = await merger({
      flowId: "no-review",
      taskId: "bd-git",
      title: "Feature",
      branch,
      cwd: repoDir,
      runDir: join(repoDir, "runs"),
    });

    expect(result.outcome).toBe("success");
    const merged = await readFile(join(repoDir, "feature.txt"), "utf-8");
    expect(merged).toBe("feature");
  });

  it("passes through missing verify.sh in the default verifier helper", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-default-verify-"),
    );
    const verifier = createHubFlowRunVerifier({ cwd: repoDir });
    const result = await verifier({
      flowId: "no-review",
      taskId: "bd-verify",
      title: "Verify",
      branch: "sandcastle/bd-verify-verify",
      cwd: repoDir,
      runDir: join(repoDir, "runs"),
    });
    expect(result.outcome).toBe("success");
  });
});
