import { useEffect, useMemo, useState } from "react";

import type {
  HubProjectStatus,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
  HubTaskBoardAction,
  HubTaskBoard,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  buildHubTaskBoardWorkbenchModel,
  resolveHubTaskBoardGridClass,
  type HubTaskBoardFilterState,
  type HubTaskBoardMarkerTone,
  type HubTaskInspectorModel,
} from "@yibeibankaishui/archloop/hub-task-board-workbench";
import type { HubTaskStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";

import { HubWorkbenchActionButton } from "../HubWorkbenchActionButton";

export interface TaskBoardViewProps {
  readonly board?: HubTaskBoard;
  readonly projectStatus?: HubProjectStatus;
  readonly loading?: boolean;
  readonly runtimeError?: string;
  readonly viewportWidth: number;
  readonly selectedTaskId?: string;
  readonly onSelectTask: (taskId: string) => void;
  readonly onPreviewAction?: (
    action: HubRuntimePreviewAction,
    params: Record<string, unknown>,
  ) => Promise<HubRuntimeActionPreview | undefined>;
  readonly onConfirmAction?: (
    preview: HubRuntimeActionPreview,
    params: Record<string, unknown>,
  ) => Promise<string | undefined>;
  readonly onInspectorChange?: (
    inspector: HubTaskInspectorModel | undefined,
  ) => void;
}

const markerClassName = (tone: HubTaskBoardMarkerTone): string => {
  switch (tone) {
    case "danger":
      return "hub-chip is-error";
    case "warning":
      return "hub-chip is-warning";
    case "active":
      return "hub-chip is-active";
    default:
      return "hub-chip";
  }
};

const syncStateClassName = (
  syncState: HubTaskBoardFilterState["syncFilter"] | "synced" | "none",
): string => {
  switch (syncState) {
    case "conflict":
      return "hub-chip is-error";
    case "local_only":
    case "push_pending":
    case "pull_pending":
      return "hub-chip is-warning";
    case "synced":
    default:
      return "hub-chip";
  }
};

const DEFAULT_CREATE_TASK_ACTION: HubTaskBoardAction = {
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
};

const DEFAULT_RUN_TRIAGE_ACTION: HubTaskBoardAction = {
  id: "run-triage",
  label: "Run Triage",
  description: "Start the triage proposal flow for inbox and needs_info tasks.",
  kind: "cli_only",
  cliFallback: "archloop tasks triage --query inbox,needs_info",
  disabledReason:
    "The desktop does not expose a triage proposal preview in v0. Use archloop tasks triage --query inbox,needs_info from the CLI.",
};

const findToolbarAction = (
  actions: readonly HubTaskBoardAction[],
  actionId: string,
): HubTaskBoardAction | undefined =>
  actions.find((action) => action.id === actionId);

const resolveTaskStoreBlockedReason = (
  projectStatus: HubProjectStatus | undefined,
): string | undefined => {
  if (!projectStatus?.beadsAvailable) {
    return "Beads runtime is unavailable. Install dependencies, set ARCHLOOP_BD_PATH, or use the bundled runtime.";
  }
  if (!projectStatus.taskStoreInitialized) {
    return "Local task store is not initialized. Run archloop tasks init first.";
  }
  return undefined;
};

export const TaskBoardView = ({
  board,
  projectStatus,
  loading,
  runtimeError,
  viewportWidth,
  selectedTaskId,
  onSelectTask,
  onPreviewAction,
  onConfirmAction,
  onInspectorChange,
}: TaskBoardViewProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [hubStatus, setHubStatus] = useState<HubTaskStatus | "all">("all");
  const [claimFilter, setClaimFilter] =
    useState<HubTaskBoardFilterState["claimFilter"]>("any");
  const [syncFilter, setSyncFilter] =
    useState<HubTaskBoardFilterState["syncFilter"]>("any");
  const [createTaskTitle, setCreateTaskTitle] = useState("");
  const [createTaskDescription, setCreateTaskDescription] = useState("");

  const filters = useMemo<HubTaskBoardFilterState>(
    () => ({
      searchQuery,
      hubStatus: hubStatus === "all" ? undefined : hubStatus,
      claimFilter,
      syncFilter,
    }),
    [claimFilter, hubStatus, searchQuery, syncFilter],
  );

  const model = useMemo(
    () =>
      buildHubTaskBoardWorkbenchModel({
        loading,
        runtimeError,
        board,
        projectStatus,
        selectedTaskId,
        filters,
      }),
    [board, filters, loading, projectStatus, runtimeError, selectedTaskId],
  );

  useEffect(() => {
    onInspectorChange?.(model.inspector);
  }, [model.inspector, onInspectorChange]);

  const createTaskActionBase =
    findToolbarAction(model.toolbarActions, "create-task") ??
    DEFAULT_CREATE_TASK_ACTION;

  const createTaskAction: HubTaskBoardAction = useMemo(() => {
    const title = createTaskTitle.trim();
    const description = createTaskDescription.trim();
    const storeBlockedReason = resolveTaskStoreBlockedReason(projectStatus);
    return {
      ...createTaskActionBase,
      bridgeParams: {
        title,
        ...(description.length > 0 ? { description } : {}),
      },
      cliFallback:
        title.length > 0
          ? `archloop tasks create --title "${title}"`
          : createTaskActionBase.cliFallback,
      disabledReason:
        title.length > 0
          ? storeBlockedReason
          : "Enter a task title to preview the local Beads write.",
    };
  }, [
    createTaskActionBase,
    createTaskDescription,
    createTaskTitle,
    projectStatus,
  ]);

  const runTriageAction =
    findToolbarAction(model.toolbarActions, "run-triage") ??
    DEFAULT_RUN_TRIAGE_ACTION;

  if (model.phase === "loading") {
    return <div className="hub-panel hub-empty">Loading local Hub tasks…</div>;
  }

  if (model.phase === "runtime_unavailable") {
    return (
      <div className="hub-panel hub-empty hub-error" role="alert">
        <h2>Runtime unavailable</h2>
        <p>{model.runtimeError}</p>
        <p className="hub-muted">
          CLI fallback: <code>{model.cliFallback}</code>
        </p>
      </div>
    );
  }

  const renderToolbar = () => (
    <section
      className="hub-panel hub-task-board-toolbar"
      aria-label="Task board toolbar"
    >
      <div className="hub-task-board-toolbar-copy">
        <p className="hub-eyebrow hub-mono">LOCAL PROJECTION</p>
        <h2>Task Board</h2>
        <p className="hub-muted">
          Dense Kanban projection of the local Beads task store, flow state, and
          sync metadata.
        </p>
      </div>

      <div className="hub-task-board-filter-strip">
        <label className="hub-task-board-search">
          <span className="hub-muted">Search</span>
          <input
            type="search"
            className="hub-input hub-focus-ring hub-task-board-terminal-filter"
            value={searchQuery}
            placeholder="Task id, title, label, ref…"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>
        <label className="hub-task-board-filter">
          <span className="hub-muted">Status</span>
          <select
            className="hub-input hub-focus-ring"
            value={hubStatus}
            onChange={(event) =>
              setHubStatus(event.target.value as HubTaskStatus | "all")
            }
          >
            <option value="all">All statuses</option>
            {model.statusFilterOptions.map((option) => (
              <option key={option.status} value={option.status}>
                {option.label} ({option.count})
              </option>
            ))}
          </select>
        </label>
        <label className="hub-task-board-filter">
          <span className="hub-muted">Claim</span>
          <select
            className="hub-input hub-focus-ring"
            value={claimFilter ?? "any"}
            onChange={(event) =>
              setClaimFilter(
                event.target.value as HubTaskBoardFilterState["claimFilter"],
              )
            }
          >
            <option value="any">Any claim state</option>
            <option value="active">Active claim</option>
            <option value="stale">Stale claim</option>
            <option value="unclaimed">Unclaimed</option>
          </select>
        </label>
        <label className="hub-task-board-filter">
          <span className="hub-muted">Sync</span>
          <select
            className="hub-input hub-focus-ring"
            value={syncFilter ?? "any"}
            onChange={(event) =>
              setSyncFilter(
                event.target.value as HubTaskBoardFilterState["syncFilter"],
              )
            }
          >
            <option value="any">Any sync state</option>
            <option value="synced">Synced</option>
            <option value="push_pending">Push pending</option>
            <option value="pull_pending">Pull pending</option>
            <option value="local_only">Local only</option>
            <option value="conflict">Conflict</option>
          </select>
        </label>
        <p className="hub-muted hub-task-board-count">
          Showing {model.filteredTaskCount} of {model.totalTaskCount} tasks
        </p>
      </div>

      <div className="hub-task-board-toolbar-actions">
        <div className="hub-task-board-toolbar-card hub-task-board-toolbar-card-create">
          <div className="hub-task-board-create-fields">
            <label className="hub-task-board-create-field">
              <span className="hub-muted">Task title</span>
              <input
                type="text"
                className="hub-input hub-focus-ring"
                value={createTaskTitle}
                placeholder="Restore task board fidelity"
                onChange={(event) => setCreateTaskTitle(event.target.value)}
              />
            </label>
            <label className="hub-task-board-create-field hub-task-board-create-description-field">
              <span className="hub-muted">Description</span>
              <input
                type="text"
                className="hub-input hub-focus-ring"
                value={createTaskDescription}
                placeholder="Optional local task details"
                onChange={(event) =>
                  setCreateTaskDescription(event.target.value)
                }
              />
            </label>
          </div>
          <HubWorkbenchActionButton
            action={createTaskAction}
            variant="task-board"
            layout="compact"
            onPreviewAction={onPreviewAction}
            onConfirmAction={onConfirmAction}
          />
        </div>

        <div className="hub-task-board-toolbar-card hub-task-board-toolbar-card-triage">
          <HubWorkbenchActionButton
            action={runTriageAction}
            variant="task-board"
            layout="compact"
            onPreviewAction={onPreviewAction}
            onConfirmAction={onConfirmAction}
          />
        </div>
      </div>
    </section>
  );

  const renderBoard = () =>
    model.phase === "empty" ? (
      <div className="hub-panel hub-empty">No local tasks available.</div>
    ) : (
      <div className="hub-board" role="region" aria-label="Hub task board">
        {model.columns.map((column) => (
          <section key={column.status} className="hub-board-column">
            <header className="hub-board-column-header">
              <h2 className="hub-mono hub-task-board-column-label">
                {column.label}
              </h2>
              <span className="hub-chip">{column.tasks.length}</span>
            </header>
            <ul className="hub-board-cards">
              {column.tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`hub-card hub-focus-ring ${selectedTaskId === task.id ? "is-selected" : ""}`}
                    aria-pressed={selectedTaskId === task.id}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <div className="hub-card-topline">
                      <span className="hub-mono hub-card-id">{task.id}</span>
                      <span className="hub-chip hub-card-progress-chip">
                        {task.progressLabel}
                      </span>
                    </div>
                    <span className="hub-card-title">{task.title}</span>
                    <div className="hub-card-progress" aria-hidden="true">
                      <span
                        className={`hub-card-progress-fill hub-status-${task.hubStatus}`}
                        style={{ width: `${task.progressPercent}%` }}
                      />
                    </div>
                    <div className="hub-card-meta-row">
                      <span
                        className={`hub-status hub-status-${task.hubStatus}`}
                      >
                        {task.hubStatus}
                      </span>
                      {task.syncState !== "synced" &&
                      task.syncState !== "none" ? (
                        <span className={syncStateClassName(task.syncState)}>
                          {task.syncState.replaceAll("_", " ")}
                        </span>
                      ) : null}
                    </div>
                    {task.claimSummary ? (
                      <div className="hub-card-claim-row">
                        <span className="hub-eyebrow">Active claim</span>
                        <span className="hub-mono">{task.claimSummary}</span>
                      </div>
                    ) : null}
                    {task.labels.length > 0 ? (
                      <div className="hub-card-labels">
                        {task.labels.map((label) => (
                          <span key={label} className="hub-chip">
                            {label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="hub-card-markers">
                      {task.markers.map((marker) => (
                        <span
                          key={`${marker.kind}-${marker.label}`}
                          className={markerClassName(marker.tone)}
                        >
                          {marker.label}
                        </span>
                      ))}
                    </div>
                    {task.remoteRefs.length > 0 ? (
                      <span className="hub-mono hub-muted">
                        {task.remoteRefs.join(", ")}
                      </span>
                    ) : null}
                    {task.runRefs.length > 0 ? (
                      <span className="hub-mono hub-muted">
                        {task.runRefs.join(", ")}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );

  return (
    <div className={resolveHubTaskBoardGridClass(viewportWidth)}>
      {renderToolbar()}
      {renderBoard()}

      {model.actions.length > 0 ? (
        <details
          className="hub-panel hub-task-board-actions"
          aria-label="Task board actions"
        >
          <summary className="hub-task-board-actions-summary hub-focus-ring">
            <span>Board actions</span>
            <span className="hub-chip">{model.actions.length}</span>
          </summary>
          <div className="hub-task-board-action-list">
            {model.actions.map((action) => (
              <div key={action.id}>
                <HubWorkbenchActionButton
                  action={action}
                  variant="task-board"
                  onPreviewAction={onPreviewAction}
                  onConfirmAction={onConfirmAction}
                />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
};
