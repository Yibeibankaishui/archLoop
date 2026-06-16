import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  deleteHubTasks,
  formatHubTaskBoardLines,
  formatHubTaskCommentLines,
  formatHubTaskDetailsRows,
  isCanonicalHubTaskStatus,
  loadHubTaskBoard,
  projectHubTask,
  projectHubTaskBoard,
  resolveHubTaskSelectors,
} from "./taskBoard.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const writeMockBdDelete = async (
  repoDir: string,
  initialTasks: { id: string; title: string; status: string }[],
) => {
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  const stateFile = join(repoDir, "bd-state.json");
  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));

  const deleteArgsFile = join(repoDir, "bd-delete-args.txt");
  await writeFile(deleteArgsFile, "");

  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const deleteArgsFile = ${JSON.stringify(deleteArgsFile)};
const args = process.argv.slice(2);
const command = args[0];
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) =>
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

if (command === "list") {
  process.stdout.write(JSON.stringify(readState()));
  process.exit(0);
}

if (command === "show") {
  const taskId = args[1];
  const task = readState().find((entry) => entry.id === taskId);
  if (!task) {
    process.stderr.write("task " + taskId + " not found");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "delete") {
  fs.appendFileSync(deleteArgsFile, args.join(" ") + "\\n");
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const taskIds = args.slice(1).filter((arg) => !arg.startsWith("--"));
  if (dryRun) {
    process.stdout.write("Dry run: would delete " + taskIds.join(", "));
    process.exit(0);
  }
  if (!force) {
    process.stdout.write("Preview: would delete " + taskIds.join(", "));
    process.exit(0);
  }
  const state = readState();
  const missing = taskIds.filter(
    (taskId) => !state.some((task) => task.id === taskId),
  );
  if (missing.length > 0) {
    process.stderr.write("task " + missing[0] + " not found");
    process.exit(1);
  }
  writeState(state.filter((task) => !taskIds.includes(task.id)));
  process.stdout.write("Deleted " + taskIds.join(", "));
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
    },
    deleteArgsFile,
    stateFile,
  };
};

