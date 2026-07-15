import { join } from "node:path";

import type { HubRunEvent, HubRunStopReason } from "./hubExecution.js";

export interface HubRunDisplayState {
  readonly hubProjectName: string;
  readonly flowId: string;
  readonly runId?: string;
  readonly runDir?: string;
  readonly status:
    | "starting"
    | "running"
    | "completed"
    | "completed_with_failures"
    | "failed"
    | "cancelled";
  readonly completedBatchCount: number;
  readonly completedTaskCount: number;
  readonly stopReason?: HubRunStopReason;
  readonly batches: Readonly<
    Record<
      string,
      {
        readonly batchId: string;
        readonly selectedTaskIds: readonly string[];
        readonly status: "planning" | "merging" | "done" | "partial_failed";
        readonly stage: string;
      }
    >
  >;
  readonly tasks: Readonly<
    Record<
      string,
      {
        readonly taskId: string;
        readonly batchId: string;
        readonly status: string;
        readonly stage: string;
      }
    >
  >;
  readonly seenEventIds: ReadonlySet<string>;
  readonly eventSequences: {
    readonly run?: number;
    readonly batches: Readonly<Record<string, number>>;
    readonly tasks: Readonly<Record<string, number>>;
  };
}

export const createHubRunDisplayState = (input: {
  readonly hubProjectName: string;
  readonly flowId: string;
}): HubRunDisplayState => ({
  ...input,
  status: "starting",
  completedBatchCount: 0,
  completedTaskCount: 0,
  batches: {},
  tasks: {},
  seenEventIds: new Set(),
  eventSequences: { batches: {}, tasks: {} },
});

const TASK_STAGE_BY_STATUS: Readonly<Record<string, string>> = {
  inbox: "Inbox",
  needs_info: "Needs info",
  ready_for_agent: "Ready for agent",
  ready_for_human: "Ready for human",
  blocked: "Blocked",
  implementing: "Implementing",
  reviewing: "Reviewing",
  waiting_for_merge: "Waiting for merge",
  merging: "Merging",
  done: "Completed",
  wontfix: "Closed",
  failed: "Failed",
  sync_conflict: "Sync conflict",
};

const resolveTaskStage = (event: Extract<HubRunEvent, { taskId: string }>) => {
  switch (event.type) {
    case "merge_conflict_resolution_started":
      return "Resolving merge conflict";
    case "verification_started":
      return "Verifying";
    case "verification_passed":
    case "task_close_started":
      return "Closing";
    case "task_closed":
      return "Completed";
    default:
      return TASK_STAGE_BY_STATUS[event.status] ?? "In progress";
  }
};

const reduceBatchEvent = (
  state: HubRunDisplayState,
  event: Extract<HubRunEvent, { batchId: string }>,
): HubRunDisplayState["batches"][string] | undefined => {
  const current = state.batches[event.batchId];
  switch (event.type) {
    case "batch_started":
      return {
        batchId: event.batchId,
        selectedTaskIds: current?.selectedTaskIds ?? [],
        status: "planning",
        stage: "Planning",
      };
    case "batch_planned":
      return {
        batchId: event.batchId,
        selectedTaskIds: event.taskIds,
        status: "planning",
        stage: "Planning",
      };
    case "batch_merge_selection":
      return {
        batchId: event.batchId,
        selectedTaskIds: event.selectedTaskIds,
        status: "merging",
        stage: "Preparing to merge",
      };
    case "batch_merge_started":
      return {
        batchId: event.batchId,
        selectedTaskIds: event.taskIds,
        status: "merging",
        stage: "Merging",
      };
    case "batch_merge_completed":
      return {
        batchId: event.batchId,
        selectedTaskIds: event.taskIds,
        status: event.batchStatus,
        stage:
          event.batchStatus === "done"
            ? "Completed"
            : "Completed with failures",
      };
    default:
      return current;
  }
};

