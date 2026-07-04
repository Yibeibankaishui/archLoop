import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createHubRunContext } from "./hubExecution.js";
import {
  doctorHubTaskState,
  repairHubTaskState,
} from "./hubTaskStateDoctor.js";

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
});