describe("task status projection", () => {
  it("maps representative Beads task shapes into canonical Hub statuses", () => {
    const board = projectHubTaskBoard([
      { id: "bd-1", title: "Inbox task", status: "open" },
      {
        id: "bd-2",
        title: "Needs info task",
        status: "open",
        labels: ["needs-info"],
      },
      {
        id: "bd-3",
        title: "Ready for agent task",
        status: "open",
        labels: ["ready-for-agent"],
      },
      {
        id: "bd-4",
        title: "Ready for human task",
        status: "open",
        labels: ["ready-for-human"],
      },
      {
        id: "bd-5",
        title: "Blocked task",
        status: "open",
        metadata: { blocked_reason: "dependency" },
      },
      {
        id: "bd-6",
        title: "Implementing task",
        status: "in_progress",
        labels: ["implementing"],
      },
      {
        id: "bd-7",
        title: "Reviewing task",
        status: "in_progress",
        labels: ["reviewing"],
      },
      {
        id: "bd-8",
        title: "Waiting for merge task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
      },
      {
        id: "bd-9",
        title: "Merging task",
        status: "in_progress",
        labels: ["merging"],
      },
      {
        id: "bd-10",
        title: "Done task",
        status: "closed",
        labels: ["done"],
      },
      {
        id: "bd-11",
        title: "Wontfix task",
        status: "closed",
        labels: ["wontfix"],
      },
      {
        id: "bd-12",
        title: "Failed task",
        status: "open",
        labels: ["failed"],
      },
      {
        id: "bd-13",
        title: "Sync conflict task",
        status: "blocked",
        labels: ["sync-conflict"],
      },
    ]);

    expect(board.groups.map((group) => group.status)).toEqual([
      "inbox",
      "needs_info",
      "ready_for_agent",
      "ready_for_human",
      "blocked",
      "implementing",
      "reviewing",
      "waiting_for_merge",
      "merging",
      "done",
      "wontfix",
      "failed",
      "sync_conflict",
    ]);
    expect(board.groups[0]?.tasks.map((task) => task.id)).toEqual(["bd-1"]);
    expect(board.groups[4]?.tasks.map((task) => task.id)).toEqual(["bd-5"]);
    expect(board.groups[9]?.tasks.map((task) => task.id)).toEqual(["bd-10"]);
    expect(board.groups[12]?.tasks.map((task) => task.id)).toEqual(["bd-13"]);
  });

  it("does not accept excluded task statuses as canonical Hub statuses", () => {
    for (const status of [
      "pending",
      "triaging",
      "waiting_for_review",
      "planning",
      "reserved",
      "claimed",
      "deferred",
    ]) {
      expect(isCanonicalHubTaskStatus(status)).toBe(false);
    }
  });

  it("preserves Beads details, labels, metadata, comments, and refs for show output", () => {
    const task = projectHubTask({
      id: "bd-42",
      title: "Projected task",
      status: "open",
      labels: ["ready-for-agent", "backend"],
      metadata: { execution_mode: "agent", blocked_reason: undefined },
      description: "Task description",
      notes: "Task notes",
      comments: [
        {
          author: "alice",
          body: "Looks good",
          createdAt: "2026-06-11T15:00:00Z",
        },
      ],
      remoteRefs: [{ url: "github#64" }],
      runRefs: [{ ref: "run-123" }],
    });

    expect(task.hubStatus).toBe("ready_for_agent");
    expect(formatHubTaskDetailsRows(task)).toMatchObject({
      "Beads id": "bd-42",
      Title: "Projected task",
      "Hub status": "ready_for_agent",
      Labels: "ready-for-agent, backend",
      Metadata: '{"execution_mode":"agent"}',
      "Remote refs": "github#64",
      "Run refs": "run-123",
      Comments: "1",
    });
    expect(formatHubTaskCommentLines(task)).toEqual([
      "Comments",
      "  - alice · 2026-06-11T15:00:00Z: Looks good",
    ]);
  });

  it("represents task claims in metadata without inventing a claimed status", () => {
    const task = projectHubTask({
      id: "bd-69",
      title: "Claimed task",
      status: "open",
      metadata: {
        claim: {
          runId: "run-1",
          batchId: "batch-1",
          branch: "feature/issue-69",
          claimedAt: "2026-06-11T16:00:00Z",
        },
      },
    });

    expect(task.hubStatus).toBe("inbox");
    expect(task.claimState).toBe("stale");
    expect(formatHubTaskDetailsRows(task)).toMatchObject({
      Claim:
        '{"runId":"run-1","batchId":"batch-1","branch":"feature/issue-69","claimedAt":"2026-06-11T16:00:00Z"}',
      "Claim state": "stale",
    });
  });

  it("formats grouped task board lines", () => {
    const lines = formatHubTaskBoardLines(
      projectHubTaskBoard([
        { id: "bd-1", title: "Inbox task", status: "open" },
        {
          id: "bd-2",
          title: "Ready task",
          status: "open",
          labels: ["ready-for-agent"],
        },
      ]),
    );

    expect(lines).toContain("Hub task board");
    expect(lines).toContain("Total tasks: 2");
    expect(lines).toContain("inbox (1)");
    expect(lines).toContain("ready_for_agent (1)");
    expect(lines).toContain("  1. bd-1: Inbox task");
    expect(lines).toContain("  2. bd-2: Ready task");
  });
});

