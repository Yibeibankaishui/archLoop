import {
  HUB_DESKTOP_LAYOUT,
  resolveHubDesktopSurfaceGridClass,
} from "./hubDesktopShell.js";
import { readPrdWarningFromTask } from "./hubPrdWarning.js";
import type { HubRuntimePreviewAction } from "./hubRuntimeBridge.js";
import type { HubWorktreeLeaseDiagnostic } from "./hubWorktreeLeaseDiagnostics.js";
import {
  HUB_TASK_STATUSES,
  formatHubTaskBoardStatusLabel,
  formatHubTaskCommentLines,
  formatHubTaskDetailsRows,
  type HubTaskStatus,
} from "./hubTaskShared.js";
import { resolveFailedTaskNextAction } from "./hubFailedTask.js";
import { HUB_TASK_STORE_INIT_COMMAND } from "./hubTaskStoreCommands.js";
import type { HubFailureReason } from "./hubFailedTask.js";
import type { HubProjectStatus } from "./projectStatus.js";
import type { HubTaskBoard, HubTaskProjection } from "./taskBoard.js";

export type HubTaskBoardWorkbenchPhase =
  | "loading"
  | "runtime_unavailable"
  | "empty"
  | "ready";

export type HubTaskBoardSyncState =
  | "synced"
  | "push_pending"
  | "pull_pending"
  | "conflict"
  | "local_only"
  | "none";

export type HubTaskBoardMarkerKind =
  | "sync"
  | "claim"
  | "blocked"
  | "warning"
  | "failure"
  | "dependency";

export type HubTaskBoardMarkerTone =
  | "neutral"
  | "warning"
  | "danger"
  | "active";

export interface HubTaskBoardMarker {
  readonly kind: HubTaskBoardMarkerKind;
  readonly label: string;
  readonly tone: HubTaskBoardMarkerTone;
}

export interface HubTaskBoardCard {
  readonly id: string;
  readonly title: string;
  readonly hubStatus: HubTaskStatus;
  readonly labels: readonly string[];
  readonly syncState: HubTaskBoardSyncState;
  readonly claimState?: "active" | "stale";
  readonly claimSummary?: string;
  readonly remoteRefs: readonly string[];
  readonly runRefs: readonly string[];
  readonly progressPercent: number;
  readonly progressLabel: string;
  readonly markers: readonly HubTaskBoardMarker[];
}

export interface HubTaskBoardColumn {
  readonly status: HubTaskStatus;
  readonly label: string;
  readonly tasks: readonly HubTaskBoardCard[];
}

export type HubTaskBoardActionKind = "bridge_preview" | "cli_only";

export interface HubTaskBoardAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: HubTaskBoardActionKind;
  readonly bridgeAction?: HubRuntimePreviewAction;
  readonly bridgeParams?: Record<string, unknown>;
  readonly cliFallback: string;
  readonly disabledReason?: string;
}

export interface HubTaskInspectorRow {
  readonly key: string;
  readonly value: string;
}

export interface HubTaskInspectorSection {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly HubTaskInspectorRow[];
}

export interface HubTaskInspectorModel {
  readonly taskId: string;
  readonly title: string;
  readonly hubStatus: HubTaskStatus;
  readonly sections: readonly HubTaskInspectorSection[];
  readonly commentsSummary: string;
  readonly nextActions: readonly string[];
  readonly actions: readonly HubTaskBoardAction[];
}

export interface HubTaskBoardFilterState {
  readonly searchQuery?: string;
  readonly hubStatus?: HubTaskStatus;
  readonly claimFilter?: "any" | "active" | "stale" | "unclaimed";
  readonly syncFilter?: HubTaskBoardSyncState | "any";
}

