import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createHubRunContext } from "./hubExecution.js";
import {
  buildHubTaskStateDoctorModel,
  buildHubTaskStateRepairModel,
  doctorHubTaskState,
  formatHubTaskStateDoctorLines,
  formatHubTaskStateRepairLines,
  hubTaskStateDoctorModelToBlocks,
  hubTaskStateRepairModelToBlocks,
  repairHubTaskState,
  type HubTaskStateDiagnostic,
  type HubTaskStatePlannedRepair,
  type RepairHubTaskStateResult,
} from "./hubTaskStateDoctor.js";
import { createPalette } from "./ansi.js";
import { flattenSectionForLog, renderSection } from "./section.js";
import { formatHubManagedBranchCleanupDiagnosticsLines } from "./taskBoard.js";
import type { HubManagedBranchCleanupEvaluation } from "./hubManagedBranchCleanup.js";
import type { WorktreeLeaseRecord } from "./worktreeLeaseStore.js";

const execAsync = promisify(exec);

interface MockBeadsTask {
  id: string;
  title: string;
  status: string;
  labels: string[];
  metadata: Record<string, unknown>;
}

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
  await writeFile(join(dir, "README.md"), "test\n");
  await execAsync("git add README.md", { cwd: dir });
  await execAsync('git commit -m "initial commit"', { cwd: dir });
};

const writeMockBd = async (
  repoDir: string,
  initialTasks: readonly MockBeadsTask[],
) => {
  seedHubTaskStore(repoDir);
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  const stateFile = join(repoDir, "bd-state.json");
  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));

  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
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
  const task = findTask(readState(), id);
  if (!task) process.exit(1);
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "update" && id) {
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
      XDG_DATA_HOME: join(repoDir, ".test-xdg-data"),
    },
    stateFile,
  };
};

