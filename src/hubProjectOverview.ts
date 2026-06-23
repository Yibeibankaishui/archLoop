import { HUB_DESKTOP_LAYOUT } from "./hubDesktopShell.js";
import { HUB_TASK_STORE_INIT_COMMAND } from "./hubTaskStore.js";
import type { HubRuntimePreviewAction } from "./hubRuntimeBridge.js";
import type {
  HubProjectBatchSummary,
  HubProjectFailedTask,
  HubProjectStatus,
  HubProjectSyncCounts,
  HubProjectTaskCounts,
} from "./projectStatus.js";
import type { HubWorktreeLeaseDiagnostic } from "./hubWorktreeLeaseDiagnostics.js";
import type { HubTaskStatus } from "./taskBoard.js";

export type HubOverviewPhase =
  | "loading"
  | "runtime_unavailable"
  | "ready";

export type HubOverviewBannerSeverity = "info" | "warning" | "error";

export interface HubOverviewBanner {
  readonly id: string;
  readonly severity: HubOverviewBannerSeverity;
  readonly title: string;
  readonly message: string;
  readonly cliFallback?: string;
}

export type HubOverviewActionKind = "bridge_preview" | "cli_only";

export interface HubOverviewAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: HubOverviewActionKind;
  readonly bridgeAction?: HubRuntimePreviewAction;
  readonly bridgeParams?: Record<string, unknown>;
  readonly cliFallback: string;
  readonly disabledReason?: string;
}

export type HubOverviewSyncScope = "local" | "remote";

export interface HubOverviewSyncCount {
  readonly label: string;
  readonly value: number;
  readonly tone?: "warning" | "danger" | "neutral";
}

export interface HubOverviewSyncSection {
  readonly title: string;
  readonly scope: HubOverviewSyncScope;
  readonly description: string;
  readonly counts: readonly HubOverviewSyncCount[];
}

export interface HubOverviewProjectPaths {
  readonly repoRoot: string;
  readonly archloopUserDataDir: string;
  readonly hubProjectDir: string;
  readonly projectRegistered: boolean;
  readonly beadsAvailable: boolean;
  readonly taskStoreInitialized: boolean;
}

export interface HubOverviewStatusCountEntry {
  readonly status: HubTaskStatus | string;
  readonly count: number;
}

export interface HubOverviewModel {
  readonly phase: HubOverviewPhase;
  readonly runtimeError?: string;
  readonly banners: readonly HubOverviewBanner[];
  readonly actions: readonly HubOverviewAction[];
  readonly projectPaths?: HubOverviewProjectPaths;
  readonly taskCounts?: HubProjectTaskCounts;
  readonly statusCountEntries: readonly HubOverviewStatusCountEntry[];
  readonly syncSections: readonly HubOverviewSyncSection[];
  readonly failedTasks: readonly HubProjectFailedTask[];
  readonly activeBatches: readonly HubProjectBatchSummary[];
  readonly runDirectories: readonly string[];
  readonly recentEvents: readonly string[];
  readonly worktreeLeaseDiagnostics: readonly HubWorktreeLeaseDiagnostic[];
}

export interface BuildHubOverviewModelInput {
  readonly loading?: boolean;
  readonly runtimeError?: string;
  readonly status?: HubProjectStatus;
}

const REMOTE_SYNC_DOES_NOT_MUTATE_COPY =
  "Counts reflect local task metadata only. Remote sync requires preview and confirm; approving a proposal does not mutate GitHub.";

const taskStoreUnavailableReason = (status: HubProjectStatus): string | undefined => {
  if (!status.beadsAvailable) {
    return "Beads runtime is unavailable. Install dependencies, set ARCHLOOP_BD_PATH, or use the bundled runtime.";
  }
  if (!status.taskStoreInitialized) {
    return "Local task store is not initialized.";
  }
  return undefined;
};

export const formatHubOverviewPath = (
  value: string,
  maxLength = 56,
): string => {
  if (value.length <= maxLength) {
    return value;
  }

  const segments = value.split("/").filter((segment) => segment.length > 0);
  let condensed = value;
  while (segments.length > 1 && condensed.length > maxLength) {
    segments.shift();
    condensed = `…/${segments.join("/")}`;
  }

  if (condensed.length <= maxLength) {
    return condensed;
  }

  return `…${value.slice(-(maxLength - 1))}`;
};

export const resolveHubOverviewGridClass = (viewportWidth: number): string =>
  viewportWidth < HUB_DESKTOP_LAYOUT.narrowBreakpointPx
    ? "hub-overview-grid hub-overview-grid-narrow"
    : "hub-overview-grid";