export interface HubTaskBoardWorkbenchModel {
  readonly phase: HubTaskBoardWorkbenchPhase;
  readonly runtimeError?: string;
  readonly cliFallback?: string;
  readonly columns: readonly HubTaskBoardColumn[];
  readonly totalTaskCount: number;
  readonly filteredTaskCount: number;
  readonly statusFilterOptions: readonly {
    readonly status: HubTaskStatus;
    readonly label: string;
    readonly count: number;
  }[];
  readonly inspector?: HubTaskInspectorModel;
  readonly toolbarActions: readonly HubTaskBoardAction[];
  readonly actions: readonly HubTaskBoardAction[];
}

export interface BuildHubTaskBoardWorkbenchModelInput {
  readonly loading?: boolean;
  readonly runtimeError?: string;
  readonly board?: HubTaskBoard;
  readonly projectStatus?: HubProjectStatus;
  readonly selectedTaskId?: string;
  readonly filters?: HubTaskBoardFilterState;
}

export interface BuildHubTaskInspectorModelInput {
  readonly task: HubTaskProjection;
  readonly projectStatus?: HubProjectStatus;
}

export { formatHubTaskBoardStatusLabel };

const TASK_BOARD_CLI_FALLBACK = "archloop tasks list";
const TASK_BOARD_TOOLBAR_ACTION_IDS = new Set(["create-task", "run-triage"]);

const emptyHubTaskBoardWorkbenchModel = (
  overrides: Partial<HubTaskBoardWorkbenchModel> &
    Pick<HubTaskBoardWorkbenchModel, "phase">,
): HubTaskBoardWorkbenchModel => ({
  columns: [],
  totalTaskCount: 0,
  filteredTaskCount: 0,
  statusFilterOptions: [],
  toolbarActions: [],
  actions: [],
  ...overrides,
});

const readFirstString = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

const taskStoreUnavailableReason = (
  status: HubProjectStatus | undefined,
): string | undefined => {
  if (!status) {
    return undefined;
  }
  if (!status.beadsAvailable) {
    return "Beads runtime is unavailable. Install dependencies, set ARCHLOOP_BD_PATH, or use the bundled runtime.";
  }
  if (!status.taskStoreInitialized) {
    return "Local task store is not initialized.";
  }
  return undefined;
};

const resolveTaskProgressPercent = (task: HubTaskProjection): number => {
  const index = HUB_TASK_STATUSES.indexOf(task.hubStatus);
  if (index < 0) {
    return 0;
  }
  if (HUB_TASK_STATUSES.length <= 1) {
    return 100;
  }
  return Math.round((index / (HUB_TASK_STATUSES.length - 1)) * 100);
};

const formatTaskProgressLabel = (task: HubTaskProjection): string =>
  `${formatHubTaskBoardStatusLabel(task.hubStatus)} · ${resolveTaskProgressPercent(task)}%`;

