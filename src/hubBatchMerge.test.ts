import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  type HubMergeConflictResolver,
  type HubFlowMerger,
  type HubFlowVerifier,
  type HubMergeBranchInspector,
  type HubMergeWorktreeInspector,
  type HubTaskCloser,
} from "./hubBatchMerge.js";
import { createHubRunContext } from "./hubExecution.js";
import { selectHubBatchMergeTasks, loadHubTaskBoard } from "./taskBoard.js";

const execAsync = promisify(exec);

const seedHubTaskStore = (repoDir: string): void => {
  const beadsDir = join(repoDir, ".beads");
  mkdirSync(beadsDir, { recursive: true });
  const metadataPath = join(beadsDir, "metadata.json");
  if (!existsSync(metadataPath)) {
    writeFileSync(metadataPath, JSON.stringify({ backend: "dolt" }));
  }
  // Mirror bd init: a fully-initialized store also has the embeddeddolt dir.
  mkdirSync(join(beadsDir, "embeddeddolt"), { recursive: true });
};

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
  seedHubTaskStore(repoDir);
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
    if (args[index] === "--set-labels") {
      task.labels = [];
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      const label = args[index + 1];
      if (!task.labels.includes(label)) task.labels.push(label);
    }
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
    task.metadata = {
      ...task.metadata,
      ...JSON.parse(args[metadataIndex + 1]),
    };
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--unset-metadata") {
      delete task.metadata[args[index + 1]];
    }
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
      ARCHLOOP_BD_PATH: bdPath,
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