const resolvePhase = (
  input: BuildHubOverviewModelInput,
): HubOverviewPhase => {
  if (input.loading) {
    return "loading";
  }
  if (input.runtimeError) {
    return "runtime_unavailable";
  }
  return "ready";
};

const buildBanners = (status: HubProjectStatus): readonly HubOverviewBanner[] => {
  const banners: HubOverviewBanner[] = [];

  if (!status.beadsAvailable) {
    banners.push({
      id: "beads-unavailable",
      severity: "warning",
      title: "Task runtime unavailable",
      message:
        "archLoop cannot read the local Beads task store. Hub actions stay read-only until the runtime is available.",
      cliFallback: "archloop tasks list",
    });
  } else if (!status.taskStoreInitialized) {
    banners.push({
      id: "task-store-missing",
      severity: "warning",
      title: "Local task store not initialized",
      message:
        "Initialize the local task store before starting flows or recovering failed work.",
      cliFallback: HUB_TASK_STORE_INIT_COMMAND,
    });
  }

  if (status.syncCounts.conflict > 0) {
    banners.push({
      id: "sync-conflict",
      severity: "error",
      title: "Sync conflicts need review",
      message: `${status.syncCounts.conflict} task(s) are in sync_conflict. Resolve conflicts before pushing remote changes.`,
      cliFallback: "archloop tasks sync",
    });
  } else if (status.syncCounts.pushPending > 0) {
    banners.push({
      id: "sync-push-pending",
      severity: "warning",
      title: "Local changes waiting to push",
      message: `${status.syncCounts.pushPending} task(s) have push_pending metadata. Preview sync before executing.`,
      cliFallback: "archloop tasks push",
    });
  }

  if (status.failedTasks.length > 0) {
    banners.push({
      id: "failed-work",
      severity: "error",
      title: "Failed tasks need recovery",
      message: `${status.failedTasks.length} task(s) are failed. Recover or inspect run directories before starting new batches.`,
      cliFallback: `archloop tasks recover ${status.failedTasks[0]?.id ?? "<id>"}`,
    });
  }

  if (status.worktreeLeaseDiagnostics.length > 0) {
    banners.push({
      id: "lease-diagnostics",
      severity: "warning",
      title: "Worktree lease diagnostics",
      message: `${status.worktreeLeaseDiagnostics.length} lease issue(s) may block recovery or new claims.`,
      cliFallback: "archloop tasks doctor",
    });
  }

  return banners;
};

const buildSyncTone = (
  label: string,
  value: number,
): HubOverviewSyncCount["tone"] => {
  if (value === 0) {
    return "neutral";
  }
  if (label === "conflict") {
    return "danger";
  }
  if (label === "push pending") {
    return "warning";
  }
  return "neutral";
};

const buildRemoteSyncCounts = (
  syncCounts: HubProjectSyncCounts,
): readonly HubOverviewSyncCount[] => {
  const entries: Array<[string, number]> = [
    ["push pending", syncCounts.pushPending],
    ["conflict", syncCounts.conflict],
    ["local only", syncCounts.localOnly],
    ["synced", syncCounts.synced],
  ];
  return entries.map(([label, value]) => ({
    label,
    value,
    tone: buildSyncTone(label, value),
  }));
};

const buildLocalSyncSection = (
  status: HubProjectStatus,
): HubOverviewSyncSection => {
  const unavailable = taskStoreUnavailableReason(status);
  const counts: HubOverviewSyncCount[] = unavailable
    ? [
        {
          label: "ready tasks",
          value: 0,
          tone: "warning",
        },
        {
          label: "total tasks",
          value: 0,
          tone: "warning",
        },
      ]
    : [
        {
          label: "ready tasks",
          value: status.taskCounts.ready,
          tone: status.taskCounts.ready > 0 ? "neutral" : "warning",
        },
        {
          label: "total tasks",
          value: status.taskCounts.total,
          tone: "neutral",
        },
      ];

  return {
    title: "Local task store",
    scope: "local",
    description: unavailable
      ? (unavailable ?? "Local task store is unavailable.")
      : "Counts come from the local Beads task store in this repository.",
    counts,
  };
};

const buildRemoteSyncSection = (
  status: HubProjectStatus,
): HubOverviewSyncSection => ({
  title: "Remote sync metadata",
  scope: "remote",
  description: REMOTE_SYNC_DOES_NOT_MUTATE_COPY,
  counts: buildRemoteSyncCounts(status.syncCounts),
});

