import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createPalette } from "./ansi.js";
import type { HubManagedBranchCleanupEvaluation } from "./hubManagedBranchCleanup.js";
import { flattenSectionForLog, renderSection } from "./section.js";
import {
  buildHubManagedBranchCleanupModel,
  claimHubTask,
  deleteHubTasks,
  buildHubTaskBoardModel,
  buildHubTaskDetailModel,
  deriveTaskBoardRemoteBadge,
  formatHubManagedBranchCleanupLines,
  formatTaskBoardJson,
  hubManagedBranchCleanupModelToBlocks,
  isCanonicalHubTaskStatus,
  loadHubTaskBoard,
  mapHubStatusToTaskBoardBucket,
  projectHubTask,
  projectHubTaskBoard,
  projectHubReadyQueueBoard,
  renderHubTaskBoardText,
  renderHubTaskDetailText,
  resolveHubTaskSelectors,
  selectHubBatchMergeTasks,
  type TaskBoardRemoteBadge,
} from "./taskBoard.js";

const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

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

const writeMockBdDelete = async (
  repoDir: string,
  initialTasks: { id: string; title: string; status: string }[],
) => {
  seedHubTaskStore(repoDir);
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
      ARCHLOOP_BD_PATH: bdPath,
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

  it("builds a Hub task detail model with kv identity, prose, comments timeline, and next footer", () => {
    const task = projectHubTask({
      id: "bd-42",
      title: "Projected task",
      status: "open",
      owner: "alice",
      labels: ["ready-for-agent", "backend"],
      metadata: {
        execution_mode: "agent",
        origin: "manual",
        kind: "slice",
        blocked_reason: undefined,
      },
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
    const model = buildHubTaskDetailModel(task);

    expect(model.header).toEqual({
      kind: "header",
      title: "archLoop",
      subtitle: "task · bd-42",
      right: "ready_for_agent · alice",
    });
    expect(model.identity).toEqual({
      kind: "kv",
      gutter: 12,
      rows: [
        { key: "title", value: "Projected task" },
        {
          key: "status",
          value: "ready_for_agent",
          secondary: "(beads: open)",
          valueSeverity: "info",
        },
        { key: "labels", value: "ready-for-agent, backend" },
        { key: "origin", value: "manual" },
        { key: "kind", value: "slice" },
        { key: "remote", value: "github#64" },
        { key: "runs", value: "run-123" },
        { key: "execution_mode", value: "agent" },
      ],
    });
    expect(model.description).toEqual({
      kind: "prose",
      title: "description",
      body: "Task description\n\nTask notes",
    });
    expect(model.comments).toEqual({
      kind: "prose",
      title: "comments · 1",
      body: "alice · 2026-06-11T15:00:00Z: Looks good",
      entries: [
        {
          lead: "alice",
          meta: "2026-06-11T15:00:00Z",
          body: "Looks good",
        },
      ],
    });
    expect(model.footer).toEqual({
      kind: "footer",
      label: "tip",
      commands: [
        "archloop tasks comment bd-42",
        "archloop tasks recover bd-42",
        "gh issue view 64",
      ],
    });
  });

  it("colors the task detail status row by board-bucket severity", () => {
    const cases = [
      {
        labels: ["ready-for-agent"] as string[],
        metadata: {},
        status: "info" as const,
        hubStatus: "ready_for_agent",
      },
      {
        labels: ["implementing"] as string[],
        metadata: {},
        status: "warn" as const,
        hubStatus: "implementing",
      },
      {
        labels: ["needs-info"] as string[],
        metadata: {},
        status: "error" as const,
        hubStatus: "needs_info",
      },
      {
        labels: ["failed"] as string[],
        metadata: {},
        status: "error" as const,
        hubStatus: "failed",
      },
      {
        labels: ["done"] as string[],
        metadata: { done: true },
        status: "success" as const,
        hubStatus: "done",
      },
      {
        labels: ["wontfix"] as string[],
        metadata: {},
        status: "success" as const,
        hubStatus: "wontfix",
      },
    ];

    for (const testCase of cases) {
      const task = projectHubTask({
        id: `bd-sev-${testCase.hubStatus}`,
        title: testCase.hubStatus,
        status: testCase.hubStatus === "done" ? "closed" : "open",
        labels: testCase.labels,
        metadata: testCase.metadata,
      });
      expect(task.hubStatus).toBe(testCase.hubStatus);
      const statusRow = buildHubTaskDetailModel(task).identity.rows.find(
        (row) => row.key === "status",
      );
      expect(statusRow).toMatchObject({
        value: testCase.hubStatus,
        valueSeverity: testCase.status,
      });
    }
  });

  it("renders colored status and emphasized comments while plain mode stays ANSI-free", () => {
    const task = projectHubTask({
      id: "bd-render",
      title: "Render me",
      status: "open",
      labels: ["needs-info"],
      metadata: { execution_mode: "agent" },
      comments: [
        {
          author: "alice",
          body: "Needs a repro",
          createdAt: "2026-06-11T15:00:00Z",
        },
      ],
    });
    const model = buildHubTaskDetailModel(task);
    const colored = renderHubTaskDetailText(model, {
      width: 80,
      colorEnabled: true,
    }).join("\n");
    const plain = renderHubTaskDetailText(model, {
      width: 80,
      colorEnabled: false,
    }).join("\n");

    expect(colored).toMatch(/\x1b\[/);
    expect(plain).not.toMatch(/\x1b\[/);
    expect(stripAnsi(colored)).toContain("needs_info");
    expect(stripAnsi(colored)).toContain("alice");
    expect(stripAnsi(colored)).toContain("Needs a repro");
    expect(stripAnsi(colored)).toContain("execution_mode");
    expect(stripAnsi(colored)).not.toContain('{"execution_mode":"agent"}');
    expect(plain).toContain("needs_info");
    expect(plain).toContain("alice · 2026-06-11T15:00:00Z: Needs a repro");
    expect(plain).toContain("execution_mode");
  });

  it("loads all Beads tasks including closed tasks beyond the default list page", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "taskboard-load-all-"));
    seedHubTaskStore(repoDir);
    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const argsFile = join(repoDir, "bd-list-args.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, args.join(" "));
if (args[0] !== "list") {
  process.exit(1);
}
const includeClosed = args.includes("--all");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 50;
let tasks = Array.from({ length: 55 }, (_, index) => ({
  id: \`bd-open-\${index}\`,
  title: \`Open \${index}\`,
  status: "open",
}));
tasks.push({
  id: "bd-closed-target",
  title: "Closed target",
  status: "closed",
  labels: ["done"],
});
if (!includeClosed) {
  tasks = tasks.filter((task) => task.status !== "closed");
}
if (limit > 0) {
  tasks = tasks.slice(0, limit);
}
fs.writeSync(1, JSON.stringify(tasks));
`,
    );
    await chmod(bdPath, 0o755);

    const board = loadHubTaskBoard(repoDir, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCHLOOP_BD_PATH: bdPath,
    });

    expect(board.tasks).toHaveLength(56);
    expect(board.tasks.map((task) => task.id)).toContain("bd-closed-target");
    expect(await readFile(argsFile, "utf-8")).toBe(
      "list --json --all --limit 0",
    );
  });

  it("projects remote and run refs stored in metadata", () => {
    const task = projectHubTask({
      id: "bd-43",
      title: "Metadata refs task",
      status: "closed",
      metadata: {
        hubStatus: "done",
        remote_refs: ["github#102"],
        run_refs: ["run-abc"],
      },
    });

    expect(task.hubStatus).toBe("done");
    expect(task.remoteRefs).toEqual(["github#102"]);
    expect(task.runRefs).toEqual(["run-abc"]);
  });

  it("projects github_issue metadata into remote refs", () => {
    const task = projectHubTask({
      id: "bd-45",
      title: "GitHub issue metadata task",
      status: "open",
      metadata: {
        github_issue: 110,
      },
    });

    expect(task.remoteRefs).toEqual(["github#110"]);
  });

  it("keeps done metadata authoritative over stale collaboration labels", () => {
    const task = projectHubTask({
      id: "bd-44",
      title: "Completed task with stale label",
      status: "closed",
      labels: ["ready-for-agent"],
      metadata: {
        done: true,
        remote_refs: ["github#106"],
      },
    });

    expect(task.hubStatus).toBe("done");
  });

  it("represents task claims in the detail model without inventing a claimed status", () => {
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
    const model = buildHubTaskDetailModel(task);
    expect(model.identity.rows).toEqual(
      expect.arrayContaining([
        {
          key: "claim",
          value:
            '{"runId":"run-1","batchId":"batch-1","branch":"feature/issue-69","claimedAt":"2026-06-11T16:00:00Z"}',
        },
        { key: "claim state", value: "stale" },
      ]),
    );
  });

  it("builds a Hub task board model with display buckets and no ordinals", () => {
    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board: projectHubTaskBoard([
        { id: "bd-1", title: "Inbox task", status: "open" },
        {
          id: "bd-2",
          title: "Ready task",
          status: "open",
          labels: ["ready-for-agent"],
        },
      ]),
    });

    expect(model.header).toEqual({
      kind: "header",
      title: "archLoop",
      subtitle: "demo",
      right: "2 tasks",
    });
    expect(
      model.badges.badges.map((badge) => [badge.label, badge.count]),
    ).toEqual([
      ["todo", 2],
      ["in_progress", 0],
      ["done", 0],
    ]);
    expect(model.groups.map((group) => [group.name, group.count])).toEqual([
      ["todo", 2],
    ]);
    expect(model.groups[0]?.items).toEqual([
      { id: "bd-1", title: "Inbox task" },
      { id: "bd-2", title: "Ready task" },
    ]);
    expect(model.rows).toEqual([
      { id: "bd-1", title: "Inbox task" },
      { id: "bd-2", title: "Ready task" },
    ]);
    expect(mapHubStatusToTaskBoardBucket("inbox")).toBe("todo");
    expect(mapHubStatusToTaskBoardBucket("ready_for_agent")).toBe("todo");
  });

  it.each([
    {
      name: "sync-conflict from metadata flag",
      task: {
        id: "bd-c",
        title: "Conflicted",
        status: "blocked",
        metadata: {
          sync_conflict: true,
          remote_refs: ["github#10"],
          sync_state: "synced",
        },
      },
      expected: { kind: "sync-conflict" } satisfies TaskBoardRemoteBadge,
    },
    {
      name: "sync-conflict from hubStatus",
      task: {
        id: "bd-c2",
        title: "Conflicted hub",
        status: "blocked",
        labels: ["sync-conflict"],
        metadata: { remote_refs: ["github#11"] },
      },
      expected: { kind: "sync-conflict" } satisfies TaskBoardRemoteBadge,
    },
    {
      name: "synced with remote_ref",
      task: {
        id: "bd-s",
        title: "Synced",
        status: "open",
        metadata: { sync_state: "synced", remote_ref: "github#211" },
      },
      expected: {
        kind: "synced",
        value: "github#211",
      } satisfies TaskBoardRemoteBadge,
    },
    {
      name: "synced with remote_refs projection",
      task: {
        id: "bd-s2",
        title: "Synced refs",
        status: "open",
        metadata: { sync_state: "synced", remote_refs: ["github#212"] },
      },
      expected: {
        kind: "synced",
        value: "github#212",
      } satisfies TaskBoardRemoteBadge,
    },
    {
      name: "push_pending is local-only",
      task: {
        id: "bd-p",
        title: "Pending push",
        status: "open",
        metadata: { sync_state: "push_pending" },
      },
      expected: { kind: "local-only" } satisfies TaskBoardRemoteBadge,
    },
    {
      name: "local_only sync_state",
      task: {
        id: "bd-l",
        title: "Local only",
        status: "open",
        metadata: { sync_state: "local_only" },
      },
      expected: { kind: "local-only" } satisfies TaskBoardRemoteBadge,
    },
    {
      name: "no remote link → no badge",
      task: {
        id: "bd-n",
        title: "Plain",
        status: "open",
        metadata: {},
      },
      expected: undefined,
    },
    {
      name: "synced without remote_ref → no badge",
      task: {
        id: "bd-empty",
        title: "Synced empty",
        status: "open",
        metadata: { sync_state: "synced" },
      },
      expected: undefined,
    },
  ])("derives remoteBadge: $name", ({ task, expected }) => {
    const projected = projectHubTask(task);
    expect(deriveTaskBoardRemoteBadge(projected)).toEqual(expected);

    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board: projectHubTaskBoard([task]),
    });
    const row = model.rows.find((item) => item.id === projected.id);
    expect(row?.remoteBadge).toEqual(expected);
    const groupItem = model.groups
      .flatMap((group) => group.items)
      .find((item) => item.id === projected.id);
    expect(groupItem?.remoteBadge).toEqual(expected);
  });

  it("routes blocked, failed, sync_conflict, and needs_info tasks to the attention bucket", () => {
    expect(mapHubStatusToTaskBoardBucket("blocked")).toBe("attention");
    expect(mapHubStatusToTaskBoardBucket("failed")).toBe("attention");
    expect(mapHubStatusToTaskBoardBucket("sync_conflict")).toBe("attention");
    expect(mapHubStatusToTaskBoardBucket("needs_info")).toBe("attention");
    expect(mapHubStatusToTaskBoardBucket("implementing")).toBe("in_progress");
    expect(mapHubStatusToTaskBoardBucket("done")).toBe("done");
    expect(mapHubStatusToTaskBoardBucket("wontfix")).toBe("done");
  });

  it("shows the attention badge and group only when at least one task needs attention", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-1",
        title: "Inbox task",
        status: "open",
        labels: [],
        metadata: {},
      },
      {
        id: "bd-2",
        title: "Blocked task",
        status: "blocked",
        labels: [],
        metadata: { blocked_reason: "waiting on design" },
      },
      {
        id: "bd-3",
        title: "Failed task",
        status: "failed",
        labels: [],
        metadata: { failed: "provider exited non-zero" },
      },
    ]);
    const model = buildHubTaskBoardModel({
      projectName: "sample",
      board,
      showAll: false,
    });
    const badgeLabels = model.badges.badges.map((b) => b.label);
    expect(badgeLabels).toEqual(["todo", "in_progress", "attention", "done"]);
    const attentionBadge = model.badges.badges.find(
      (b) => b.label === "attention",
    );
    expect(attentionBadge?.count).toBe(2);
    expect(attentionBadge?.severity).toBe("error");
    const attentionGroup = model.groups.find((g) => g.name === "attention");
    expect(attentionGroup?.count).toBe(2);
    expect(attentionGroup?.items.map((i) => i.id)).toEqual(["bd-2", "bd-3"]);
  });

  it("hides the attention badge and group when there are no attention tasks", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-1",
        title: "Inbox task",
        status: "open",
        labels: [],
        metadata: {},
      },
    ]);
    const model = buildHubTaskBoardModel({
      projectName: "sample",
      board,
      showAll: false,
    });
    const badgeLabels = model.badges.badges.map((b) => b.label);
    expect(badgeLabels).toEqual(["todo", "in_progress", "done"]);
    expect(model.groups.find((g) => g.name === "attention")).toBeUndefined();
  });

  it("renders the specific hub status when attention holds only one kind of trouble", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-1",
        title: "Inbox task",
        status: "open",
        labels: [],
        metadata: {},
      },
      {
        id: "bd-2",
        title: "Blocked one",
        status: "blocked",
        labels: [],
        metadata: { blocked_reason: "waiting on design" },
      },
      {
        id: "bd-3",
        title: "Blocked two",
        status: "blocked",
        labels: [],
        metadata: { blocked_reason: "waiting on remote" },
      },
    ]);
    const model = buildHubTaskBoardModel({
      projectName: "sample",
      board,
      showAll: false,
    });
    // Only blocked lives in attention → badge and group both read "blocked".
    const attentionBadge = model.badges.badges.find(
      (b) => b.severity === "error",
    );
    expect(attentionBadge?.label).toBe("blocked");
    expect(attentionBadge?.count).toBe(2);
    expect(attentionBadge?.symbol).toBe("!");
    const attentionGroup = model.groups.find((g) => g.severity === "error");
    expect(attentionGroup?.name).toBe("blocked");
    expect(attentionGroup?.symbol).toBe("!");
  });

  it("uses the ✗ glyph and 'failed' label when attention holds only failed tasks", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-1",
        title: "Failed one",
        status: "failed",
        labels: [],
        metadata: { failed: "typecheck" },
      },
    ]);
    const model = buildHubTaskBoardModel({
      projectName: "sample",
      board,
      showAll: false,
    });
    const attentionBadge = model.badges.badges.find(
      (b) => b.severity === "error",
    );
    expect(attentionBadge?.label).toBe("failed");
    expect(attentionBadge?.symbol).toBe("✗");
    const attentionGroup = model.groups.find((g) => g.severity === "error");
    expect(attentionGroup?.name).toBe("failed");
    expect(attentionGroup?.symbol).toBe("✗");
  });

  it("renders sync_conflict and needs_info as kebab-case labels in the attention bucket", () => {
    const conflictBoard = projectHubTaskBoard([
      {
        id: "bd-1",
        title: "Conflicted task",
        status: "blocked",
        labels: [],
        metadata: { sync_conflict: true, sync_conflict_reason: "diverged" },
      },
    ]);
    const conflictModel = buildHubTaskBoardModel({
      projectName: "sample",
      board: conflictBoard,
      showAll: false,
    });
    const conflictBadge = conflictModel.badges.badges.find(
      (b) => b.severity === "error",
    );
    expect(conflictBadge?.label).toBe("sync-conflict");
    const conflictGroup = conflictModel.groups.find(
      (g) => g.severity === "error",
    );
    expect(conflictGroup?.name).toBe("sync-conflict");

    const needsInfoBoard = projectHubTaskBoard([
      {
        id: "bd-2",
        title: "Awaiting details",
        status: "open",
        labels: ["needs-info"],
        metadata: {},
      },
    ]);
    const needsInfoModel = buildHubTaskBoardModel({
      projectName: "sample",
      board: needsInfoBoard,
      showAll: false,
    });
    const needsInfoBadge = needsInfoModel.badges.badges.find(
      (b) => b.severity === "error",
    );
    expect(needsInfoBadge?.label).toBe("needs-info");
    const needsInfoGroup = needsInfoModel.groups.find(
      (g) => g.severity === "error",
    );
    expect(needsInfoGroup?.name).toBe("needs-info");
  });

  it("falls back to the generic attention label when multiple trouble kinds coexist", () => {
    // This is the branch the existing "shows the attention badge and group"
    // test already covers (blocked + failed together → fallback to attention).
    // Documenting it explicitly here so the intent is not accidentally lost.
    const board = projectHubTaskBoard([
      {
        id: "bd-1",
        title: "Blocked",
        status: "blocked",
        labels: [],
        metadata: { blocked_reason: "waiting on design" },
      },
      {
        id: "bd-2",
        title: "Failed",
        status: "failed",
        labels: [],
        metadata: { failed: "typecheck" },
      },
    ]);
    const model = buildHubTaskBoardModel({
      projectName: "sample",
      board,
      showAll: false,
    });
    const attentionBadge = model.badges.badges.find(
      (b) => b.severity === "error",
    );
    expect(attentionBadge?.label).toBe("attention");
    expect(attentionBadge?.symbol).toBe("!");
    const attentionGroup = model.groups.find((g) => g.severity === "error");
    expect(attentionGroup?.name).toBe("attention");
    expect(attentionGroup?.symbol).toBe("!");
  });

  it("shows PRD warning details on the task detail model", () => {
    const task = projectHubTask({
      id: "bd-99",
      title: "Warned task",
      status: "open",
      labels: ["prd-warning-high"],
      metadata: {
        slice_temp_id: "slice-1",
        warning_severity: "high",
        warning_message: "Missing acceptance criteria",
        proposal_run_id: "run-abc",
      },
    });

    const model = buildHubTaskDetailModel(task);
    expect(model.identity.rows).toEqual(
      expect.arrayContaining([
        {
          key: "prd warning",
          value:
            "[high] · Missing acceptance criteria · Slice: slice-1 · Proposal run: run-abc",
        },
      ]),
    );
  });

  it("formats a multi-comment timeline on the task detail model", () => {
    const task = projectHubTask({
      id: "bd-7",
      title: "Discussed task",
      status: "open",
      comments: [
        {
          author: "alice",
          body: "First note",
          createdAt: "2026-06-11T15:00:00Z",
        },
        {
          author: "bob",
          body: "Second note",
          createdAt: "2026-06-12T09:00:00Z",
        },
      ],
    });

    const model = buildHubTaskDetailModel(task);
    expect(model.comments).toEqual({
      kind: "prose",
      title: "comments · 2",
      body: "alice · 2026-06-11T15:00:00Z: First note\nbob · 2026-06-12T09:00:00Z: Second note",
      entries: [
        {
          lead: "alice",
          meta: "2026-06-11T15:00:00Z",
          body: "First note",
        },
        {
          lead: "bob",
          meta: "2026-06-12T09:00:00Z",
          body: "Second note",
        },
      ],
    });
    expect(model.footer).toEqual({
      kind: "footer",
      label: "tip",
      commands: ["archloop tasks comment bd-7", "archloop tasks recover bd-7"],
    });
  });

  it("does not dump leftover detail metadata as a raw JSON blob", () => {
    const task = projectHubTask({
      id: "bd-meta",
      title: "Metadata task",
      status: "open",
      metadata: {
        execution_mode: "agent",
        attempt: 2,
        nested: { ok: true },
      },
    });

    const rows = buildHubTaskDetailModel(task).identity.rows;
    expect(rows.find((row) => row.key === "metadata")).toBeUndefined();
    expect(rows).toEqual(
      expect.arrayContaining([
        { key: "execution_mode", value: "agent" },
        { key: "attempt", value: "2" },
        { key: "nested", value: '{"ok":true}' },
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain('"key":"metadata"');
  });

  it("attaches PRD warning badges on the task board model", () => {
    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board: projectHubTaskBoard([
        { id: "bd-1", title: "Clean task", status: "open" },
        {
          id: "bd-2",
          title: "Warned task",
          status: "open",
          labels: ["prd-warning-high"],
          metadata: {
            slice_temp_id: "slice-2",
            warning_severity: "high",
            warning_message: "Scope unclear",
          },
        },
      ]),
    });

    expect(model.warningSummary?.body).toBe(
      "PRD warnings: 1 high · 0 medium · 0 low",
    );
    expect(model.groups[0]?.items).toEqual([
      { id: "bd-1", title: "Clean task" },
      {
        id: "bd-2",
        title: "Warned task",
        trailingDim: "⚠ prd-warn",
      },
    ]);
  });

  it("filters the task board model by PRD warning severity", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-1",
        title: "High warning",
        status: "open",
        metadata: {
          slice_temp_id: "slice-1",
          warning_severity: "high",
          warning_message: "High issue",
        },
      },
      {
        id: "bd-2",
        title: "Medium warning",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          slice_temp_id: "slice-2",
          warning_severity: "medium",
          warning_message: "Medium issue",
        },
      },
    ]);

    const model = buildHubTaskBoardModel({
      projectName: "demo",
      board,
      warningFilter: "high",
      showAll: true,
    });

    expect(model.header.right).toBe("1 task");
    expect(model.warningSummary?.body).toBe(
      "PRD warnings: 1 high · 0 medium · 0 low",
    );
    expect(model.groups[0]?.items).toEqual([
      {
        id: "bd-1",
        title: "High warning",
        trailingDim: "⚠ prd-warn",
      },
    ]);
    expect(
      model.groups.some((group) =>
        group.items.some((item) => item.id === "bd-2"),
      ),
    ).toBe(false);
  });

  it("hides surplus done tasks until --all expands them", () => {
    const board = projectHubTaskBoard(
      Array.from({ length: 7 }, (_, index) => ({
        id: `bd-${index}`,
        title: `Done task ${index}`,
        status: "closed",
        labels: ["done"],
      })),
    );

    const collapsed = buildHubTaskBoardModel({
      projectName: "demo",
      board,
      showAll: false,
      perGroupLimit: 5,
    });
    expect(collapsed.groups).toHaveLength(1);
    expect(collapsed.groups[0]?.name).toBe("done");
    expect(collapsed.groups[0]?.count).toBe(7);
    expect(collapsed.groups[0]?.items).toHaveLength(5);
    expect(collapsed.groups[0]?.rightHint).toBe(
      "showing 5 · archloop tasks list --all",
    );
    expect(collapsed.groups[0]?.footerDim).toBe("… 2 more");

    const expanded = buildHubTaskBoardModel({
      projectName: "demo",
      board,
      showAll: true,
    });
    expect(expanded.groups[0]?.items).toHaveLength(7);
    expect(expanded.groups[0]?.rightHint).toBeUndefined();
  });

  it("shows owner dim on claimed tasks in the board model", () => {
    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board: projectHubTaskBoard([
        {
          id: "bd-1",
          title: "Claimed task",
          status: "in_progress",
          owner: "yc.bai",
          metadata: {
            claim: {
              runId: "run-1",
              batchId: "batch-1",
              branch: "archloop/bd-1",
              claimedAt: "2026-07-20T00:00:00Z",
            },
          },
        },
      ]),
    });

    expect(model.groups.map((group) => group.name)).toEqual(["in_progress"]);
    expect(model.groups[0]?.items).toEqual([
      {
        id: "bd-1",
        title: "Claimed task",
        trailingDim: "yc.bai",
      },
    ]);
  });

  it("renders remote badges right-aligned with severity colors and owner stacking", () => {
    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board: projectHubTaskBoard([
        {
          id: "bd-synced",
          title: "Synced task",
          status: "open",
          metadata: { sync_state: "synced", remote_ref: "github#211" },
        },
        {
          id: "bd-local",
          title: "Local only task",
          status: "open",
          metadata: { sync_state: "push_pending" },
        },
        {
          id: "bd-conflict",
          title: "Conflict task",
          status: "blocked",
          metadata: { sync_conflict: true, remote_refs: ["github#99"] },
        },
        {
          id: "bd-owner",
          title: "Claimed synced",
          status: "in_progress",
          owner: "yc.bai",
          metadata: {
            sync_state: "synced",
            remote_ref: "github#300",
            claim: {
              runId: "run-1",
              batchId: "batch-1",
              branch: "archloop/bd-owner",
              claimedAt: "2026-07-20T00:00:00Z",
            },
          },
        },
      ]),
    });

    const plain = renderHubTaskBoardText(model, {
      width: 100,
      colorEnabled: false,
    }).map(stripAnsi);
    expect(plain.some((line) => /bd-synced\s+Synced task/.test(line))).toBe(
      true,
    );
    expect(plain.some((line) => line.includes("github#211"))).toBe(true);
    expect(plain.some((line) => line.includes("local-only"))).toBe(true);
    expect(plain.some((line) => line.includes("sync-conflict"))).toBe(true);
    expect(
      plain.some(
        (line) =>
          line.includes("bd-owner") && line.includes("yc.bai · github#300"),
      ),
    ).toBe(true);

    const colored = renderHubTaskBoardText(model, {
      width: 100,
      colorEnabled: true,
    }).join("\n");
    const palette = createPalette(true);
    expect(colored).toContain(palette.dim(palette.cyan("github#211")));
    expect(colored).toContain(palette.dim("local-only"));
    expect(colored).toContain(palette.yellow("sync-conflict"));
  });

  it("formatTaskBoardJson includes remoteBadge on rows", () => {
    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board: projectHubTaskBoard([
        {
          id: "bd-1",
          title: "Synced",
          status: "open",
          metadata: { sync_state: "synced", remote_ref: "github#211" },
        },
        {
          id: "bd-2",
          title: "Local",
          status: "open",
          metadata: { sync_state: "local_only" },
        },
        {
          id: "bd-3",
          title: "Plain",
          status: "open",
          metadata: {},
        },
      ]),
    });

    const payload = JSON.parse(formatTaskBoardJson(model)) as Array<{
      id: string;
      title: string;
      remoteBadge?: TaskBoardRemoteBadge;
    }>;
    expect(payload.map((row) => row.id)).toEqual(["bd-1", "bd-2", "bd-3"]);
    expect(payload[0]?.remoteBadge).toEqual({
      kind: "synced",
      value: "github#211",
    });
    expect(payload[1]?.remoteBadge).toEqual({ kind: "local-only" });
    expect(payload[2]?.remoteBadge).toBeUndefined();
  });

  it("preserves bd ready queue order in projectHubReadyQueueBoard", () => {
    const board = projectHubReadyQueueBoard([
      { id: "bd-z", title: "Later in queue", status: "open" },
      { id: "bd-a", title: "Earlier alphabetically", status: "open" },
    ]);

    expect(board.tasks.map((task) => task.id)).toEqual(["bd-z", "bd-a"]);
  });

  it("badges interrupted-execution tasks passed via interruptedTaskIds", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-stuck",
        title: "Stuck implementing task",
        status: "in_progress",
        labels: ["implementing"],
        owner: "yucheng.bai",
        metadata: {
          claim: { branch: "archloop/bd-stuck-stuck-implementing-task" },
        },
      },
      {
        id: "bd-live",
        title: "Live implementing task",
        status: "in_progress",
        labels: ["implementing"],
        owner: "yucheng.bai",
        metadata: {
          claim: { branch: "archloop/bd-live-live-implementing-task" },
        },
      },
    ]);

    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board,
      interruptedTaskIds: new Set(["bd-stuck"]),
    });

    // The interrupted task carries an additive `interrupted: true` flag on its
    // row; the non-interrupted task omits the field entirely so existing JSON
    // consumers see no shape change for healthy tasks.
    const stuckRow = model.rows.find((row) => row.id === "bd-stuck");
    const liveRow = model.rows.find((row) => row.id === "bd-live");
    expect(stuckRow?.interrupted).toBe(true);
    expect(stuckRow?.trailingDim).toBe("⚠ interrupted");
    expect(liveRow?.interrupted).toBeUndefined();
    expect(liveRow?.trailingDim).toBe("yucheng.bai");

    // The group item (human renderer) shares the same row shape, so the badge
    // is visible at a glance in the board view, not just the JSON dump.
    const inProgressGroup = model.groups.find(
      (group) => group.name === "in_progress",
    );
    const stuckItem = inProgressGroup?.items.find(
      (item) => item.id === "bd-stuck",
    );
    expect(stuckItem?.trailingDim).toBe("⚠ interrupted");
  });

  it("omits the interrupted flag when no interruptedTaskIds are supplied", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-stuck",
        title: "Stuck implementing task",
        status: "in_progress",
        labels: ["implementing"],
      },
    ]);

    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board,
    });

    expect(model.rows[0]?.interrupted).toBeUndefined();
  });

  it("formatTaskBoardJson includes interrupted on flagged rows only", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-stuck",
        title: "Stuck reviewing task",
        status: "in_progress",
        labels: ["reviewing"],
      },
      {
        id: "bd-plain",
        title: "Plain task",
        status: "open",
      },
    ]);

    const model = buildHubTaskBoardModel({
      projectName: "demo",
      showAll: true,
      board,
      interruptedTaskIds: new Set(["bd-stuck"]),
    });

    const payload = JSON.parse(formatTaskBoardJson(model)) as Array<{
      id: string;
      title: string;
      interrupted?: boolean;
    }>;
    const stuck = payload.find((row) => row.id === "bd-stuck");
    const plain = payload.find((row) => row.id === "bd-plain");
    expect(stuck?.interrupted).toBe(true);
    expect(plain?.interrupted).toBeUndefined();
  });
});

