import { describe, expect, it } from "vitest";

import type {
  HubBatchMergeCompletedEvent,
  HubTaskEvent,
} from "./hubExecution.js";
import {
  createHubRunDisplayState,
  formatPlainHubRunEvent,
  reduceHubRunDisplayState,
} from "./hubRunDisplay.js";

describe("plain Hub run lifecycle output", () => {
  it("converges on the newest task stage when events arrive out of order", () => {
    const waitingForMerge: HubTaskEvent & {
      readonly eventId: string;
      readonly sequence: number;
    } = {
      type: "task_status_advanced",
      runId: "run-1",
      batchId: "batch-1",
      taskId: "task-1",
      branch: "archloop/task-1",
      createdAt: "2026-07-15T10:00:00.000Z",
      status: "waiting_for_merge",
      eventId: "run-1:9",
      sequence: 9,
    };
    const completed: typeof waitingForMerge = {
      ...waitingForMerge,
      status: "done",
      eventId: "run-1:10",
      sequence: 10,
    };
    const initialState = createHubRunDisplayState({
      hubProjectName: "Demo",
      flowId: "with-review",
    });

    const chronological = reduceHubRunDisplayState(
      reduceHubRunDisplayState(initialState, waitingForMerge),
      completed,
    );
    const outOfOrder = reduceHubRunDisplayState(
      reduceHubRunDisplayState(initialState, completed),
      waitingForMerge,
    );

    expect(outOfOrder).toEqual(chronological);
    expect(outOfOrder.tasks["task-1"]).toMatchObject({
      status: "done",
      stage: "Completed",
    });
    expect(outOfOrder.seenEventIds).toEqual(
      new Set([waitingForMerge.eventId, completed.eventId]),
    );
    expect(formatPlainHubRunEvent(waitingForMerge, outOfOrder)).toContain(
      'stage="Waiting for merge"',
    );
    expect(reduceHubRunDisplayState(outOfOrder, completed)).toBe(outOfOrder);
  });

  it("formats a completed batch in stable field order with escaped values", () => {
    const event: HubBatchMergeCompletedEvent & {
      readonly eventId: string;
      readonly sequence: number;
    } = {
      type: "batch_merge_completed",
      runId: 'run-"quoted"\nline',
      batchId: "batch\r1",
      createdAt: "2026-07-15T10:00:00.000Z",
      taskIds: ["task 1", "task\n2"],
      batchStatus: "done",
      eventId: "run-quoted:4",
      sequence: 4,
    };
    const initialState = createHubRunDisplayState({
      hubProjectName: "Escaped project",
      flowId: "with-review",
    });
    const state = reduceHubRunDisplayState(initialState, event);

    const line = formatPlainHubRunEvent(event, state);

    expect(line).toBe(
      'event=batch_merge_completed run_id="run-\\"quoted\\"\\nline" batch_id="batch\\r1" outcome="completed" completed_tasks=2 stage="Completed"',
    );
    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/);
  });
});