const seedTaskClaimEvent = (
  context: ReturnType<typeof createMergeContext>,
  input: {
    readonly batchId: string;
    readonly taskId: string;
    readonly branch: string;
    readonly claim: Record<string, unknown>;
  },
): void => {
  writeFileSync(
    join(context.runDir, "events", "task.jsonl"),
    `${JSON.stringify({
      type: "task_claimed",
      runId: context.runId,
      batchId: input.batchId,
      taskId: input.taskId,
      branch: input.branch,
      createdAt: "2026-06-12T10:05:00.000Z",
      status: "implementing",
      claim: input.claim,
    })}\n`,
  );
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
            branch: "archloop/bd-merge-merge-me",
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
            branch: "archloop/bd-other-batch-other-batch",
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
    const branch = "archloop/bd-72-merge-task";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });
    const { stdout: baseHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });

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
            branch,
            claimedAt: "2026-06-12T10:00:00Z",
            baseHead: baseHead.trim(),
            branchExistedBeforeClaim: false,
          },
        },
      },
    ]);

    const hubProjectDir = join(repoDir, "data", "archloop", "hub");
    const context = createMergeContext(repoDir, batchId, hubProjectDir);
    seedTaskClaimEvent(context, {
      batchId,
      taskId: "bd-72",
      branch,
      claim: {
        runId: "run-merge-test",
        batchId,
        branch,
        claimedAt: "2026-06-12T10:00:00Z",
        baseHead: baseHead.trim(),
        branchExistedBeforeClaim: false,
      },
    });

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
        cleanup: expect.objectContaining({
          outcome: "skipped",
          reasonCodes: ["unmerged_work"],
        }),
      }),
    ]);

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("closed");
    expect(finalState[0]?.labels).toContain("done");
    await expect(
      execAsync(`git show-ref --verify --quiet refs/heads/${branch}`, {
        cwd: repoDir,
      }),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      [
        "task_claimed",
        "merge_started",
        "merge_succeeded",
        "verification_started",
        "verification_passed",
        "task_close_started",
        "task_closed",
        "task_status_advanced",
        "task_branch_cleanup",
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

  it("deletes a safe managed branch after close and records cleanup events", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-cleanup-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const branch = "archloop/bd-safe-cleanup";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });
    const { stdout: baseHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });

    const batchId = "batch-safe-cleanup";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-safe-cleanup",
        title: "Safe cleanup task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch,
            claimedAt: "2026-06-12T10:00:00Z",
            baseHead: baseHead.trim(),
            branchExistedBeforeClaim: false,
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    seedTaskClaimEvent(context, {
      batchId,
      taskId: "bd-safe-cleanup",
      branch,
      claim: {
        runId: "run-merge-test",
        batchId,
        branch,
        claimedAt: "2026-06-12T10:00:00Z",
        baseHead: baseHead.trim(),
        branchExistedBeforeClaim: false,
      },
    });

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: createHubFlowRunMerger({ cwd: repoDir }),
      verifier: successVerifier,
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.batchStatus).toBe("done");
    expect(result.results).toEqual([
      expect.objectContaining({
        taskId: "bd-safe-cleanup",
        outcome: "merged",
        hubStatus: "done",
        cleanup: expect.objectContaining({
          outcome: "deleted",
        }),
      }),
    ]);
    await expect(
      execAsync(`git show-ref --verify --quiet refs/heads/${branch}`, {
        cwd: repoDir,
      }),
    ).rejects.toThrow();

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.at(-1)).toMatchObject({
      type: "task_branch_cleanup",
      cleanup: {
        policy: "safe_managed",
        outcome: "deleted",
      },
    });
    expect(formatHubBatchMergeResultLines(result).join("\n")).toContain(
      "bd-safe-cleanup: merged -> done; cleanup deleted",
    );
  });

  it("records cleanup failures without corrupting the merged task lifecycle", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-cleanup-fail-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const branch = "archloop/bd-cleanup-failure";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });
    const { stdout: baseHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });

    const batchId = "batch-cleanup-failure";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-cleanup-failure",
        title: "Cleanup failure task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch,
            claimedAt: "2026-06-12T10:00:00Z",
            baseHead: baseHead.trim(),
            branchExistedBeforeClaim: false,
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    seedTaskClaimEvent(context, {
      batchId,
      taskId: "bd-cleanup-failure",
      branch,
      claim: {
        runId: "run-merge-test",
        batchId,
        branch,
        claimedAt: "2026-06-12T10:00:00Z",
        baseHead: baseHead.trim(),
        branchExistedBeforeClaim: false,
      },
    });

    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: createHubFlowRunMerger({ cwd: repoDir }),
      verifier: successVerifier,
      branchCleanup: async () => ({
        outcome: "failed",
        reasonCodes: ["simulated_cleanup_failure"],
        diagnosticSummary: "cleanup failed",
        diagnostics: {
          details: {
            branch,
          },
        },
      }),
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.batchStatus).toBe("done");
    expect(result.results[0]).toMatchObject({
      taskId: "bd-cleanup-failure",
      outcome: "merged",
      hubStatus: "done",
      cleanup: expect.objectContaining({
        outcome: "failed",
        reasonCodes: ["simulated_cleanup_failure"],
        diagnosticSummary: "cleanup failed",
      }),
    });
    await expect(
      execAsync(`git show-ref --verify --quiet refs/heads/${branch}`, {
        cwd: repoDir,
      }),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState[0]?.status).toBe("closed");
    expect(finalState[0]?.labels).toContain("done");

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.at(-1)).toMatchObject({
      type: "task_branch_cleanup",
      cleanup: {
        policy: "safe_managed",
        outcome: "failed",
        reasonCodes: ["simulated_cleanup_failure"],
        diagnosticSummary: "cleanup failed",
      },
    });
    expect(formatHubBatchMergeResultLines(result).join("\n")).toContain(
      "bd-cleanup-failure: merged -> done; cleanup failed: cleanup failed",
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
      join(repoDir, "data", "archloop", "hub"),
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

  it("diagnoses reviewed branch work with stale Beads projection as state inconsistent", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-stale-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-state-inconsistent";
    const stateFile = join(repoDir, "bd-state.json");
    const initialTasks: MockBeadsTask[] = [
      {
        id: "bd-stale",
        title: "Reviewed stale projection",
        status: "in_progress",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-stale",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ];
    const { env } = await writeMockBd(repoDir, stateFile, initialTasks);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_review_succeeded",
        runId: context.runId,
        batchId,
        taskId: "bd-stale",
        branch: "branch-stale",
        createdAt: "2026-06-12T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 1,
        claim: initialTasks[0]?.metadata.claim,
      })}\n`,
    );

    let mergeCalls = 0;
    const result = await runHubBatchMerge({
      flowId: "with-review",
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
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(mergeCalls).toBe(0);
    expect(result.batchStatus).toBe("skipped");
    expect(result.selectedTaskIds).toEqual([]);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-stale",
        decision: "blocked",
        reason: "state_inconsistent",
        branch: "branch-stale",
        hubStatus: "reviewing",
        observedProjectedStatus: "reviewing",
        suggestedRecovery: "archloop tasks repair-state bd-stale",
      }),
    );
    expect(formatHubBatchMergeResultLines(result).join("\n")).toContain(
      "bd-stale: blocked state_inconsistent branch-stale",
    );

    const finalState = JSON.parse(
      await readFile(stateFile, "utf-8"),
    ) as MockBeadsTask[];
    expect(finalState).toEqual(initialTasks);
  });

  it("diagnoses no-review implementation branch work when Beads projection lost claim metadata", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-missing-claim-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-missing-claim";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-no-claim",
        title: "No claim projection",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          hubStatus: "ready_for_agent",
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_implementation_succeeded",
        runId: context.runId,
        batchId,
        taskId: "bd-no-claim",
        branch: "branch-no-claim",
        createdAt: "2026-06-12T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 0,
        branchHasUnmergedWork: true,
        implementationWork: "existing_unmerged_work",
      })}\n`,
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
      branchInspector: branchReadyInspector,
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.batchStatus).toBe("skipped");
    expect(result.selectedTaskIds).toEqual([]);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-no-claim",
        decision: "blocked",
        reason: "state_inconsistent",
        branch: "branch-no-claim",
        observedProjectedStatus: "ready_for_agent",
        missingClaimFields: ["runId", "batchId", "branch"],
        suggestedRecovery: "archloop tasks repair-state bd-no-claim",
        mergeReadyEventType: "task_implementation_succeeded",
      }),
    );
  });

  it("diagnoses waiting_for_merge tasks with merge-ready events and missing claim metadata", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-waiting-missing-claim-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-waiting-missing-claim";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-waiting-no-claim",
        title: "Waiting without claim",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_review_succeeded",
        runId: context.runId,
        batchId,
        taskId: "bd-waiting-no-claim",
        branch: "branch-waiting-no-claim",
        createdAt: "2026-06-12T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 1,
      })}\n`,
    );

    const result = await runHubBatchMerge({
      flowId: "with-review",
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

    expect(result.selectedTaskIds).toEqual([]);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-waiting-no-claim",
        decision: "blocked",
        reason: "state_inconsistent",
        branch: "branch-waiting-no-claim",
        observedProjectedStatus: "waiting_for_merge",
        missingClaimFields: ["runId", "batchId", "branch"],
      }),
    );
  });

  it("skips terminal tasks normally when merge-ready history has no remaining branch work", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-terminal-no-work-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-terminal-no-work";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-done",
        title: "Already done",
        status: "closed",
        labels: ["done"],
        metadata: {
          hubStatus: "done",
          done: true,
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-done",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_review_succeeded",
        runId: context.runId,
        batchId,
        taskId: "bd-done",
        branch: "branch-done",
        createdAt: "2026-06-12T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 1,
      })}\n`,
    );

    const result = await runHubBatchMerge({
      flowId: "with-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: successMerger,
      verifier: successVerifier,
      branchInspector: async () => ({ exists: true, hasUnmergedWork: false }),
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.selectedTaskIds).toEqual([]);
    expect(
      result.selectionDiagnostics.some(
        (diagnostic) => diagnostic.reason === "state_inconsistent",
      ),
    ).toBe(false);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-done",
        decision: "skipped",
        reason: "status_mismatch",
        hubStatus: "done",
      }),
    );
  });

  it("skips closed terminal tasks normally even if branch work is still visible", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-closed-branch-work-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-closed-branch-work";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-closed",
        title: "Closed task",
        status: "closed",
        labels: ["done"],
        metadata: {
          hubStatus: "done",
          done: true,
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-closed",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_review_succeeded",
        runId: context.runId,
        batchId,
        taskId: "bd-closed",
        branch: "branch-closed",
        createdAt: "2026-06-12T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 1,
      })}\n`,
    );

    const result = await runHubBatchMerge({
      flowId: "with-review",
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

    expect(result.selectedTaskIds).toEqual([]);
    expect(
      result.selectionDiagnostics.some(
        (diagnostic) => diagnostic.reason === "state_inconsistent",
      ),
    ).toBe(false);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-closed",
        decision: "skipped",
        reason: "status_mismatch",
        hubStatus: "done",
      }),
    );
  });

  it("keeps failed tasks with no commits and no branch work out of merge diagnostics", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-failed-no-work-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const batchId = "batch-failed-no-work";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-failed-no-work",
        title: "Failed without work",
        status: "open",
        labels: ["failed"],
        metadata: {
          hubStatus: "failed",
          failed: true,
          failureReason: "agent_failed",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch: "branch-failed-no-work",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_implementation_failed",
        runId: context.runId,
        batchId,
        taskId: "bd-failed-no-work",
        branch: "branch-failed-no-work",
        createdAt: "2026-06-12T10:15:00.000Z",
        status: "failed",
        failureReason: "agent_failed",
        commitCount: 0,
      })}\n`,
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
      branchInspector: async () => ({ exists: true, hasUnmergedWork: false }),
      worktreeInspector: cleanWorktreeInspector,
    });

    expect(result.selectedTaskIds).toEqual([]);
    expect(
      result.selectionDiagnostics.some(
        (diagnostic) => diagnostic.reason === "state_inconsistent",
      ),
    ).toBe(false);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-failed-no-work",
        decision: "skipped",
        reason: "status_mismatch",
        hubStatus: "failed",
      }),
    );
  });

  it("blocks merge preflight when dirty source files overlap the task branch", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-merge-dirty-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "shared.txt", "base\n", "initial commit");

    const branch = "archloop/bd-dirty-overlap";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "shared.txt", "branch\n", "branch edit");
    await execAsync("git checkout main", { cwd: repoDir });
    await writeFile(join(repoDir, "shared.txt"), "local uncommitted\n");

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
            branch,
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
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
    });

    expect(mergeCalls).toBe(0);
    expect(result.batchStatus).toBe("skipped");
    expect(result.selectedTaskIds).toEqual([]);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-dirty",
        decision: "blocked",
        reason: "dirty_worktree",
        branch,
        blockingPaths: ["shared.txt"],
        message: expect.stringContaining("shared.txt"),
      }),
    );
    const summary = formatHubBatchMergeResultLines(result).join("\n");
    expect(summary).toContain(
      `Git safety gate: dirty source files would be overwritten or conflict with ${branch}`,
    );
    expect(summary).toContain("shared.txt");
    expect(summary).toContain("commit, stash, or discard dirty source files");
    expect(summary).toContain("then rerun the same flow so the batch resumes.");
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
      join(repoDir, "data", "archloop", "hub"),
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

  it("merges through a clean integration worktree when dirty source files do not overlap the task branch", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-dirty-compatible-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "base.txt", "base\n", "initial commit");

    const branch = "archloop/bd-dirty-compatible";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature\n", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });
    await writeFile(join(repoDir, "notes.txt"), "local notes\n");
    await mkdir(join(repoDir, ".archloop"), { recursive: true });
    const verifyCwdPath = join(repoDir, "verify-cwd.txt");
    await writeFile(
      join(repoDir, ".archloop", "verify.sh"),
      `#!/bin/sh
{
  pwd
  cat feature.txt
  if [ -e notes.txt ]; then echo notes-present; else echo notes-absent; fi
} > ${JSON.stringify(verifyCwdPath)}
test -f feature.txt
test ! -f notes.txt
`,
    );
    await chmod(join(repoDir, ".archloop", "verify.sh"), 0o755);

    const batchId = "batch-dirty-compatible";
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-dirty-compatible",
        title: "Dirty compatible task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-merge-test",
            batchId,
            branch,
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
    );
    const result = await runHubBatchMerge({
      flowId: "no-review",
      cwd: repoDir,
      runDir: context.runDir,
      runId: context.runId,
      batchId,
      env,
      merger: createHubFlowRunMerger({ cwd: repoDir }),
      verifier: createHubFlowRunVerifier({ cwd: repoDir }),
    });

    expect(result.batchStatus).toBe("done");
    expect(result.selectedTaskIds).toEqual(["bd-dirty-compatible"]);
    expect(result.selectionDiagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-dirty-compatible",
        decision: "selected",
        reason: "selected",
      }),
    );
    const [verificationCwd, verifiedFeature, verifiedNotes] = (
      await readFile(verifyCwdPath, "utf-8")
    )
      .trim()
      .split(/\r?\n/);
    expect(verificationCwd).not.toBe(repoDir);
    expect(verifiedFeature).toBe("feature");
    expect(verifiedNotes).toBe("notes-absent");
    await expect(readFile(join(repoDir, "feature.txt"), "utf-8")).resolves.toBe(
      "feature\n",
    );
    await expect(readFile(join(repoDir, "notes.txt"), "utf-8")).resolves.toBe(
      "local notes\n",
    );
    await expect(
      execAsync("git status --short -- notes.txt", { cwd: repoDir }),
    ).resolves.toMatchObject({ stdout: "?? notes.txt\n" });
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
      join(repoDir, "data", "archloop", "hub"),
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
      join(repoDir, "data", "archloop", "hub"),
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
        diagnosticSummary: "verification failed",
        logPath: join(context.runDir, "events", "task.jsonl"),
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
            branch: "archloop/bd-conflict-conflict-task",
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
            branch: "archloop/bd-later-later-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
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
            branch: "archloop/bd-failed-failed-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
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
            branch: "archloop/bd-close-close-fail-task",
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
            branch: "archloop/bd-queued-queued-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    const context = createMergeContext(
      repoDir,
      batchId,
      join(repoDir, "data", "archloop", "hub"),
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

    const branch = "archloop/bd-git-feature";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "feature", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const merger = createHubFlowRunMerger({ cwd: repoDir });
    const context = createMergeContext(
      repoDir,
      "batch-default-git",
      join(repoDir, "data", "archloop", "hub"),
    );
    const result = await merger({
      flowId: "no-review",
      runId: context.runId,
      batchId: context.batchId,
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

  it("uses an agent conflict resolver when the default merger hits conflicts", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-agent-resolve-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "shared.txt", "base\n", "initial commit");

    const branch = "archloop/bd-agent-conflict";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "shared.txt", "branch\n", "branch edit");
    await execAsync("git checkout main", { cwd: repoDir });
    await commitFile(repoDir, "shared.txt", "main\n", "main edit");

    const seenInputs: Array<{ conflictedFiles: readonly string[] }> = [];
    const conflictResolver: HubMergeConflictResolver = async (input) => {
      seenInputs.push({ conflictedFiles: input.conflictedFiles });
      expect(input.gitStatus).toContain("UU shared.txt");
      await writeFile(join(repoDir, "shared.txt"), "resolved\n");
      await execAsync("git add shared.txt", { cwd: repoDir });
      await execAsync("git commit --no-edit", { cwd: repoDir });
      return { outcome: "success" };
    };
    const context = createMergeContext(
      repoDir,
      "batch-agent-resolve",
      join(repoDir, "data", "archloop", "hub"),
    );

    const merger = createHubFlowRunMerger({
      cwd: repoDir,
      conflictResolver,
    });
    const result = await merger({
      flowId: "with-review",
      runId: context.runId,
      batchId: context.batchId,
      taskId: "bd-agent",
      title: "Agent conflict",
      branch,
      cwd: repoDir,
      runDir: context.runDir,
    });

    expect(result.outcome).toBe("success");
    expect(seenInputs).toEqual([{ conflictedFiles: ["shared.txt"] }]);
    await expect(readFile(join(repoDir, "shared.txt"), "utf-8")).resolves.toBe(
      "resolved\n",
    );
    await expect(
      execAsync("git diff --name-only --diff-filter=U", { cwd: repoDir }),
    ).resolves.toMatchObject({ stdout: "" });
    await expect(
      execAsync("git rev-parse -q --verify MERGE_HEAD", { cwd: repoDir }),
    ).rejects.toBeTruthy();

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      [
        "merge_conflict_resolution_started",
        "merge_conflict_resolution_succeeded",
      ],
    );
  });

  it("fails agent-assisted merge when the resolver leaves conflicts unresolved", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-batch-merge-agent-unresolved-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "shared.txt", "base\n", "initial commit");

    const branch = "archloop/bd-agent-unresolved";
    await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    await commitFile(repoDir, "shared.txt", "branch\n", "branch edit");
    await execAsync("git checkout main", { cwd: repoDir });
    await commitFile(repoDir, "shared.txt", "main\n", "main edit");

    const context = createMergeContext(
      repoDir,
      "batch-agent-unresolved",
      join(repoDir, "data", "archloop", "hub"),
    );
    const merger = createHubFlowRunMerger({
      cwd: repoDir,
      conflictResolver: async () => ({ outcome: "success" }),
    });
    const result = await merger({
      flowId: "with-review",
      runId: context.runId,
      batchId: context.batchId,
      taskId: "bd-agent-unresolved",
      title: "Agent unresolved",
      branch,
      cwd: repoDir,
      runDir: context.runDir,
    });

    expect(result).toMatchObject({
      outcome: "merge_conflict",
      message: "Merge agent left unresolved conflicts: shared.txt",
    });

    const taskEvents = await readJsonl(
      join(context.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents.map((event) => (event as { type: string }).type)).toEqual(
      ["merge_conflict_resolution_started", "merge_conflict_resolution_failed"],
    );
    expect(taskEvents.at(-1)).toMatchObject({
      failureReason: "merge_conflict",
      diagnosticSummary: expect.stringContaining(
        "Merge agent left unresolved conflicts: shared.txt",
      ),
    });
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
      branch: "archloop/bd-verify-verify",
      cwd: repoDir,
      runDir: join(repoDir, "runs"),
    });
    expect(result.outcome).toBe("success");
  });
});