export const reduceHubRunDisplayState = (
  state: HubRunDisplayState,
  event: HubRunEvent,
): HubRunDisplayState => {
  if (state.seenEventIds.has(event.eventId)) {
    return state;
  }
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(event.eventId);
  const currentSequence =
    "taskId" in event
      ? state.eventSequences.tasks[event.taskId]
      : "batchId" in event
        ? state.eventSequences.batches[event.batchId]
        : state.eventSequences.run;
  if (currentSequence !== undefined && event.sequence <= currentSequence) {
    return { ...state, seenEventIds };
  }

  if ("taskId" in event) {
    return {
      ...state,
      tasks: {
        ...state.tasks,
        [event.taskId]: {
          taskId: event.taskId,
          batchId: event.batchId,
          status: event.status,
          stage: resolveTaskStage(event),
        },
      },
      seenEventIds,
      eventSequences: {
        ...state.eventSequences,
        tasks: {
          ...state.eventSequences.tasks,
          [event.taskId]: event.sequence,
        },
      },
    };
  }

  if ("batchId" in event) {
    const batch = reduceBatchEvent(state, event);
    return batch
      ? {
          ...state,
          batches: { ...state.batches, [event.batchId]: batch },
          seenEventIds,
          eventSequences: {
            ...state.eventSequences,
            batches: {
              ...state.eventSequences.batches,
              [event.batchId]: event.sequence,
            },
          },
        }
      : { ...state, seenEventIds };
  }

  switch (event.type) {
    case "run_started":
      return {
        ...state,
        runId: event.runId,
        runDir: join(event.hubProjectDir, "runs", event.runId),
        status: "running",
        seenEventIds,
        eventSequences: { ...state.eventSequences, run: event.sequence },
      };
    case "run_completed":
      return {
        ...state,
        runId: event.runId,
        status:
          event.stopReason === "batch_failed"
            ? "completed_with_failures"
            : "completed",
        completedBatchCount: event.completedBatchCount,
        completedTaskCount: event.completedTaskCount,
        stopReason: event.stopReason,
        seenEventIds,
        eventSequences: { ...state.eventSequences, run: event.sequence },
      };
    default:
      return { ...state, seenEventIds };
  }
};

const textField = (name: string, value: string): string =>
  `${name}=${JSON.stringify(value)}`;

const numberField = (name: string, value: number): string => `${name}=${value}`;

const formatRunSummary = (state: HubRunDisplayState): string =>
  state.stopReason === "no_ready_tasks" && state.completedBatchCount === 0
    ? "Nothing to run"
    : "Run completed";

export const formatPlainHubRunEvent = (
  event: HubRunEvent,
  state: HubRunDisplayState,
): string => {
  if ("taskId" in event) {
    return [
      `event=${event.type}`,
      textField("run_id", event.runId),
      textField("batch_id", event.batchId),
      textField("task_id", event.taskId),
      textField("stage", resolveTaskStage(event)),
    ].join(" ");
  }

  if (event.type === "batch_merge_completed") {
    return [
      "event=batch_merge_completed",
      textField("run_id", event.runId),
      textField("batch_id", event.batchId),
      textField(
        "outcome",
        event.batchStatus === "done" ? "completed" : "completed_with_failures",
      ),
      numberField("completed_tasks", event.taskIds.length),
      textField(
        "stage",
        event.batchStatus === "done" ? "Completed" : "Completed with failures",
      ),
    ].join(" ");
  }

  switch (event.type) {
    case "run_started":
      return [
        "event=run_started",
        textField("hub_project", state.hubProjectName),
        textField("flow", state.flowId),
        textField("run_id", event.runId),
        textField("logs", join(event.hubProjectDir, "runs", event.runId)),
      ].join(" ");
    case "batch_started":
      return [
        "event=batch_started",
        textField("run_id", event.runId),
        textField("batch_id", event.batchId),
        textField("stage", "Planning"),
      ].join(" ");
    case "batch_planned":
      return [
        "event=batch_planned",
        textField("run_id", event.runId),
        textField("batch_id", event.batchId),
        `selected_tasks=${JSON.stringify(event.taskIds)}`,
      ].join(" ");
    case "run_completed":
      return [
        "event=run_completed",
        textField("outcome", state.status),
        textField("summary", formatRunSummary(state)),
        numberField("completed_batches", state.completedBatchCount),
        numberField("completed_tasks", state.completedTaskCount),
        textField("run_id", event.runId),
        textField("logs", state.runDir ?? ""),
      ].join(" ");
    default:
      return [`event=${event.type}`, textField("run_id", event.runId)].join(
        " ",
      );
  }
};