describe("task lifecycle transitions", () => {
  it("claims ready tasks by aligning Beads status, labels, metadata, and projection", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "taskboard-claim-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    seedHubTaskStore(repoDir);

    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

    const stateFile = join(repoDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify(
        [
          {
            id: "bd-claim",
            title: "Claim me",
            status: "open",
            labels: ["ready-for-agent"],
            metadata: { hubStatus: "ready_for_agent" },
          },
        ],
        null,
        2,
      ),
    );

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
const [command, id] = args;
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const findTask = (state, taskId) => state.find((task) => task.id === taskId);

if (command === "list") {
  process.stdout.write(JSON.stringify(readState()));
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

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCHLOOP_BD_PATH: bdPath,
    };

    const result = await claimHubTask({
      cwd: repoDir,
      taskId: "bd-claim",
      branch: "archloop/bd-claim-claim-me",
      hubProjectDir: join(repoDir, "data", "archloop", "hub"),
      env,
    });

    expect(result.task.hubStatus).toBe("implementing");
    expect(result.task.metadata.hubStatus).toBe("implementing");
    expect(result.task.labels).toContain("implementing");
    expect(result.task.labels).not.toContain("ready-for-agent");
    expect(result.task.beadsStatus).toBe("in_progress");

    const board = loadHubTaskBoard(repoDir, env);
    expect(board.tasks[0]).toMatchObject({
      id: "bd-claim",
      hubStatus: "implementing",
      beadsStatus: "in_progress",
    });
  });

  it("selects waiting_for_merge tasks even when old metadata lags behind the label", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-reviewed",
        title: "Reviewed task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "ready_for_agent",
          claim: {
            runId: "run-1",
            batchId: "batch-1",
            branch: "archloop/bd-reviewed-reviewed-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    expect(board.tasks[0]?.hubStatus).toBe("waiting_for_merge");
    expect(
      selectHubBatchMergeTasks(board, "batch-1").map((task) => task.id),
    ).toEqual(["bd-reviewed"]);
  });

  it("keeps metadata failure reasons authoritative over stale non-failed labels", () => {
    const board = projectHubTaskBoard([
      {
        id: "bd-failed",
        title: "Failed task",
        status: "in_progress",
        labels: ["waiting-for-merge"],
        metadata: {
          hubStatus: "ready_for_agent",
          failureReason: "merge_failed",
          claim: {
            runId: "run-1",
            batchId: "batch-1",
            branch: "archloop/bd-failed-failed-task",
            claimedAt: "2026-06-12T10:00:00Z",
          },
        },
      },
    ]);

    expect(board.tasks[0]?.hubStatus).toBe("failed");
    expect(selectHubBatchMergeTasks(board, "batch-1")).toEqual([]);
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
    seedHubTaskStore(repoDir);

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
      ARCHLOOP_BD_PATH: bdPath,
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
      ["bd-1", "Second task", "bd-3"],
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

    const tasks = resolveHubTaskSelectors(repoDir, ["bd-1", "Only task"], env);
    expect(tasks.map((task) => task.id)).toEqual(["bd-1"]);
  });

  it("rejects 1-based ordinal selectors", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "taskboard-ordinal-"));
    await initRepo(repoDir);
    const { env } = await writeMockBdDelete(repoDir, [
      { id: "bd-1", title: "Only task", status: "open" },
    ]);

    expect(() => resolveHubTaskSelectors(repoDir, ["1"], env)).toThrow(
      /did not match a Beads id or an exact task title/,
    );
  });
});

