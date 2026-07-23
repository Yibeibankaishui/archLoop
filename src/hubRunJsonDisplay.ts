import type { HubRunEvent } from "./hubExecution.js";
import { join } from "node:path";
import {
  projectHubRunStateOutcome,
  type HubRunDisplayState,
  type HubRunOutcomeProjection,
} from "./hubRunDisplay.js";
import type { RunHubFlowResult } from "./hubFlowExecution.js";

export const HUB_RUN_JSON_SCHEMA_VERSION = 1 as const;

export interface HubRunJsonRenderer {
  readonly event: (event: HubRunEvent) => string | undefined;
  readonly outcome: (
    result: RunHubFlowResult,
    projection: HubRunOutcomeProjection,
  ) => readonly string[];
  readonly cancellation: (
    state: HubRunDisplayState,
    exitCode?: 130 | 143,
  ) => readonly string[];
  readonly failure: (state: HubRunDisplayState, error: unknown) => string;
}

const eventTimestamp = (event: HubRunEvent): string =>
  "createdAt" in event ? event.createdAt : event.startedAt;

const eventData = (event: HubRunEvent): Readonly<Record<string, unknown>> => {
  const data = { ...event } as Record<string, unknown>;
  for (const key of [
    "eventId",
    "sequence",
    "createdAt",
    "startedAt",
    "type",
    "runId",
    "flowId",
    "batchId",
    "taskId",
  ]) {
    delete data[key];
  }
  return data;
};

const taskStage = (event: Extract<HubRunEvent, { taskId: string }>): string => {
  const words = event.type.replace(/^task_/, "").split("_");
  return words
    .map((word, index) =>
      index === 0 ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word,
    )
    .join(" ");
};

const conciseDiagnostic = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return "Run execution failed.";
  }
  return firstLine.length <= 240 ? firstLine : `${firstLine.slice(0, 237)}...`;
};