describe("doctorHubTaskState", () => {
  it("reports merge-ready run history with stale Beads projection without mutating state", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-doctor-qa-"));
    await initRepo(repoDir);

    const initialTasks: MockBeadsTask[] = [
      {
        id: "bd-qa",
        title: "QA incident",
        status: "open",
        labels: ["ready-for-agent", "customer-label"],
        metadata: { hubStatus: "ready_for_agent", owner: "platform" },
      },
    ];
    const { env, stateFile } = await writeMockBd(repoDir, initialTasks);
    const context = createHubRunContext({
      cwd: repoDir,
      env,
      branch: "flow/with-review",
      batchId: "batch-qa",
      runId: "run-qa",
    });
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_review_succeeded",
        runId: context.runId,
        batchId: context.batchId,
        taskId: "bd-qa",
        branch: "archloop/bd-qa-qa-incident",
        createdAt: "2026-06-20T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 1,
      })}\n`,
    );

    const result = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-qa",
        reason: "state_inconsistent",
        repairable: true,
        targetStatus: "waiting_for_merge",
        nextAction: "archloop tasks repair-state bd-qa",
      }),
    );
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(initialTasks);
  });

  it("reports worktree lease claim and occupancy mismatches", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-doctor-lease-"));
    await initRepo(repoDir);

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-lease",
        title: "Lease mismatch",
        status: "open",
        labels: ["implementing"],
        metadata: {
          hubStatus: "implementing",
          claim: {
            runId: "run-lease",
            batchId: "batch-lease",
            branch: "archloop/bd-lease-lease-mismatch",
            claimedAt: "2026-06-22T10:00:00.000Z",
          },
        },
      },
    ]);

    const result = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: false,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
      listWorktreeLeases: () => [],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-lease",
        reason: "worktree_lease_missing",
        nextAction: expect.stringContaining("Rerun the flow"),
      }),
    );
  });

  const buildStaleLease = (branch: string): readonly WorktreeLeaseRecord[] => [
    {
      lockFileName: `${branch.replace(/\//g, "-")}.lock`,
      worktreeName: branch.replace(/\//g, "-"),
      branch,
      pid: 4242,
      acquiredAt: "2026-06-22T10:00:00.000Z",
      owner: { kind: "hub", taskId: "" },
      state: "stale",
      malformed: false,
    },
  ];

  it("reports an interrupted reviewing task with a stale lease as interrupted_execution", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-doctor-interrupted-reviewing-"),
    );
    await initRepo(repoDir);
    const branch = "archloop/bd-int-reviewing-interrupted-review";

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-int-reviewing",
        title: "Interrupted review",
        status: "in_progress",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: {
            runId: "run-int",
            batchId: "batch-int",
            branch,
            claimedAt: "2026-06-22T10:00:00.000Z",
          },
        },
      },
    ]);

    const result = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: false,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
      listWorktreeLeases: () => buildStaleLease(branch),
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-int-reviewing",
        reason: "interrupted_execution",
        repairable: false,
        currentStatus: "reviewing",
        branch,
        nextAction:
          "Implement was interrupted — run archloop tasks recover bd-int-reviewing to retry.",
      }),
    );
    // No lease diagnostic should fire for an active-claim + stale-lease task, so
    // interrupted_execution is the sole diagnostic (no worktree_lease_* duplicate).
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.taskId === "bd-int-reviewing",
      ),
    ).toHaveLength(1);
  });

  it("reports an interrupted implementing task with a stale lease as interrupted_execution", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-doctor-interrupted-implementing-"),
    );
    await initRepo(repoDir);
    const branch = "archloop/bd-int-impl-interrupted-impl";

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-int-impl",
        title: "Interrupted implement",
        status: "in_progress",
        labels: ["implementing"],
        metadata: {
          hubStatus: "implementing",
          claim: {
            runId: "run-int-impl",
            batchId: "batch-int-impl",
            branch,
            claimedAt: "2026-06-22T10:00:00.000Z",
          },
        },
      },
    ]);

    const result = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: false,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
      listWorktreeLeases: () => buildStaleLease(branch),
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-int-impl",
        reason: "interrupted_execution",
        repairable: false,
        currentStatus: "implementing",
        nextAction:
          "Implement was interrupted — run archloop tasks recover bd-int-impl to retry.",
      }),
    );
  });

  it("does not report interrupted_execution when a live worktree lease exists", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-doctor-interrupted-live-"),
    );
    await initRepo(repoDir);
    const branch = "archloop/bd-live-review-live-review";

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-live-review",
        title: "Live review",
        status: "in_progress",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: {
            runId: "run-live",
            batchId: "batch-live",
            branch,
            claimedAt: "2026-06-22T10:00:00.000Z",
          },
        },
      },
    ]);

    const result = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: false,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
      listWorktreeLeases: () => [
        {
          lockFileName: `${branch.replace(/\//g, "-")}.lock`,
          worktreeName: branch.replace(/\//g, "-"),
          branch,
          pid: 4242,
          acquiredAt: "2026-06-22T10:00:00.000Z",
          owner: { kind: "hub", taskId: "bd-live-review" },
          state: "active",
          malformed: false,
        },
      ],
    });

    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.reason === "interrupted_execution",
      ),
    ).toBe(false);
  });

  it("dedupes interrupted_execution against worktree_lease_missing for an implementing task with no lease", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-doctor-interrupted-dedupe-"),
    );
    await initRepo(repoDir);
    const branch = "archloop/bd-dedupe-impl-dedupe";

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-dedupe-impl",
        title: "Dedupe impl",
        status: "in_progress",
        labels: ["implementing"],
        metadata: {
          hubStatus: "implementing",
          claim: {
            runId: "run-dedupe",
            batchId: "batch-dedupe",
            branch,
            claimedAt: "2026-06-22T10:00:00.000Z",
          },
        },
      },
    ]);

    const result = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: false,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
      listWorktreeLeases: () => [],
    });

    // implementing + active claim + absent lease is already worktree_lease_missing;
    // interrupted_execution must NOT also fire for the same task.
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-dedupe-impl",
        reason: "worktree_lease_missing",
      }),
    );
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.taskId === "bd-dedupe-impl",
      ),
    ).toHaveLength(1);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.reason === "interrupted_execution",
      ),
    ).toBe(false);
  });

  it("enriches the interrupted_execution next action when a finished-phase event is present", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-doctor-interrupted-event-"),
    );
    await initRepo(repoDir);
    const branch = "archloop/bd-evt-review-interrupted-review";

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-evt-review",
        title: "Interrupted review",
        status: "in_progress",
        labels: ["reviewing"],
        metadata: {
          hubStatus: "reviewing",
          claim: {
            runId: "run-evt",
            batchId: "batch-evt",
            branch,
            claimedAt: "2026-06-22T10:00:00.000Z",
          },
        },
      },
    ]);
    const context = createHubRunContext({
      cwd: repoDir,
      env,
      branch: "flow/with-review",
      batchId: "batch-evt",
      runId: "run-evt",
    });
    // task_implementation_succeeded with status "reviewing" is the reviewer-flow
    // phase-completion signal (implementation finished, review was next). It is
    // NOT a merge-ready event, so it does not collide with the doctor's
    // state_inconsistent path; the interrupted_execution next action reflects it.
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_implementation_succeeded",
        runId: context.runId,
        batchId: context.batchId,
        taskId: "bd-evt-review",
        branch,
        createdAt: "2026-06-22T10:15:00.000Z",
        status: "reviewing",
        commitCount: 1,
      })}\n`,
    );

    const result = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: false,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
      listWorktreeLeases: () => buildStaleLease(branch),
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-evt-review",
        reason: "interrupted_execution",
        repairable: false,
        currentStatus: "reviewing",
        nextAction:
          "Review/merge already finished — run archloop tasks recover bd-evt-review to advance.",
      }),
    );
  });

  it("reports an interrupted merging task with a stale lease as interrupted_execution", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-doctor-interrupted-merging-"),
    );
    await initRepo(repoDir);
    const branch = "archloop/bd-int-merging-interrupted-merge";

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-int-merging",
        title: "Interrupted merge",
        status: "in_progress",
        labels: ["merging"],
        metadata: {
          hubStatus: "merging",
          claim: {
            runId: "run-int-merging",
            batchId: "batch-int-merging",
            branch,
            claimedAt: "2026-06-22T10:00:00.000Z",
          },
        },
      },
    ]);

    const result = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: false,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
      listWorktreeLeases: () => buildStaleLease(branch),
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-int-merging",
        reason: "interrupted_execution",
        repairable: false,
        currentStatus: "merging",
        branch,
        nextAction:
          "Implement was interrupted — run archloop tasks recover bd-int-merging to retry.",
      }),
    );
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.taskId === "bd-int-merging",
      ),
    ).toHaveLength(1);
  });

  it("groups interrupted_execution diagnostics under the error severity with the recover action as a trailing hint", () => {
    // The interrupted_execution nextAction leads with prose ("Implement was
    // interrupted — run archloop tasks recover <id>"), not a command prefix.
    // The section-block presenter maps the reason to the error severity and
    // renders the full next action as a dim trailing hint (not a re-labeled
    // "rerun flow" summary), with the human message as a dim continuation line.
    const model = buildHubTaskStateDoctorModel({
      diagnostics: [
        {
          taskId: "bd-render",
          title: "Render check",
          reason: "interrupted_execution",
          message:
            "Task bd-render is stuck in reviewing with a stale worktree lease and no phase-completion event; recover to retry the interrupted execution.",
          nextAction:
            "Implement was interrupted — run archloop tasks recover bd-render to retry.",
          repairable: false,
          currentStatus: "reviewing",
          branch: "archloop/bd-render-render-check",
        },
      ],
      managedBranchCleanupDiagnostics: [],
    });

    expect(model.badges.badges).toEqual([
      { symbol: "✗", count: 1, label: "error", severity: "error" },
    ]);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({ severity: "error", count: 1 });
    expect(model.groups[0]!.items).toEqual([
      {
        id: "bd-render",
        title: "interrupted_execution",
        trailingDim:
          "Implement was interrupted — run archloop tasks recover bd-render to retry.",
        detailDim:
          "Task bd-render is stuck in reviewing with a stale worktree lease and no phase-completion event; recover to retry the interrupted execution.",
      },
    ]);

    const lines = formatHubTaskStateDoctorLines({
      diagnostics: [
        {
          taskId: "bd-render",
          title: "Render check",
          reason: "interrupted_execution",
          message:
            "Task bd-render is stuck in reviewing with a stale worktree lease and no phase-completion event; recover to retry the interrupted execution.",
          nextAction:
            "Implement was interrupted — run archloop tasks recover bd-render to retry.",
          repairable: false,
          currentStatus: "reviewing",
          branch: "archloop/bd-render-render-check",
        },
      ],
      managedBranchCleanupDiagnostics: [],
    });

    // Plain (flattenSectionForLog) equivalence: every id, reason, next action,
    // and message survives, with no ANSI and no "rerun flow" summary.
    expect(lines.join("\n")).toContain("bd-render");
    expect(lines.join("\n")).toContain("interrupted_execution");
    expect(lines.join("\n")).toContain("archloop tasks recover bd-render");
    expect(lines.join("\n")).toContain(
      "Task bd-render is stuck in reviewing with a stale worktree lease",
    );
    expect(lines.join("\n")).not.toContain("rerun flow");
  });

  it("previews repair-state mutations without mutating Beads by default", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-repair-preview-"));
    await initRepo(repoDir);

    const initialTasks: MockBeadsTask[] = [
      {
        id: "bd-preview",
        title: "Preview repair",
        status: "open",
        labels: ["ready-for-agent", "customer-label"],
        metadata: { hubStatus: "ready_for_agent", owner: "platform" },
      },
    ];
    const { env, stateFile } = await writeMockBd(repoDir, initialTasks);
    const context = createHubRunContext({
      cwd: repoDir,
      env,
      branch: "flow/with-review",
      batchId: "batch-preview",
      runId: "run-preview",
    });
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_review_succeeded",
        runId: context.runId,
        batchId: context.batchId,
        taskId: "bd-preview",
        branch: "archloop/bd-preview-preview-repair",
        createdAt: "2026-06-20T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 1,
      })}\n`,
    );

    const result = await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-preview",
      env,
      yes: false,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(result.applied).toBe(false);
    expect(result.plannedRepairs).toContainEqual(
      expect.objectContaining({
        taskId: "bd-preview",
        targetStatus: "waiting_for_merge",
      }),
    );
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(initialTasks);
  });

  it("repairs QA incident shape to waiting_for_merge while preserving custom labels", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-repair-apply-"));
    await initRepo(repoDir);

    const { env, stateFile } = await writeMockBd(repoDir, [
      {
        id: "bd-apply",
        title: "Apply repair",
        status: "open",
        labels: ["ready-for-agent", "customer-label"],
        metadata: { hubStatus: "ready_for_agent", owner: "platform" },
      },
    ]);
    const context = createHubRunContext({
      cwd: repoDir,
      env,
      branch: "flow/with-review",
      batchId: "batch-apply",
      runId: "run-apply",
    });
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_review_succeeded",
        runId: context.runId,
        batchId: context.batchId,
        taskId: "bd-apply",
        branch: "archloop/bd-apply-apply-repair",
        createdAt: "2026-06-20T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 1,
      })}\n`,
    );

    const result = await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-apply",
      env,
      yes: true,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(result.applied).toBe(true);
    const task = (
      JSON.parse(await readFile(stateFile, "utf8")) as MockBeadsTask[]
    )[0]!;
    expect(task).toMatchObject({
      id: "bd-apply",
      status: "in_progress",
      labels: ["customer-label", "waiting-for-merge"],
      metadata: {
        hubStatus: "waiting_for_merge",
        owner: "platform",
        claim: {
          runId: "run-apply",
          batchId: "batch-apply",
          branch: "archloop/bd-apply-apply-repair",
        },
      },
    });
  });

  it("replaces stale claim metadata with the merge-ready event claim during repair-state", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-repair-stale-claim-"),
    );
    await initRepo(repoDir);

    const { env, stateFile } = await writeMockBd(repoDir, [
      {
        id: "bd-stale-claim",
        title: "Stale claim",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-old",
            batchId: "batch-old",
            branch: "archloop/old-branch",
            claimedAt: "2026-06-19T10:00:00.000Z",
          },
        },
      },
    ]);
    const context = createHubRunContext({
      cwd: repoDir,
      env,
      branch: "flow/with-review",
      batchId: "batch-new",
      runId: "run-new",
    });
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_review_succeeded",
        runId: context.runId,
        batchId: context.batchId,
        taskId: "bd-stale-claim",
        branch: "archloop/bd-stale-claim-stale-claim",
        createdAt: "2026-06-20T10:15:00.000Z",
        status: "waiting_for_merge",
        commitCount: 1,
      })}\n`,
    );

    await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-stale-claim",
      env,
      yes: true,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    const task = (
      JSON.parse(await readFile(stateFile, "utf8")) as MockBeadsTask[]
    )[0]!;
    expect(task.metadata.claim).toMatchObject({
      runId: "run-new",
      batchId: "batch-new",
      branch: "archloop/bd-stale-claim-stale-claim",
    });
  });

  it("classifies dirty worktree as a Git safety gate and does not repair it", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-doctor-dirty-"));
    await initRepo(repoDir);

    const initialTasks: MockBeadsTask[] = [
      {
        id: "bd-dirty",
        title: "Dirty worktree",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-dirty",
            batchId: "batch-dirty",
            branch: "archloop/bd-dirty-dirty-worktree",
            claimedAt: "2026-06-20T10:00:00.000Z",
          },
        },
      },
    ];
    const { env, stateFile } = await writeMockBd(repoDir, initialTasks);

    const doctor = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: ["src/app.ts"],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(doctor.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-dirty",
        reason: "dirty_worktree",
        repairable: false,
        nextAction:
          "Commit, stash, or discard dirty source files, then rerun the flow.",
      }),
    );

    const repair = await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-dirty",
      env,
      yes: true,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: ["src/app.ts"],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(repair.applied).toBe(false);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(initialTasks);
  });

  it("repairs multiple archLoop status labels while preserving user labels", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-repair-labels-"));
    await initRepo(repoDir);

    const { env, stateFile } = await writeMockBd(repoDir, [
      {
        id: "bd-labels",
        title: "Label pollution",
        status: "in_progress",
        labels: ["ready-for-agent", "waiting-for-merge", "customer-label"],
        metadata: {
          hubStatus: "waiting_for_merge",
          claim: {
            runId: "run-labels",
            batchId: "batch-labels",
            branch: "archloop/bd-labels-label-pollution",
            claimedAt: "2026-06-20T10:00:00.000Z",
          },
        },
      },
    ]);

    const doctor = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(doctor.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-labels",
        reason: "multiple_status_labels",
        repairable: true,
        targetStatus: "waiting_for_merge",
      }),
    );

    const repair = await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-labels",
      env,
      yes: true,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(repair.applied).toBe(true);
    const task = (
      JSON.parse(await readFile(stateFile, "utf8")) as MockBeadsTask[]
    )[0]!;
    expect(task.labels).toEqual(["customer-label", "waiting-for-merge"]);
  });

  it("repairs stale metadata hubStatus to match the projected Hub status", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-repair-metadata-"));
    await initRepo(repoDir);

    const { env, stateFile } = await writeMockBd(repoDir, [
      {
        id: "bd-metadata",
        title: "Metadata pollution",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "reviewing",
          claim: {
            runId: "run-metadata",
            batchId: "batch-metadata",
            branch: "archloop/bd-metadata-metadata-pollution",
            claimedAt: "2026-06-20T10:00:00.000Z",
          },
        },
      },
    ]);

    const doctor = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(doctor.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-metadata",
        reason: "stale_hub_status_metadata",
        repairable: true,
        targetStatus: "waiting_for_merge",
      }),
    );

    await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-metadata",
      env,
      yes: true,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    const task = (
      JSON.parse(await readFile(stateFile, "utf8")) as MockBeadsTask[]
    )[0]!;
    expect(task.metadata.hubStatus).toBe("waiting_for_merge");
  });

  it("reports missing execution claim fields without repairing when no run event can supply them", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-doctor-missing-claim-"),
    );
    await initRepo(repoDir);

    const initialTasks: MockBeadsTask[] = [
      {
        id: "bd-missing-claim",
        title: "Missing claim",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: { hubStatus: "waiting_for_merge" },
      },
    ];
    const { env, stateFile } = await writeMockBd(repoDir, initialTasks);

    const doctor = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(doctor.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-missing-claim",
        reason: "missing_claim_fields",
        repairable: false,
        missingClaimFields: ["runId", "batchId", "branch"],
        nextAction:
          "Rerun the flow to recreate execution claim metadata, or recover the task if the execution was abandoned.",
      }),
    );

    const repair = await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-missing-claim",
      env,
      yes: true,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(repair.applied).toBe(false);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(initialTasks);
  });

  it("reports failed tasks with branch work as recovery work, not repair-state", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-doctor-failed-"));
    await initRepo(repoDir);

    const { env } = await writeMockBd(repoDir, [
      {
        id: "bd-failed",
        title: "Failed with work",
        status: "open",
        labels: ["failed"],
        metadata: {
          hubStatus: "failed",
          failed: true,
          failureReason: "agent_failed",
          claim: {
            runId: "run-failed",
            batchId: "batch-failed",
            branch: "archloop/bd-failed-failed-with-work",
            claimedAt: "2026-06-20T10:00:00.000Z",
          },
        },
      },
    ]);

    const doctor = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(doctor.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-failed",
        reason: "failed_branch_work",
        repairable: false,
        nextAction: "archloop tasks recover bd-failed",
      }),
    );
  });

  it("does not promote failed agent attempts with no commits and no branch work", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-task-repair-failed-no-work-"),
    );
    await initRepo(repoDir);

    const initialTasks: MockBeadsTask[] = [
      {
        id: "bd-failed-empty",
        title: "Failed empty",
        status: "open",
        labels: ["failed"],
        metadata: {
          hubStatus: "failed",
          failed: true,
          failureReason: "agent_failed",
          claim: {
            runId: "run-empty",
            batchId: "batch-empty",
            branch: "archloop/bd-failed-empty-failed-empty",
            claimedAt: "2026-06-20T10:00:00.000Z",
          },
        },
      },
    ];
    const { env, stateFile } = await writeMockBd(repoDir, initialTasks);
    const context = createHubRunContext({
      cwd: repoDir,
      env,
      branch: "flow/no-review",
      batchId: "batch-empty",
      runId: "run-empty",
    });
    writeFileSync(
      join(context.runDir, "events", "task.jsonl"),
      `${JSON.stringify({
        type: "task_implementation_failed",
        runId: context.runId,
        batchId: context.batchId,
        taskId: "bd-failed-empty",
        branch: "archloop/bd-failed-empty-failed-empty",
        createdAt: "2026-06-20T10:15:00.000Z",
        status: "failed",
        failureReason: "agent_failed",
        commitCount: 0,
        branchHasUnmergedWork: false,
      })}\n`,
    );

    const repair = await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-failed-empty",
      env,
      yes: true,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: false,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(repair.applied).toBe(false);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(initialTasks);
  });

  it("repairs terminal tasks by clearing stale execution claim metadata", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-task-repair-terminal-"));
    await initRepo(repoDir);

    const { env, stateFile } = await writeMockBd(repoDir, [
      {
        id: "bd-done",
        title: "Done task",
        status: "closed",
        labels: ["done"],
        metadata: {
          hubStatus: "done",
          done: true,
          claim: {
            runId: "run-done",
            batchId: "batch-done",
            branch: "archloop/bd-done-done-task",
            claimedAt: "2026-06-20T10:00:00.000Z",
          },
        },
      },
    ]);

    const doctor = await doctorHubTaskState({
      cwd: repoDir,
      env,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    expect(doctor.diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-done",
        reason: "terminal_stale_execution_metadata",
        repairable: true,
        targetStatus: "done",
      }),
    );

    await repairHubTaskState({
      cwd: repoDir,
      taskSelector: "bd-done",
      env,
      yes: true,
      branchInspector: async () => ({
        exists: true,
        hasUnmergedWork: true,
      }),
      worktreeInspector: async () => ({
        dirtySourceFiles: [],
        dirtyTaskStoreFiles: [],
      }),
    });

    const task = (
      JSON.parse(await readFile(stateFile, "utf8")) as MockBeadsTask[]
    )[0]!;
    expect(task.status).toBe("closed");
    expect(task.labels).toEqual(["done"]);
    expect(task.metadata.claim).toBeUndefined();
    expect(task.metadata.hubStatus).toBe("done");
  });

  it("renders managed branch cleanup diagnostics with next actions", () => {
    const cleanupEvaluation = {
      repoRoot: "/tmp/repo",
      hubProjectDir: "/tmp/data/archloop/hub/projects/demo",
      targetBranch: "main",
      targetHead: "abc123",
      managedSafeCandidates: [
        {
          branch: "archloop/bd-safe-cleanup",
          ownership: {
            taskId: "bd-safe",
            runId: "run-safe",
            batchId: "batch-safe",
            branch: "archloop/bd-safe-cleanup",
            claimedAt: "2026-07-05T10:00:00.000Z",
            baseHead: "abc123",
            branchExistedBeforeClaim: false,
          },
          exists: true,
          mergedIntoTarget: true,
          worktreePaths: [],
          activeLeases: [],
          skipReasons: [],
        },
      ],
      managedBlockedBranches: [
        {
          branch: "archloop/bd-blocked-cleanup",
          ownership: {
            taskId: "bd-blocked",
            runId: "run-blocked",
            batchId: "batch-blocked",
            branch: "archloop/bd-blocked-cleanup",
            claimedAt: "2026-07-05T10:05:00.000Z",
            baseHead: "abc123",
            branchExistedBeforeClaim: true,
          },
          exists: true,
          mergedIntoTarget: false,
          worktreePaths: [],
          activeLeases: [],
          skipReasons: [
            {
              reason: "branch_existed_before_claim",
              message:
                "Branch archloop/bd-blocked-cleanup existed before Hub claimed task bd-blocked; keep it out of automatic cleanup.",
            },
          ],
        },
      ],
      unownedCandidates: [
        {
          branch: "archloop/unowned-history",
          exists: true,
          mergedIntoTarget: true,
          worktreePaths: [],
          activeLeases: [],
          skipReasons: [
            {
              reason: "missing_ownership",
              message:
                "Branch archloop/unowned-history has no Hub-managed ownership record.",
            },
          ],
        },
      ],
    } satisfies HubManagedBranchCleanupEvaluation;

    const lines = formatHubTaskStateDoctorLines({
      diagnostics: [],
      managedBranchCleanupDiagnostics:
        formatHubManagedBranchCleanupDiagnosticsLines(cleanupEvaluation),
    });

    expect(lines.join("\n")).toContain("Managed branch cleanup diagnostics");
    expect(lines.join("\n")).toContain("Safe managed candidates (1)");
    expect(lines.join("\n")).toContain(
      "Next action: Run `archloop tasks cleanup --yes` to delete this safe managed branch.",
    );
    expect(lines.join("\n")).toContain("Blocked managed candidates (1)");
    expect(lines.join("\n")).toContain(
      "Preserve this branch; it existed before Hub claimed the task.",
    );
    expect(lines.join("\n")).toContain("Historical unowned candidates (1)");
    expect(lines.join("\n")).toContain(
      "Use `archloop tasks cleanup --yes --include-unowned` to include this safe historical branch.",
    );
  });
});