describe("deleteHubTasks", () => {
  it("deletes a single local Beads task via bd delete --force", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "taskboard-delete-"));
    await initRepo(repoDir);
    const { env, deleteArgsFile, stateFile } = await writeMockBdDelete(
      repoDir,
      [
        { id: "bd-1", title: "Obsolete task", status: "open" },
        { id: "bd-2", title: "Keep task", status: "open" },
      ],
    );

    const output = deleteHubTasks({
      cwd: repoDir,
      taskIds: ["bd-1"],
      force: true,
      env,
    });

    expect(output).toContain("Deleted bd-1");
    const board = loadHubTaskBoard(repoDir, env);
    expect(board.tasks.map((task) => task.id)).toEqual(["bd-2"]);
    const deleteArgs = await readFile(deleteArgsFile, "utf-8");
    expect(deleteArgs).toContain("delete");
    expect(deleteArgs).toContain("bd-1");
    expect(deleteArgs).toContain("--force");
    expect(await readFile(stateFile, "utf-8")).not.toContain("bd-1");
  });

  it("fails when Beads reports delete success but the task still exists", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "taskboard-delete-false-success-"),
    );
    await initRepo(repoDir);

    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

    const stateFile = join(repoDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify([{ id: "bd-1", title: "Ghost task", status: "open" }]),
    );

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));

if (args[0] === "list") {
  process.stdout.write(JSON.stringify(readState()));
  process.exit(0);
}

if (args[0] === "show") {
  const task = readState().find((entry) => entry.id === args[1]);
  if (!task) {
    process.stderr.write("task " + args[1] + " not found");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (args[0] === "delete" && args.includes("--force")) {
  process.stdout.write("Deleted " + args[1]);
  process.exit(0);
}

process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    expect(() =>
      deleteHubTasks({
        cwd: repoDir,
        taskIds: ["bd-1"],
        force: true,
        env,
      }),
    ).toThrow(/reported success, but Beads still has: bd-1/);
  });
});

describe("resolveHubTaskSelectors", () => {
  it("resolves multiple selectors to distinct Beads task ids", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "taskboard-selectors-"));
    await initRepo(repoDir);
    const { env } = await writeMockBdDelete(repoDir, [
      { id: "bd-1", title: "First task", status: "open" },
      { id: "bd-2", title: "Second task", status: "open" },
      { id: "bd-3", title: "Third task", status: "closed" },
    ]);

    const tasks = resolveHubTaskSelectors(
      repoDir,
      ["bd-1", "Second task", "3"],
      env,
    );
    expect(tasks.map((task) => task.id)).toEqual(["bd-1", "bd-2", "bd-3"]);
  });

  it("deduplicates selectors that resolve to the same task", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "taskboard-dedupe-"));
    await initRepo(repoDir);
    const { env } = await writeMockBdDelete(repoDir, [
      { id: "bd-1", title: "Only task", status: "open" },
    ]);

    const tasks = resolveHubTaskSelectors(
      repoDir,
      ["bd-1", "Only task", "1"],
      env,
    );
    expect(tasks.map((task) => task.id)).toEqual(["bd-1"]);
  });
});

describe("deleteHubTasks dependency failures", () => {
  it("surfaces Beads dependency errors from bd delete", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "taskboard-delete-deps-"));
    await initRepo(repoDir);

    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

    const stateFile = join(repoDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify([
        { id: "bd-1", title: "Blocker", status: "open" },
        { id: "bd-2", title: "Dependent", status: "open" },
      ]),
    );

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
if (args[0] === "list") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
if (args[0] === "delete" && args.includes("--force")) {
  const taskIds = args.slice(1).filter((arg) => !arg.startsWith("--"));
  if (taskIds.includes("bd-1") && !args.includes("--cascade")) {
    process.stderr.write(
      "Error: bd-1 has dependents not in deletion set: bd-2",
    );
    process.exit(1);
  }
  process.stdout.write("Deleted " + taskIds.join(", "));
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    expect(() =>
      deleteHubTasks({
        cwd: repoDir,
        taskIds: ["bd-1"],
        force: true,
        env,
      }),
    ).toThrow(/dependents not in deletion set/);
  });
});