describe("deleteHubTasks dependency failures", () => {
  it("surfaces Beads dependency errors from bd delete", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "taskboard-delete-deps-"));
    await initRepo(repoDir);
    seedHubTaskStore(repoDir);

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
      ARCHLOOP_BD_PATH: bdPath,
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

const sampleCleanupEvaluation = {
  repoRoot: "/tmp/repo",
  hubProjectDir: "/tmp/data/archloop/hub/projects/demo",
  targetBranch: "main",
  targetHead: "abc123def456",
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

describe("buildHubManagedBranchCleanupModel", () => {
  it("groups safe/blocked/unowned branches with severity assignment", () => {
    const model = buildHubManagedBranchCleanupModel(sampleCleanupEvaluation);

    expect(model.header).toMatchObject({
      kind: "header",
      title: "Hub managed branch cleanup",
    });
    expect(model.identity.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "target", value: "main" }),
        expect.objectContaining({ key: "head", value: "abc123def456" }),
      ]),
    );
    expect(model.groups.map((group) => group.name)).toEqual([
      "safe managed",
      "blocked managed",
      "unowned historical",
    ]);
    expect(model.groups.map((group) => group.severity)).toEqual([
      "success",
      "warn",
      "info",
    ]);
    expect(model.groups.map((group) => group.symbol)).toEqual(["✓", "!", "●"]);
    expect(model.groups.map((group) => group.count)).toEqual([1, 1, 1]);

    expect(model.groups[0]?.items).toEqual([
      {
        id: "bd-safe",
        title: "archloop/bd-safe-cleanup",
      },
    ]);
    expect(model.groups[1]?.items).toEqual([
      {
        id: "bd-blocked",
        title: "archloop/bd-blocked-cleanup",
        detailDim:
          "Branch archloop/bd-blocked-cleanup existed before Hub claimed task bd-blocked; keep it out of automatic cleanup.",
      },
    ]);
    expect(model.groups[2]?.items[0]).toMatchObject({
      id: "historical",
      title: "archloop/unowned-history",
      trailingDim: "Use --include-unowned to delete safe historical branches",
    });
  });

  it("surfaces dry-run preview and deleted-branch summaries", () => {
    const model = buildHubManagedBranchCleanupModel(sampleCleanupEvaluation, {
      dryRun: true,
      deletedManagedBranches: ["archloop/bd-safe-cleanup"],
      deletedHistoricalBranches: ["archloop/unowned-history"],
      includeUnowned: true,
    });

    expect(model.preview?.body).toBe("Preview: no git refs will be deleted.");
    expect(model.deletedManaged?.body).toBe(
      "Deleted managed branches: archloop/bd-safe-cleanup",
    );
    expect(model.deletedHistorical?.body).toBe(
      "Deleted historical branches: archloop/unowned-history",
    );
    expect(model.groups[2]?.items[0]?.trailingDim).toBe(
      "safe historical branch included by --include-unowned",
    );
  });
});