describe("buildHubTaskStateDoctorModel", () => {
  const diagnostic = (
    overrides: Partial<HubTaskStateDiagnostic> & {
      taskId: string;
      reason: HubTaskStateDiagnostic["reason"];
      nextAction: string;
      message: string;
    },
  ): HubTaskStateDiagnostic => ({
    title: overrides.taskId,
    repairable: false,
    currentStatus: "inbox",
    ...overrides,
  });

  it("maps each reason to its severity and groups one block per severity in error-warn-info order", () => {
    const model = buildHubTaskStateDoctorModel({
      diagnostics: [
        diagnostic({
          taskId: "bd-orphan",
          reason: "terminal_stale_execution_metadata",
          nextAction: "archloop tasks repair-state bd-orphan",
          message: "Terminal task still has execution claim metadata.",
        }),
        diagnostic({
          taskId: "bd-failed",
          reason: "failed_branch_work",
          nextAction: "archloop tasks recover bd-failed",
          message: "Failed task still has unmerged branch work.",
        }),
        diagnostic({
          taskId: "bd-stale",
          reason: "state_inconsistent",
          nextAction: "archloop tasks repair-state bd-stale",
          message: "Hub run events show a finished phase.",
        }),
        diagnostic({
          taskId: "bd-interrupted",
          reason: "interrupted_execution",
          nextAction:
            "Implement was interrupted — run archloop tasks recover bd-interrupted to retry.",
          message: "Task bd-interrupted is stuck in implementing.",
        }),
        diagnostic({
          taskId: "bd-sync",
          reason: "task_sync_push_pending",
          nextAction: "archloop tasks push",
          message: "Local task state is pending remote sync.",
        }),
      ],
      managedBranchCleanupDiagnostics: [],
    });

    // Badge counts summarize the diagnostics by severity and match the totals.
    expect(model.badges.badges).toEqual([
      { symbol: "✗", count: 2, label: "error", severity: "error" },
      { symbol: "!", count: 2, label: "warn", severity: "warn" },
      { symbol: "●", count: 1, label: "info", severity: "info" },
    ]);

    // One group per severity, in fixed error → warn → info order.
    expect(model.groups.map((group) => group.severity)).toEqual([
      "error",
      "warn",
      "info",
    ]);
    expect(model.groups.map((group) => group.count)).toEqual([2, 2, 1]);

    // Each group carries its severity symbol and name, and items are sorted by
    // task id within the group.
    expect(model.groups[0]).toMatchObject({
      severity: "error",
      symbol: "✗",
      name: "error",
      count: 2,
    });
    expect(model.groups[0]!.items.map((item) => item.id)).toEqual([
      "bd-failed",
      "bd-interrupted",
    ]);
    expect(model.groups[1]!.items.map((item) => item.id)).toEqual([
      "bd-stale",
      "bd-sync",
    ]);
    expect(model.groups[2]!.items.map((item) => item.id)).toEqual([
      "bd-orphan",
    ]);
  });

  it("renders each item with the reason as title, next action as trailing hint, and message as continuation line", () => {
    const model = buildHubTaskStateDoctorModel({
      diagnostics: [
        diagnostic({
          taskId: "bd-failed",
          reason: "failed_branch_work",
          nextAction: "archloop tasks recover bd-failed",
          message: "Failed task still has unmerged branch work on the branch.",
        }),
      ],
      managedBranchCleanupDiagnostics: [],
    });

    expect(model.groups[0]!.items).toEqual([
      {
        id: "bd-failed",
        title: "failed_branch_work",
        trailingDim: "archloop tasks recover bd-failed",
        detailDim: "Failed task still has unmerged branch work on the branch.",
      },
    ]);
  });

  it("omits badges and groups when there are no diagnostics and shows an empty message", () => {
    const model = buildHubTaskStateDoctorModel({
      diagnostics: [],
      managedBranchCleanupDiagnostics: [],
    });

    expect(model.badges.badges).toEqual([]);
    expect(model.groups).toEqual([]);
    expect(model.emptyMessage).toEqual({
      kind: "prose",
      body: "No task state issues found.",
    });
  });

  it("only emits badges/groups for severities that are present", () => {
    const model = buildHubTaskStateDoctorModel({
      diagnostics: [
        diagnostic({
          taskId: "bd-stale",
          reason: "multiple_status_labels",
          nextAction: "archloop tasks repair-state bd-stale",
          message: "Beads labels contain multiple archLoop status labels.",
        }),
      ],
      managedBranchCleanupDiagnostics: [],
    });

    // Only the warn severity is present — no error/info badge or group.
    expect(model.badges.badges).toEqual([
      { symbol: "!", count: 1, label: "warn", severity: "warn" },
    ]);
    expect(model.groups.map((group) => group.severity)).toEqual(["warn"]);
  });
});

