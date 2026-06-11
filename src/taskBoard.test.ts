import { describe, expect, it } from "vitest";
import {
  formatHubTaskBoardLines,
  formatHubTaskCommentLines,
  formatHubTaskDetailsRows,
  isCanonicalHubTaskStatus,
  projectHubTask,
  projectHubTaskBoard,
} from "./taskBoard.js";

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
    expect(lines).toContain("  bd-1: Inbox task");
    expect(lines).toContain("  bd-2: Ready task");
  });
});