describe("hubManagedBranchCleanupModelToBlocks / formatHubManagedBranchCleanupLines (presentation)", () => {
  it("plain (flattenSectionForLog) preserves every branch, task id, and skip reason with no ANSI", () => {
    const lines = formatHubManagedBranchCleanupLines(sampleCleanupEvaluation, {
      dryRun: true,
    });
    const text = lines.join("\n");

    expect(text).not.toMatch(/\x1b\[/);
    expect(text).toContain("Hub managed branch cleanup");
    expect(text).toContain("Preview: no git refs will be deleted.");
    expect(text).toContain("main");
    expect(text).toContain("abc123def456");
    expect(text).toContain("archloop/bd-safe-cleanup");
    expect(text).toContain("bd-safe");
    expect(text).toContain("archloop/bd-blocked-cleanup");
    expect(text).toContain("bd-blocked");
    expect(text).toContain(
      "existed before Hub claimed task bd-blocked; keep it out of automatic cleanup",
    );
    expect(text).toContain("archloop/unowned-history");
    expect(text).toContain("--include-unowned");

    expect(lines).toEqual(
      flattenSectionForLog(
        hubManagedBranchCleanupModelToBlocks(
          buildHubManagedBranchCleanupModel(sampleCleanupEvaluation, {
            dryRun: true,
          }),
        ),
      ),
    );
  });

  it("color render distinguishes safe/blocked/unowned severity symbols", () => {
    const palette = createPalette(true);
    const rendered = renderSection(
      "",
      hubManagedBranchCleanupModelToBlocks(
        buildHubManagedBranchCleanupModel(sampleCleanupEvaluation),
      ),
      { width: 100, colorEnabled: true },
    ).join("\n");

    expect(rendered).toContain(palette.green("✓"));
    expect(rendered).toContain(palette.yellow("!"));
    expect(rendered).toContain(palette.cyan("●"));
  });
});