const buildClaimSummary = (task: HubTaskProjection): string | undefined => {
  if (!task.claim) {
    return undefined;
  }
  const parts = [
    task.claimState ? `claim ${task.claimState}` : "claim",
    task.claim.branch ? task.claim.branch : undefined,
    task.claim.runId ? `run ${task.claim.runId}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" · ");
};

const formatRelativeRunDirectory = (
  runDirectory: string,
  hubProjectDir: string | undefined,
): string => {
  const formatSegments = (value: string): string =>
    value.split("/").join(" / ");
  const normalize = (value: string): string => value.replaceAll("\\", "/");
  const normalizedRunDirectory = normalize(runDirectory);
  if (!hubProjectDir) {
    return formatSegments(normalizedRunDirectory);
  }

  const normalizedHubProjectDir = normalize(hubProjectDir).replace(/\/+$/, "");
  if (
    normalizedRunDirectory === normalizedHubProjectDir ||
    !normalizedRunDirectory.startsWith(`${normalizedHubProjectDir}/`)
  ) {
    return formatSegments(normalizedRunDirectory);
  }

  const relativePath = normalizedRunDirectory.slice(
    normalizedHubProjectDir.length + 1,
  );
  return formatSegments(relativePath);
};

export const readHubTaskBoardSyncState = (
  task: HubTaskProjection,
): HubTaskBoardSyncState => {
  if (task.hubStatus === "sync_conflict") {
    return "conflict";
  }
  const value = readFirstString(task.metadata, ["sync_state", "syncState"]);
  switch (value) {
    case "push_pending":
      return "push_pending";
    case "pull_pending":
      return "pull_pending";
    case "conflict":
      return "conflict";
    case "local_only":
      return "local_only";
    case "synced":
      return "synced";
    default:
      return "none";
  }
};

const readFailureReason = (
  task: HubTaskProjection,
): HubFailureReason | undefined => {
  const value = readFirstString(task.metadata, [
    "failure_reason",
    "failureReason",
    "failed",
  ]);
  switch (value) {
    case "agent_failed":
    case "sandbox_failed":
    case "merge_conflict":
    case "merge_failed":
    case "verification_failure":
    case "close_failed":
    case "unknown":
      return value;
    default:
      return undefined;
  }
};

const readBlockedReason = (task: HubTaskProjection): string | undefined =>
  readFirstString(task.metadata, [
    "blocked_reason",
    "blockedReason",
    "blocked_reason_kind",
    "blockedReasonKind",
    "blocked_by",
    "blockedBy",
  ]);

const readDependencyBlocker = (task: HubTaskProjection): string | undefined =>
  readFirstString(task.metadata, ["blocked_by", "blockedBy"]);

export const matchesHubTaskBoardSearch = (
  task: HubTaskProjection,
  searchQuery: string | undefined,
): boolean => {
  const query = searchQuery?.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const haystack = [
    task.id,
    task.title,
    task.hubStatus,
    ...task.labels,
    ...task.remoteRefs,
    ...task.runRefs,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
};

const matchesClaimFilter = (
  task: HubTaskProjection,
  claimFilter: HubTaskBoardFilterState["claimFilter"],
): boolean => {
  switch (claimFilter) {
    case "active":
      return task.claimState === "active";
    case "stale":
      return task.claimState === "stale";
    case "unclaimed":
      return task.claim === undefined;
    case "any":
    case undefined:
      return true;
  }
};

const matchesSyncFilter = (
  task: HubTaskProjection,
  syncFilter: HubTaskBoardFilterState["syncFilter"],
): boolean => {
  if (!syncFilter || syncFilter === "any") {
    return true;
  }
  return readHubTaskBoardSyncState(task) === syncFilter;
};

export const filterHubTaskBoardTasks = (
  tasks: readonly HubTaskProjection[],
  filters: HubTaskBoardFilterState = {},
): readonly HubTaskProjection[] =>
  tasks.filter((task) => {
    if (filters.hubStatus && task.hubStatus !== filters.hubStatus) {
      return false;
    }
    if (!matchesHubTaskBoardSearch(task, filters.searchQuery)) {
      return false;
    }
    if (!matchesClaimFilter(task, filters.claimFilter)) {
      return false;
    }
    if (!matchesSyncFilter(task, filters.syncFilter)) {
      return false;
    }
    return true;
  });

const syncMarkerTone = (
  syncState: HubTaskBoardSyncState,
): HubTaskBoardMarkerTone => {
  switch (syncState) {
    case "push_pending":
    case "pull_pending":
      return "warning";
    case "conflict":
      return "danger";
    case "local_only":
      return "neutral";
    default:
      return "neutral";
  }
};

export const buildHubTaskBoardCardMarkers = (
  task: HubTaskProjection,
): readonly HubTaskBoardMarker[] => {
  const markers: HubTaskBoardMarker[] = [];
  const syncState = readHubTaskBoardSyncState(task);
  if (syncState !== "none" && syncState !== "synced") {
    markers.push({
      kind: "sync",
      label: syncState.replaceAll("_", " "),
      tone: syncMarkerTone(syncState),
    });
  }

  if (task.claimState) {
    markers.push({
      kind: "claim",
      label: `claim ${task.claimState}`,
      tone: task.claimState === "active" ? "active" : "warning",
    });
  }

  const dependency = readDependencyBlocker(task);
  if (dependency) {
    markers.push({
      kind: "dependency",
      label: `blocked by ${dependency}`,
      tone: "warning",
    });
  } else if (task.hubStatus === "blocked") {
    const blockedReason = readBlockedReason(task);
    markers.push({
      kind: "blocked",
      label: blockedReason ?? "blocked",
      tone: "warning",
    });
  }

  const warning = readPrdWarningFromTask(task);
  if (warning) {
    markers.push({
      kind: "warning",
      label: `prd ${warning.severity}`,
      tone: warning.severity === "high" ? "danger" : "warning",
    });
  }

  const failureReason = readFailureReason(task);
  if (task.hubStatus === "failed" || failureReason) {
    markers.push({
      kind: "failure",
      label: failureReason ?? "failed",
      tone: "danger",
    });
  }

  return markers;
};

const buildHubTaskBoardCard = (task: HubTaskProjection): HubTaskBoardCard => ({
  id: task.id,
  title: task.title,
  hubStatus: task.hubStatus,
  labels: task.labels,
  syncState: readHubTaskBoardSyncState(task),
  claimState: task.claimState,
  claimSummary: buildClaimSummary(task),
  remoteRefs: task.remoteRefs,
  runRefs: task.runRefs,
  progressPercent: resolveTaskProgressPercent(task),
  progressLabel: formatTaskProgressLabel(task),
  markers: buildHubTaskBoardCardMarkers(task),
});

const buildHubTaskBoardColumns = (
  tasks: readonly HubTaskProjection[],
): readonly HubTaskBoardColumn[] =>
  HUB_TASK_STATUSES.map((status) => ({
    status,
    label: formatHubTaskBoardStatusLabel(status),
    tasks: tasks
      .filter((task) => task.hubStatus === status)
      .map((task) => buildHubTaskBoardCard(task)),
  })).filter((column) => column.tasks.length > 0);

const findLeaseDiagnostic = (
  task: HubTaskProjection,
  projectStatus: HubProjectStatus | undefined,
): HubWorktreeLeaseDiagnostic | undefined =>
  projectStatus?.worktreeLeaseDiagnostics.find(
    (diagnostic) => diagnostic.taskId === task.id,
  );

const buildInspectorRows = (
  entries: Record<string, string>,
): readonly HubTaskInspectorRow[] =>
  Object.entries(entries).map(([key, value]) => ({ key, value }));

const buildCommentSectionRows = (
  task: HubTaskProjection,
): readonly HubTaskInspectorRow[] => {
  const commentLines = formatHubTaskCommentLines(task);
  if (commentLines.length === 0) {
    return [{ key: "Summary", value: "No comments yet." }];
  }
  return commentLines.slice(1).map((line, index) => ({
    key: `Comment ${index + 1}`,
    value: line.trim(),
  }));
};

const matchesRunDirectoryRef = (
  runDirectory: string,
  runRef: string,
): boolean =>
  runDirectory.includes(`/runs/${runRef}`) ||
  runDirectory.endsWith(`/runs/${runRef}`) ||
  runDirectory.endsWith(`/${runRef}`);

const buildRunDirectoryTreeRows = (
  task: HubTaskProjection,
  projectStatus: HubProjectStatus | undefined,
): readonly HubTaskInspectorRow[] => {
  const runDirectories = projectStatus?.runDirectories ?? [];
  if (task.runRefs.length === 0) {
    return [];
  }

  const relevantRunDirectories = runDirectories.filter((runDirectory) =>
    task.runRefs.some((runRef) => matchesRunDirectoryRef(runDirectory, runRef)),
  );

  if (relevantRunDirectories.length === 0) {
    return task.runRefs.map((runRef, index) => ({
      key: `Run ref ${index + 1}`,
      value: runRef,
    }));
  }

  return relevantRunDirectories.map((runDirectory, index) => ({
    key: `Run dir ${index + 1}`,
    value: formatRelativeRunDirectory(
      runDirectory,
      projectStatus?.hubProjectDir,
    ),
  }));
};

const splitTaskBoardActions = (
  actions: readonly HubTaskBoardAction[],
): {
  readonly toolbarActions: readonly HubTaskBoardAction[];
  readonly boardActions: readonly HubTaskBoardAction[];
} => ({
  toolbarActions: actions.filter((action) =>
    TASK_BOARD_TOOLBAR_ACTION_IDS.has(action.id),
  ),
  boardActions: actions.filter(
    (action) => !TASK_BOARD_TOOLBAR_ACTION_IDS.has(action.id),
  ),
});

const resolveRecoverActionDescription = (
  task: HubTaskProjection,
  projectStatus: HubProjectStatus | undefined,
): string =>
  projectStatus?.failedTasks.find((entry) => entry.id === task.id)
    ?.nextAction ??
  `Reset execution state for ${task.id} after reviewing run artifacts.`;

const buildTaskInspectorActions = (
  task: HubTaskProjection,
  projectStatus: HubProjectStatus | undefined,
): readonly HubTaskBoardAction[] => {
  const actions: HubTaskBoardAction[] = [];
  const storeBlocked = taskStoreUnavailableReason(projectStatus);

  actions.push({
    id: `comment-${task.id}`,
    label: "Add comment",
    description: "Append a Beads comment without changing task status.",
    kind: "cli_only",
    cliFallback: `archloop tasks comment ${task.id}`,
    disabledReason: storeBlocked,
  });

  if (task.hubStatus === "failed") {
    actions.push({
      id: `recover-${task.id}`,
      label: `Recover ${task.id}`,
      description: resolveRecoverActionDescription(task, projectStatus),
      kind: "bridge_preview",
      bridgeAction: "recover.preview",
      bridgeParams: { taskId: task.id },
      cliFallback: `archloop tasks recover ${task.id}`,
      disabledReason: storeBlocked,
    });
  }

  if (task.remoteRefs.length > 0) {
    const remoteRef = task.remoteRefs[0] ?? "";
    actions.push({
      id: `open-remote-${task.id}`,
      label: "Open remote ref",
      description: "Inspect the linked remote task source in GitHub.",
      kind: "cli_only",
      cliFallback: remoteRef.startsWith("github#")
        ? `gh issue view ${remoteRef.slice("github#".length)}`
        : `archloop tasks show ${task.id}`,
      disabledReason:
        "Remote refs are read-only metadata. Use gh or archloop tasks show for the linked source.",
    });
  }

  if (task.runRefs.length > 0) {
    actions.push({
      id: `open-run-${task.id}`,
      label: "Open run directory",
      description: "Locate Hub run artifacts for this task.",
      kind: "cli_only",
      cliFallback: "archloop project status",
      disabledReason:
        "Run directory navigation is CLI-first in v0. Use project status to locate run artifacts.",
    });
  }

  return actions;
};

export const buildHubTaskInspectorModel = (
  input: BuildHubTaskInspectorModelInput,
): HubTaskInspectorModel => {
  const { task, projectStatus } = input;
  const detailRows = formatHubTaskDetailsRows(task);
  const lease = findLeaseDiagnostic(task, projectStatus);
  const failureReason = readFailureReason(task);
  const blockedReason = readBlockedReason(task);
  const progressPercent = resolveTaskProgressPercent(task);
  const nextActions: string[] = [];

  if (failureReason) {
    nextActions.push(resolveFailedTaskNextAction(task, failureReason));
  }
  if (blockedReason) {
    nextActions.push(`Resolve blocker: ${blockedReason}`);
  }
  if (lease) {
    nextActions.push(lease.nextAction);
  }

  const sections: HubTaskInspectorSection[] = [
    {
      id: "summary",
      title: "Summary",
      rows: buildInspectorRows({
        "Task id": task.id,
        "Hub status": task.hubStatus,
        "Beads status": detailRows["Beads status"] ?? task.beadsStatus ?? "—",
        "Claim state": task.claimState ?? "unclaimed",
        "Sync state": readHubTaskBoardSyncState(task),
        Progress: `${progressPercent}%`,
      }),
    },
    {
      id: "beads",
      title: "Beads details",
      rows: buildInspectorRows({
        "Beads id": detailRows["Beads id"] ?? task.id,
        Title: detailRows.Title ?? task.title,
        "Hub status": detailRows["Hub status"] ?? task.hubStatus,
        ...(detailRows["Beads status"]
          ? { "Beads status": detailRows["Beads status"] }
          : {}),
        ...(detailRows.Description
          ? { Description: detailRows.Description }
          : {}),
        ...(detailRows.Notes ? { Notes: detailRows.Notes } : {}),
        ...(detailRows.Labels ? { Labels: detailRows.Labels } : {}),
      }),
    },
  ];

  if (Object.keys(task.metadata).length > 0) {
    sections.push({
      id: "metadata",
      title: "Metadata",
      rows: buildInspectorRows({
        Metadata: detailRows.Metadata ?? JSON.stringify(task.metadata),
      }),
    });
  }

  if (task.remoteRefs.length > 0) {
    sections.push({
      id: "remote",
      title: "Remote refs",
      rows: task.remoteRefs.map((ref, index) => ({
        key: `Remote ${index + 1}`,
        value: ref,
      })),
    });
  }

  if (task.runRefs.length > 0) {
    sections.push({
      id: "runs",
      title: "Run refs",
      rows: task.runRefs.map((ref, index) => ({
        key: `Run ${index + 1}`,
        value: ref,
      })),
    });
  }

  const runDirectoryRows = buildRunDirectoryTreeRows(task, projectStatus);
  if (runDirectoryRows.length > 0) {
    sections.push({
      id: "run-directories",
      title: "Run directory tree",
      rows: runDirectoryRows,
    });
  }

  if (task.claim) {
    const claimRows: Record<string, string> = {
      "Claim state": task.claimState ?? "stale",
    };
    if (task.claim.branch) {
      claimRows.Branch = task.claim.branch;
    }
    if (task.claim.runId) {
      claimRows["Run id"] = task.claim.runId;
    }
    if (task.claim.batchId) {
      claimRows["Batch id"] = task.claim.batchId;
    }
    if (task.claim.claimedAt) {
      claimRows["Claimed at"] = task.claim.claimedAt;
    }
    sections.push({
      id: "claim",
      title: "Claim metadata",
      rows: buildInspectorRows(claimRows),
    });
  }

  if (lease) {
    sections.push({
      id: "lease",
      title: "Worktree lease",
      rows: buildInspectorRows({
        Branch: lease.branch,
        Worktree: lease.worktreeName,
        State: lease.leaseState,
        Message: lease.message,
        "Next action": lease.nextAction,
      }),
    });
  }

  if (failureReason || task.hubStatus === "failed") {
    const failureNextAction = failureReason
      ? resolveFailedTaskNextAction(task, failureReason)
      : `archloop tasks recover ${task.id}`;
    sections.push({
      id: "failure",
      title: "Failure",
      rows: buildInspectorRows({
        Reason: failureReason ?? "unknown",
        "Next action": failureNextAction,
      }),
    });
  }

  sections.push({
    id: "comments",
    title: "Comments",
    rows: buildCommentSectionRows(task),
  });

  return {
    taskId: task.id,
    title: task.title,
    hubStatus: task.hubStatus,
    sections,
    commentsSummary:
      task.comments.length === 0
        ? "No comments yet."
        : `${task.comments.length} comment${task.comments.length === 1 ? "" : "s"}`,
    nextActions,
    actions: buildTaskInspectorActions(task, projectStatus),
  };
};

const buildGlobalActions = (
  projectStatus: HubProjectStatus | undefined,
): readonly HubTaskBoardAction[] => {
  const storeBlocked = taskStoreUnavailableReason(projectStatus);
  const actions: HubTaskBoardAction[] = [
    {
      id: "create-task",
      label: "Create Task",
      description:
        "Create a new local Hub task in Beads and preview the write before applying it.",
      kind: "bridge_preview",
      bridgeAction: "task.createPreview",
      bridgeParams: {},
      cliFallback: "archloop tasks create --title <title>",
      disabledReason:
        "Enter a title in the desktop create form to preview the local task write.",
    },
    {
      id: "run-triage",
      label: "Run Triage",
      description:
        "Start the triage proposal flow for inbox and needs_info tasks.",
      kind: "cli_only",
      cliFallback: "archloop tasks triage --query inbox,needs_info",
      disabledReason:
        "The desktop does not expose a triage proposal preview in v0. Use archloop tasks triage --query inbox,needs_info from the CLI.",
    },
    {
      id: "initialize-task-store",
      label: "Initialize task store",
      description: "Create the local Beads task store for this repository.",
      kind: "cli_only",
      cliFallback: HUB_TASK_STORE_INIT_COMMAND,
      disabledReason: projectStatus?.taskStoreInitialized
        ? "Task store is already initialized."
        : "Task store init has no desktop preview/confirm path in v0. Run the CLI command locally.",
    },
    {
      id: "sync-push",
      label: "Preview push",
      description:
        "Review local task changes before pushing to the remote source.",
      kind: "bridge_preview",
      bridgeAction: "sync.pushPreview",
      bridgeParams: {},
      cliFallback: "archloop tasks push",
      disabledReason: storeBlocked,
    },
    {
      id: "sync-pull",
      label: "Preview pull",
      description:
        "Review remote task changes before pulling into the local store.",
      kind: "bridge_preview",
      bridgeAction: "sync.pullPreview",
      bridgeParams: {},
      cliFallback: "archloop tasks pull",
      disabledReason: storeBlocked,
    },
  ];

  return actions;
};

export const buildHubTaskBoardWorkbenchModel = (
  input: BuildHubTaskBoardWorkbenchModelInput,
): HubTaskBoardWorkbenchModel => {
  if (input.loading) {
    return emptyHubTaskBoardWorkbenchModel({ phase: "loading" });
  }

  if (input.runtimeError) {
    return emptyHubTaskBoardWorkbenchModel({
      phase: "runtime_unavailable",
      runtimeError: input.runtimeError,
      cliFallback: TASK_BOARD_CLI_FALLBACK,
    });
  }

  const board = input.board;
  const allTasks = board?.tasks ?? [];
  const globalActions = buildGlobalActions(input.projectStatus);
  const actionGroups = splitTaskBoardActions(globalActions);
  if (allTasks.length === 0) {
    return emptyHubTaskBoardWorkbenchModel({
      phase: "empty",
      cliFallback: TASK_BOARD_CLI_FALLBACK,
      toolbarActions: actionGroups.toolbarActions,
      actions: actionGroups.boardActions,
    });
  }

  const filteredTasks = filterHubTaskBoardTasks(allTasks, input.filters);
  const selectedTask =
    input.selectedTaskId !== undefined
      ? allTasks.find((task) => task.id === input.selectedTaskId)
      : undefined;

  const statusFilterOptions = HUB_TASK_STATUSES.map((status) => ({
    status,
    label: formatHubTaskBoardStatusLabel(status),
    count: allTasks.filter((task) => task.hubStatus === status).length,
  })).filter((entry) => entry.count > 0);

  return {
    phase: "ready",
    columns: buildHubTaskBoardColumns(filteredTasks),
    totalTaskCount: allTasks.length,
    filteredTaskCount: filteredTasks.length,
    statusFilterOptions,
    inspector: selectedTask
      ? buildHubTaskInspectorModel({
          task: selectedTask,
          projectStatus: input.projectStatus,
        })
      : undefined,
    toolbarActions: actionGroups.toolbarActions,
    actions: actionGroups.boardActions,
  };
};

export const resolveHubTaskBoardGridClass = (viewportWidth: number): string =>
  `${resolveHubDesktopSurfaceGridClass(
    "hub-task-board-grid",
    "hub-task-board-grid-narrow",
    viewportWidth,
  )}${viewportWidth >= HUB_DESKTOP_LAYOUT.denseSurfaceBreakpointPx ? " hub-task-board-grid-board-first" : ""}`;