export const createHubRunJsonRenderer = (input: {
  readonly hubProjectName: string;
  readonly flowId: string;
  readonly now?: () => Date;
}): HubRunJsonRenderer => {
  let sequence = 0;
  let runDir: string | undefined;
  const seenSourceEventIds = new Set<string>();
  const sourceSequences = new Map<string, number>();
  const taskAttention = new Map<
    string,
    {
      readonly taskId: string;
      readonly stage: string;
      readonly diagnostic: string;
      readonly logPath?: string;
      readonly recoveryCommand: string;
    }
  >();
  let completedEvent:
    | Extract<HubRunEvent, { type: "run_completed" }>
    | undefined;

  const serialize = (
    runId: string,
    timestamp: string,
    type: string,
    fields: Readonly<Record<string, unknown>>,
  ): string => {
    sequence += 1;
    return JSON.stringify({
      schemaVersion: HUB_RUN_JSON_SCHEMA_VERSION,
      eventId: `${runId}:output:${sequence}`,
      sequence,
      timestamp,
      type,
      runId,
      flowId: input.flowId,
      ...fields,
    });
  };

  const now = input.now ?? (() => new Date());

  const acceptsSourceEvent = (event: HubRunEvent): boolean => {
    if (seenSourceEventIds.has(event.eventId)) {
      return false;
    }
    seenSourceEventIds.add(event.eventId);
    const scope =
      "taskId" in event
        ? `${event.runId}:task:${event.taskId}`
        : "batchId" in event
          ? `${event.runId}:batch:${event.batchId}`
          : `${event.runId}:run`;
    const currentSequence = sourceSequences.get(scope);
    if (currentSequence !== undefined && event.sequence <= currentSequence) {
      return false;
    }
    sourceSequences.set(scope, event.sequence);
    return true;
  };

  return {
    event: (event) => {
      if (!acceptsSourceEvent(event)) {
        return undefined;
      }
      if (event.type === "run_completed") {
        completedEvent = event;
        return undefined;
      }
      if (event.type === "run_started") {
        runDir = join(event.hubProjectDir, "runs", event.runId);
      }
      if (
        "taskId" in event &&
        (event.type.endsWith("_failed") || event.status === "failed")
      ) {
        const diagnosticPath =
          typeof event.diagnostics?.path === "string"
            ? event.diagnostics.path
            : typeof event.diagnostics?.logPath === "string"
              ? event.diagnostics.logPath
              : undefined;
        const fallbackLogPath = runDir
          ? event.type === "task_implementation_failed"
            ? join(runDir, "logs", `${event.taskId}.log`)
            : event.type === "task_review_failed"
              ? join(runDir, "logs", `${event.taskId}-review.log`)
              : runDir
          : undefined;
        taskAttention.set(event.taskId, {
          taskId: event.taskId,
          stage: taskStage(event),
          diagnostic: conciseDiagnostic(
            event.diagnosticSummary ??
              event.message ??
              event.failureReason ??
              "Task failed.",
          ),
          ...((diagnosticPath ?? fallbackLogPath)
            ? { logPath: diagnosticPath ?? fallbackLogPath }
            : {}),
          recoveryCommand: `archloop tasks recover ${event.taskId}`,
        });
      }
      return serialize(event.runId, eventTimestamp(event), event.type, {
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        ...(event.type === "run_started"
          ? { hubProject: input.hubProjectName }
          : {}),
        ...("batchId" in event ? { batchId: event.batchId } : {}),
        ...("taskId" in event
          ? {
              taskId: event.taskId,
              stage: taskStage(event),
              status: event.status,
            }
          : {}),
        data: eventData(event),
      });
    },
    outcome: (result, projection) => {
      const timestamp = completedEvent?.createdAt ?? now().toISOString();
      const taskRecords = projection.taskDetails.map((detail) =>
        serialize(result.runId, timestamp, "task_attention", {
          taskId: detail.taskId,
          stage: detail.stage,
          diagnostic: detail.diagnostic,
          ...(detail.logPath ? { logPath: detail.logPath } : {}),
          ...(detail.recoveryCommand
            ? { recoveryCommand: detail.recoveryCommand }
            : {}),
          ...(detail.blockingPaths
            ? { blockingPaths: detail.blockingPaths }
            : {}),
        }),
      );
      return [
        ...taskRecords,
        serialize(result.runId, timestamp, "run_completed", {
          ...(completedEvent
            ? {
                sourceEventId: completedEvent.eventId,
                sourceSequence: completedEvent.sequence,
              }
            : {}),
          outcome: projection.outcome,
          summary: projection.summary,
          batchId: result.batchId,
          counts: projection.counts,
          completedBatchCount: result.completedBatchCount,
          completedTaskCount: result.completedTaskCount,
          stopReason: result.stopReason,
          exitCode: projection.exitCode,
          logs: result.runDir,
          ...(result.autoRecoverSummary
            ? {
                autoRecover: {
                  recoveredCount: result.autoRecoverSummary.recoveredCount,
                  failedCount: result.autoRecoverSummary.failedCount,
                  recoveries: result.autoRecoverSummary.recoveries.map(
                    (entry) => ({
                      taskId: entry.taskId,
                      priorStatus: entry.priorStatus,
                      hubStatus: entry.hubStatus,
                      interruptedPhase: entry.interruptedPhase,
                    }),
                  ),
                },
              }
            : {}),
        }),
      ];
    },
    cancellation: (state, exitCode = 130) => {
      const projection = projectHubRunStateOutcome(state, {
        outcome: "cancelled",
        summary: "Run cancelled",
        exitCode,
      });
      const runId = state.runId ?? "unknown";
      const timestamp = now().toISOString();
      return [
        ...Array.from(taskAttention.values(), (detail) =>
          serialize(runId, timestamp, "task_attention", detail),
        ),
        serialize(runId, timestamp, "run_completed", {
          outcome: "cancelled",
          summary: "Run cancelled",
          cancelled: true,
          counts: projection.counts,
          completedBatchCount: Object.values(state.batches).filter(
            (batch) => batch.status === "done",
          ).length,
          completedTaskCount: projection.counts.completed,
          stopReason: "cancelled",
          exitCode,
          logs: state.runDir ?? "",
        }),
      ];
    },
    failure: (state, error) => {
      const runId = state.runId ?? "unknown";
      return serialize(runId, now().toISOString(), "run_failed", {
        outcome: "failed",
        summary: "Run failed",
        diagnostic: conciseDiagnostic(error),
        exitCode: 1,
        logs: state.runDir ?? "",
        recoveryCommand: `archloop run --flow ${input.flowId}`,
      });
    },
  };
};