const buildActions = (status: HubProjectStatus): readonly HubOverviewAction[] => {
  const actions: HubOverviewAction[] = [];
  const storeBlocked = taskStoreUnavailableReason(status);

  actions.push({
    id: "initialize-task-store",
    label: "Initialize task store",
    description: "Create the local Beads task store for this repository.",
    kind: "cli_only",
    cliFallback: HUB_TASK_STORE_INIT_COMMAND,
    disabledReason: status.taskStoreInitialized
      ? "Task store is already initialized."
      : "Task store init has no desktop preview/confirm path in v0. Run the CLI command locally.",
  });

  actions.push({
    id: "sync-push",
    label: "Preview push",
    description: "Review local task changes before pushing to the remote source.",
    kind: "bridge_preview",
    bridgeAction: "sync.pushPreview",
    bridgeParams: {},
    cliFallback: "archloop tasks push",
    disabledReason: storeBlocked,
  });

  actions.push({
    id: "sync-pull",
    label: "Preview pull",
    description: "Review remote task changes before pulling into the local store.",
    kind: "bridge_preview",
    bridgeAction: "sync.pullPreview",
    bridgeParams: {},
    cliFallback: "archloop tasks pull",
    disabledReason: storeBlocked,
  });

  actions.push({
    id: "open-agent-config",
    label: "Review agent config",
    description: "Inspect configured provider keys and missing Hub env entries.",
    kind: "cli_only",
    cliFallback: "archloop agent-config list",
    disabledReason:
      "Config summary is available in Hub diagnostics. CLI remains the write path for agent roles in v0.",
  });

  for (const task of status.failedTasks) {
    actions.push({
      id: `recover-${task.id}`,
      label: `Recover ${task.id}`,
      description: task.nextAction,
      kind: "bridge_preview",
      bridgeAction: "recover.preview",
      bridgeParams: { taskId: task.id },
      cliFallback: `archloop tasks recover ${task.id}`,
      disabledReason: storeBlocked,
    });
  }

  return actions;
};

const buildStatusCountEntries = (
  status: HubProjectStatus,
): readonly HubOverviewStatusCountEntry[] =>
  Object.entries(status.statusCounts)
    .filter(([, count]) => count > 0)
    .map(([statusKey, count]) => ({
      status: statusKey,
      count,
    }))
    .sort((left, right) => left.status.localeCompare(right.status));

export const buildHubOverviewModel = (
  input: BuildHubOverviewModelInput,
): HubOverviewModel => {
  const phase = resolvePhase(input);

  if (phase === "loading") {
    return {
      phase,
      banners: [],
      actions: [],
      statusCountEntries: [],
      syncSections: [],
      failedTasks: [],
      activeBatches: [],
      runDirectories: [],
      recentEvents: [],
      worktreeLeaseDiagnostics: [],
    };
  }

  if (phase === "runtime_unavailable") {
    return {
      phase,
      runtimeError: input.runtimeError,
      banners: [
        {
          id: "runtime-unavailable",
          severity: "error",
          title: "Hub runtime unavailable",
          message:
            input.runtimeError ??
            "The desktop runtime bridge could not load local Hub data.",
          cliFallback: "archloop project status",
        },
      ],
      actions: [],
      statusCountEntries: [],
      syncSections: [],
      failedTasks: [],
      activeBatches: [],
      runDirectories: [],
      recentEvents: [],
      worktreeLeaseDiagnostics: [],
    };
  }

  const status = input.status;
  if (!status) {
    return {
      phase: "runtime_unavailable",
      runtimeError: "Hub project status is unavailable.",
      banners: [
        {
          id: "runtime-unavailable",
          severity: "error",
          title: "Hub runtime unavailable",
          message: "Hub project status is unavailable.",
          cliFallback: "archloop project status",
        },
      ],
      actions: [],
      statusCountEntries: [],
      syncSections: [],
      failedTasks: [],
      activeBatches: [],
      runDirectories: [],
      recentEvents: [],
      worktreeLeaseDiagnostics: [],
    };
  }

  return {
    phase,
    projectPaths: {
      repoRoot: status.repoRoot,
      archloopUserDataDir: status.archloopUserDataDir,
      hubProjectDir: status.hubProjectDir,
      projectRegistered: status.projectRegistered,
      beadsAvailable: status.beadsAvailable,
      taskStoreInitialized: status.taskStoreInitialized,
    },
    taskCounts: status.taskCounts,
    statusCountEntries: buildStatusCountEntries(status),
    syncSections: [
      buildLocalSyncSection(status),
      buildRemoteSyncSection(status),
    ],
    banners: buildBanners(status),
    actions: buildActions(status),
    failedTasks: status.failedTasks,
    activeBatches: status.activeBatches,
    runDirectories: status.runDirectories,
    recentEvents: status.recentEvents,
    worktreeLeaseDiagnostics: status.worktreeLeaseDiagnostics,
  };
};
