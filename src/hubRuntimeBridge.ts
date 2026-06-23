import type {
  HubProjectRunSummary,
  HubProjectStatus,
} from "./projectStatus.js";
import {
  HUB_TASK_STATUSES,
  type HubTaskBoard,
  type HubTaskProjection,
  type HubTaskStatus,
} from "./taskBoard.js";

export type {
  HubProjectRunSummary,
  HubProjectStatus,
  HubTaskBoard,
  HubTaskProjection,
  HubTaskStatus,
};

export const EXCLUDED_HUB_TASK_STATUSES = [
  "pending",
  "triaging",
  "waiting_for_review",
  "planning",
  "reserved",
  "claimed",
  "deferred",
] as const;

export type ExcludedHubTaskStatus = (typeof EXCLUDED_HUB_TASK_STATUSES)[number];

export const HUB_RUNTIME_BRIDGE_CHANNELS = {
  invoke: "hub-runtime:invoke",
  subscribe: "hub-runtime:subscribe",
  event: "hub-runtime:event",
} as const;

export type HubRuntimeReadAction =
  | "project.getStatus"
  | "taskBoard.load"
  | "task.get"
  | "run.listSummaries"
  | "run.readEvents"
  | "proposal.readSession"
  | "config.getSummary"
  | "sync.getState";

export type HubRuntimePreviewAction =
  | "recover.preview"
  | "sync.pushPreview"
  | "sync.pullPreview"
  | "task.createPreview";

export type HubRuntimeMutatingAction =
  | "recover.execute"
  | "sync.pushExecute"
  | "sync.pullExecute"
  | "task.createExecute";

export type HubRuntimeAction =
  | HubRuntimeReadAction
  | HubRuntimePreviewAction
  | HubRuntimeMutatingAction;

export interface HubRuntimeBridgeError {
  readonly code:
    | "invalid_request"
    | "runtime_unavailable"
    | "not_found"
    | "permission_denied"
    | "confirm_required"
    | "confirm_invalid"
    | "action_disabled"
    | "command_failed";
  readonly message: string;
  readonly cliFallback?: string;
}

export type HubRuntimeBridgeResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: HubRuntimeBridgeError };

export interface HubRuntimeRequestMap {
  "project.getStatus": { readonly cwd?: string };
  "taskBoard.load": { readonly cwd?: string };
  "task.get": { readonly taskId: string; readonly cwd?: string };
  "run.listSummaries": { readonly cwd?: string };
  "run.readEvents": { readonly runDir: string };
  "proposal.readSession": { readonly runDir: string };
  "config.getSummary": { readonly cwd?: string };
  "sync.getState": { readonly cwd?: string };
  "recover.preview": {
    readonly taskId: string;
    readonly cwd?: string;
    readonly outcome?: string;
  };
  "sync.pushPreview": { readonly cwd?: string };
  "sync.pullPreview": { readonly cwd?: string };
  "task.createPreview": {
    readonly title: string;
    readonly description?: string;
    readonly cwd?: string;
  };
  "recover.execute": {
    readonly taskId: string;
    readonly cwd?: string;
    readonly outcome: string;
    readonly confirmToken: string;
  };
  "sync.pushExecute": { readonly cwd?: string; readonly confirmToken: string };
  "sync.pullExecute": { readonly cwd?: string; readonly confirmToken: string };
  "task.createExecute": {
    readonly title: string;
    readonly description?: string;
    readonly cwd?: string;
    readonly confirmToken: string;
  };
}

export type HubRuntimeRequest<A extends HubRuntimeAction = HubRuntimeAction> = {
  readonly action: A;
  readonly params: HubRuntimeRequestMap[A];
};

export interface HubRuntimeActionPreview {
  readonly action: HubRuntimeMutatingAction;
  readonly summary: string;
  readonly confirmToken: string;
  readonly disabledReason?: string;
  readonly cliFallback?: string;
}