describe("hubTaskStateDoctorModelToBlocks / formatHubTaskStateDoctorLines (presentation)", () => {
  const sampleDiagnostics: HubTaskStateDiagnostic[] = [
    {
      taskId: "bd-err",
      title: "Err task",
      reason: "interrupted_execution",
      repairable: false,
      currentStatus: "reviewing",
      branch: "archloop/bd-err-err-task",
      nextAction:
        "Implement was interrupted — run archloop tasks recover bd-err to retry.",
      message:
        "Task bd-err is stuck in reviewing with a stale worktree lease and no phase-completion event; recover to retry the interrupted execution.",
    },
    {
      taskId: "bd-warn",
      title: "Warn task",
      reason: "state_inconsistent",
      repairable: true,
      currentStatus: "ready_for_agent",
      targetStatus: "waiting_for_merge",
      branch: "archloop/bd-warn-warn-task",
      nextAction: "archloop tasks repair-state bd-warn",
      message:
        "Hub run events show task_review_succeeded for the branch, but Beads projects ready_for_agent.",
    },
    {
      taskId: "bd-info",
      title: "Info task",
      reason: "terminal_stale_execution_metadata",
      repairable: true,
      currentStatus: "done",
      targetStatus: "done",
      branch: "archloop/bd-info-info-task",
      nextAction: "archloop tasks repair-state bd-info",
      message: "Terminal task done still has execution claim metadata.",
    },
  ];

  it("plain (flattenSectionForLog) output preserves every id, reason, message, and next-action with no ANSI", () => {
    const lines = formatHubTaskStateDoctorLines({
      diagnostics: sampleDiagnostics,
      managedBranchCleanupDiagnostics: [],
    });
    const text = lines.join("\n");

    expect(text).not.toMatch(/\x1b\[/);
    expect(text).toContain("Hub task state doctor");
    expect(text).toContain("3 issues");
    // Badges row summarizes counts by severity.
    expect(text).toContain("✗ 1 error");
    expect(text).toContain("! 1 warn");
    expect(text).toContain("● 1 info");
    // Each diagnostic's task id, reason, next action, and message survive.
    for (const diagnostic of sampleDiagnostics) {
      expect(text).toContain(diagnostic.taskId);
      expect(text).toContain(diagnostic.reason);
      expect(text).toContain(diagnostic.nextAction);
      expect(text).toContain(diagnostic.message);
    }
  });

  it("appends checkout sync pending diagnostics without recover guidance", () => {
    const lines = formatHubTaskStateDoctorLines({
      diagnostics: [],
      managedBranchCleanupDiagnostics: [],
      landingDiagnostics: [
        "Checkout sync pending for bd-land (unstaged_changes): host branch main was not updated. Landed candidate cccccccccccccccccccccccccccccccccccccccc remains on the Hub publish target and the task can stay shipped. This is not a task failure and does not require a recovery command.",
        "Next action: Wait for the automatic retry; Hub will fast-forward the host branch when Git can prove the checkout safe.",
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("Checkout sync pending");
    expect(text).toContain("Wait for the automatic retry");
    expect(text).not.toMatch(/tasks recover/);
  });

  it("color render distinguishes severities (error red, warn yellow, info cyan)", () => {
    const palette = createPalette(true);
    const blocks = hubTaskStateDoctorModelToBlocks(
      buildHubTaskStateDoctorModel({
        diagnostics: sampleDiagnostics,
        managedBranchCleanupDiagnostics: [],
      }),
    );
    const rendered = renderSection("", blocks, {
      width: 100,
      colorEnabled: true,
    }).join("\n");

    // The error group symbol and the interrupted next action render in red.
    expect(rendered).toContain(palette.red("✗"));
    expect(rendered).toContain(
      palette.dim(
        "Implement was interrupted — run archloop tasks recover bd-err to retry.",
      ),
    );
    // The warn group symbol renders in yellow; the info group symbol in cyan.
    expect(rendered).toContain(palette.yellow("!"));
    expect(rendered).toContain(palette.cyan("●"));
  });

  it("appends managed branch cleanup diagnostics after the flattened section", () => {
    const lines = formatHubTaskStateDoctorLines({
      diagnostics: sampleDiagnostics,
      managedBranchCleanupDiagnostics: [
        "Managed branch cleanup diagnostics",
        "Target branch: main",
      ],
    });

    expect(lines.join("\n")).toContain("Managed branch cleanup diagnostics");
    expect(lines.join("\n")).toContain("Target branch: main");
  });
});

describe("buildHubTaskStateRepairModel", () => {
  const sampleRepairs: HubTaskStatePlannedRepair[] = [
    {
      taskId: "bd-merge",
      title: "Merge-ready repair",
      reason: "state_inconsistent",
      targetStatus: "waiting_for_merge",
      branch: "archloop/bd-merge-merge-ready-repair",
    },
    {
      taskId: "bd-ready",
      title: "Ready repair",
      reason: "interrupted_execution",
      targetStatus: "ready_for_agent",
      branch: "archloop/bd-ready-ready-repair",
    },
    {
      taskId: "bd-done",
      title: "Terminal repair",
      reason: "terminal_stale_execution_metadata",
      targetStatus: "done",
      branch: "archloop/bd-done-terminal-repair",
    },
  ];

  it("groups repairs by target status with board-bucket severity and planned heading", () => {
    const model = buildHubTaskStateRepairModel({
      applied: false,
      plannedRepairs: sampleRepairs,
    });

    expect(model.header).toMatchObject({
      kind: "header",
      title: "Hub task state repair",
      subtitle: "Planned repairs",
      right: "3 repairs",
    });
    expect(model.emptyMessage).toBeUndefined();
    expect(model.guidance?.body).toContain("Re-run with --yes");
    // Bucket order: todo (ready_for_agent) → in_progress (waiting_for_merge) → done.
    expect(model.groups.map((group) => group.name)).toEqual([
      "ready_for_agent",
      "waiting_for_merge",
      "done",
    ]);
    expect(model.groups.map((group) => group.severity)).toEqual([
      "info",
      "warn",
      "success",
    ]);
    expect(model.groups.map((group) => group.symbol)).toEqual(["●", "◐", "✓"]);
    expect(model.groups[0]?.items).toEqual([
      {
        id: "bd-ready",
        title: "interrupted_execution",
        trailingDim: "archloop/bd-ready-ready-repair",
      },
    ]);
  });

  it("uses Applied repairs heading and omits guidance when applied", () => {
    const model = buildHubTaskStateRepairModel({
      applied: true,
      plannedRepairs: [sampleRepairs[0]!],
    });

    expect(model.header.subtitle).toBe("Applied repairs");
    expect(model.header.right).toBe("1 repair");
    expect(model.guidance).toBeUndefined();
  });

  it("returns empty prose when there are no planned repairs", () => {
    const model = buildHubTaskStateRepairModel({
      applied: false,
      plannedRepairs: [],
    });

    expect(model.header.title).toBe("Hub task state repair");
    expect(model.header.subtitle).toBeUndefined();
    expect(model.header.right).toBeUndefined();
    expect(model.emptyMessage?.body).toBe(
      "No repairable task state issues found.",
    );
    expect(model.groups).toEqual([]);
    expect(model.guidance).toBeUndefined();
  });
});

describe("hubTaskStateRepairModelToBlocks / formatHubTaskStateRepairLines (presentation)", () => {
  const plannedResult: RepairHubTaskStateResult = {
    applied: false,
    plannedRepairs: [
      {
        taskId: "bd-merge",
        title: "Merge-ready repair",
        reason: "state_inconsistent",
        targetStatus: "waiting_for_merge",
        branch: "archloop/bd-merge-merge-ready-repair",
      },
      {
        taskId: "bd-fail",
        title: "Failed repair",
        reason: "stale_hub_status_metadata",
        targetStatus: "failed",
        branch: "archloop/bd-fail-failed-repair",
      },
    ],
  };

  it("plain (flattenSectionForLog) preserves every id, reason, target status, and branch with no ANSI", () => {
    const lines = formatHubTaskStateRepairLines(plannedResult);
    const text = lines.join("\n");

    expect(text).not.toMatch(/\x1b\[/);
    expect(text).toContain("Hub task state repair");
    expect(text).toContain("Planned repairs");
    expect(text).toContain(
      "Re-run with --yes to apply these local Beads mutations.",
    );
    for (const repair of plannedResult.plannedRepairs) {
      expect(text).toContain(repair.taskId);
      expect(text).toContain(repair.reason);
      expect(text).toContain(repair.targetStatus);
      expect(text).toContain(repair.branch!);
    }

    // formatHubTaskStateRepairLines is flattenSectionForLog of the same blocks.
    expect(lines).toEqual(
      flattenSectionForLog(
        hubTaskStateRepairModelToBlocks(
          buildHubTaskStateRepairModel(plannedResult),
        ),
      ),
    );
  });

  it("color render distinguishes target-status severity and planned vs applied headings", () => {
    const palette = createPalette(true);
    const plannedBlocks = hubTaskStateRepairModelToBlocks(
      buildHubTaskStateRepairModel(plannedResult),
    );
    const plannedRendered = renderSection("", plannedBlocks, {
      width: 100,
      colorEnabled: true,
    }).join("\n");

    expect(plannedRendered).toContain("Planned repairs");
    // waiting_for_merge → in_progress → warn (yellow ◐); failed → attention → error (red !).
    expect(plannedRendered).toContain(palette.yellow("◐"));
    expect(plannedRendered).toContain(palette.red("!"));

    const appliedBlocks = hubTaskStateRepairModelToBlocks(
      buildHubTaskStateRepairModel({
        ...plannedResult,
        applied: true,
      }),
    );
    const appliedRendered = renderSection("", appliedBlocks, {
      width: 100,
      colorEnabled: true,
    }).join("\n");

    expect(appliedRendered).toContain("Applied repairs");
    expect(appliedRendered).not.toContain("Re-run with --yes");
  });
});
