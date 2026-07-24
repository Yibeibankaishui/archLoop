import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HubTaskEvent } from "./hubExecution.js";
import { readTaskEvents } from "./hubRunEventLog.js";

const event = (overrides: Partial<HubTaskEvent>): HubTaskEvent => ({
  type: "task_review_succeeded",
  runId: "run-1",
  batchId: "batch-1",
  taskId: "bd-1",
  branch: "archloop/bd-1-task",
  createdAt: "2026-07-23T00:00:00.000Z",
  status: "waiting_for_merge",
  ...overrides,
});

describe("readTaskEvents", () => {
  it("reads task events across every run dir under runs/", async () => {
    const hubProjectDir = await mkdtemp(join(tmpdir(), "hub-event-log-multi-"));
    for (const runName of ["run-a", "run-b"]) {
      const eventsDir = join(hubProjectDir, "runs", runName, "events");
      await mkdir(eventsDir, { recursive: true });
      await writeFile(
        join(eventsDir, "task.jsonl"),
        `${JSON.stringify(event({ taskId: `bd-${runName}` }))}\n`,
      );
    }

    const events = readTaskEvents(hubProjectDir);
    expect(events.map((e) => e.taskId).sort()).toEqual([
      "bd-run-a",
      "bd-run-b",
    ]);
  });

  it("skips malformed lines and events missing type/taskId", async () => {
    const hubProjectDir = await mkdtemp(
      join(tmpdir(), "hub-event-log-malformed-"),
    );
    const eventsDir = join(hubProjectDir, "runs", "run-1", "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, "task.jsonl"),
      [
        "{ not valid json",
        JSON.stringify(event({ taskId: "bd-good" })),
        JSON.stringify({ type: "task_review_succeeded", runId: "run-1" }),
        "",
      ].join("\n"),
    );

    const events = readTaskEvents(hubProjectDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.taskId).toBe("bd-good");
  });

  it("returns an empty array when the runs dir does not exist", async () => {
    const hubProjectDir = await mkdtemp(join(tmpdir(), "hub-event-log-empty-"));
    expect(readTaskEvents(hubProjectDir)).toEqual([]);
  });

  it("ignores non-directory entries under runs/", async () => {
    const hubProjectDir = await mkdtemp(join(tmpdir(), "hub-event-log-file-"));
    const runsDir = join(hubProjectDir, "runs");
    await mkdir(runsDir, { recursive: true });
    // A stray file (not a directory) must not crash the reader.
    await writeFile(join(runsDir, "stray.txt"), "ignore me");

    expect(readTaskEvents(hubProjectDir)).toEqual([]);
  });
});