export interface HubRunEventRecord {
  readonly file: string;
  readonly lineNumber: number;
  readonly event: unknown;
}

export interface HubRunEventsSnapshot {
  readonly runDir: string;
  readonly events: readonly HubRunEventRecord[];
}

export interface HubConfigSummary {
  readonly hubEnvPath: string;
  readonly configuredKeys: readonly string[];
  readonly missingKeys: readonly string[];
}

export interface HubSyncStateSummary {
  readonly pushPending: number;
  readonly pullPending: number;
  readonly conflict: number;
  readonly localOnly: number;
  readonly synced: number;
  readonly cliFallback: string;
}

export interface HubRuntimeResponseMap {
  "project.getStatus": HubProjectStatus;
  "taskBoard.load": HubTaskBoard;
  "task.get": HubTaskProjection;
  "run.listSummaries": readonly HubProjectRunSummary[];
  "run.readEvents": HubRunEventsSnapshot;
  "proposal.readSession": ReturnType<
    typeof import("./hubProposalSession.js").readProposalSessionArtifacts
  >;
  "config.getSummary": HubConfigSummary;
  "sync.getState": HubSyncStateSummary;
  "recover.preview": HubRuntimeActionPreview;
  "sync.pushPreview": HubRuntimeActionPreview;
  "sync.pullPreview": HubRuntimeActionPreview;
  "task.createPreview": HubRuntimeActionPreview;
  "recover.execute": { readonly taskId: string; readonly status: string };
  "sync.pushExecute": { readonly status: string };
  "sync.pullExecute": { readonly status: string };
  "task.createExecute": HubTaskProjection;
}

export const HUB_RUNTIME_MUTATING_ACTIONS = new Set<HubRuntimeAction>([
  "recover.execute",
  "sync.pushExecute",
  "sync.pullExecute",
  "task.createExecute",
]);

export const HUB_RUNTIME_PREVIEW_ACTIONS = new Set<HubRuntimeAction>([
  "recover.preview",
  "sync.pushPreview",
  "sync.pullPreview",
  "task.createPreview",
]);

export const isExcludedHubTaskStatusLabel = (
  value: string,
): value is ExcludedHubTaskStatus =>
  (EXCLUDED_HUB_TASK_STATUSES as readonly string[]).includes(value);

export const assertNoExcludedHubTaskStatuses = (
  statuses: readonly string[],
): void => {
  const invalid = statuses.filter(isExcludedHubTaskStatusLabel);
  if (invalid.length > 0) {
    throw new Error(
      `Excluded Hub task statuses are not allowed: ${invalid.join(", ")}`,
    );
  }
};

export const listCanonicalHubTaskStatuses = (): readonly HubTaskStatus[] =>
  HUB_TASK_STATUSES;

export const describeHubRuntimeAction = (
  action: HubRuntimeAction,
): {
  readonly kind: "read" | "preview" | "mutating";
  readonly requiresConfirm: boolean;
} => {
  if (HUB_RUNTIME_MUTATING_ACTIONS.has(action)) {
    return { kind: "mutating", requiresConfirm: true };
  }
  if (HUB_RUNTIME_PREVIEW_ACTIONS.has(action)) {
    return { kind: "preview", requiresConfirm: false };
  }
  return { kind: "read", requiresConfirm: false };
};

export const buildHubRuntimeExecuteParams = (
  preview: HubRuntimeActionPreview,
  params: Record<string, unknown>,
): HubRuntimeRequestMap[HubRuntimeMutatingAction] => {
  switch (preview.action) {
    case "recover.execute":
      return {
        ...params,
        outcome: "ready_for_agent",
        confirmToken: preview.confirmToken,
      };
    case "task.createExecute":
      return {
        ...params,
        confirmToken: preview.confirmToken,
      };
    case "sync.pushExecute":
    case "sync.pullExecute":
      return {
        confirmToken: preview.confirmToken,
      };
    default: {
      const exhaustive: never = preview.action;
      return exhaustive;
    }
  }
};
