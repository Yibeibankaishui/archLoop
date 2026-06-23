import { useEffect, useMemo, useState } from "react";

import type {
  HubProjectStatus,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
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
  readonly onInspectorChange?: (inspector: HubTaskInspectorModel | undefined) => void;
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
  const [claimFilter, setClaimFilter] = useState<
    HubTaskBoardFilterState["claimFilter"]
  >("any");
  const [syncFilter, setSyncFilter] = useState<
    HubTaskBoardFilterState["syncFilter"]
  >("any");

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
    [
      board,
      filters,
      loading,
      projectStatus,
      runtimeError,
      selectedTaskId,
    ],
  );

  useEffect(() => {
    onInspectorChange?.(model.inspector);
  }, [model.inspector, onInspectorChange]);

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

  return (
    <div className={resolveHubTaskBoardGridClass(viewportWidth)}>
      <section className="hub-panel hub-task-board-toolbar" aria-label="Task filters">
        <label className="hub-task-board-search">
          <span className="hub-muted">Search</span>
          <input
            type="search"
            className="hub-input hub-focus-ring"
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
      </section>

      {model.phase === "empty" ? (
        <div className="hub-panel hub-empty">No local tasks available.</div>
      ) : (
        <div className="hub-board" role="region" aria-label="Hub task board">
          {model.columns.map((column) => (
            <section key={column.status} className="hub-board-column">
              <header className="hub-board-column-header">
                <h2>{column.label}</h2>
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
                      <span className="hub-mono hub-card-id">{task.id}</span>
                      <span className="hub-card-title">{task.title}</span>
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
                        <span
                          className={`hub-status hub-status-${task.hubStatus}`}
                        >
                          {task.hubStatus}
                        </span>
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
      )}

      {model.actions.length > 0 ? (
        <section className="hub-panel hub-task-board-actions" aria-label="Task board actions">
          <h2>Board actions</h2>
          <div className="hub-task-board-action-list">
            {model.actions.map((action) => (
              <HubWorkbenchActionButton
                key={action.id}
                action={action}
                variant="task-board"
                onPreviewAction={onPreviewAction}
                onConfirmAction={onConfirmAction}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
};
