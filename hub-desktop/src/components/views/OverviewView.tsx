import { useMemo, useState } from "react";

import type {
  HubProjectStatus,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  buildHubOverviewModel,
  formatHubOverviewPath,
  resolveHubOverviewGridClass,
  type HubOverviewAction,
  type HubOverviewBannerSeverity,
} from "@yibeibankaishui/archloop/hub-project-overview";

export interface OverviewViewProps {
  readonly status?: HubProjectStatus;
  readonly loading?: boolean;
  readonly runtimeError?: string;
  readonly viewportWidth: number;
  readonly onPreviewAction?: (
    action: HubRuntimePreviewAction,
    params: Record<string, unknown>,
  ) => Promise<HubRuntimeActionPreview | undefined>;
  readonly onConfirmAction?: (
    preview: HubRuntimeActionPreview,
    params: Record<string, unknown>,
  ) => Promise<string | undefined>;
}

const bannerClassName = (severity: HubOverviewBannerSeverity): string => {
  switch (severity) {
    case "error":
      return "hub-banner is-error";
    case "warning":
      return "hub-banner is-warning";
    default:
      return "hub-banner";
  }
};

const syncToneClass = (tone: "warning" | "danger" | "neutral" | undefined): string => {
  switch (tone) {
    case "warning":
      return "hub-chip is-warning";
    case "danger":
      return "hub-chip is-error";
    default:
      return "hub-chip";
  }
};

const boolLabel = (value: boolean): string => (value ? "yes" : "no");

const OverviewActionButton = ({
  action,
  onPreviewAction,
  onConfirmAction,
}: {
  readonly action: HubOverviewAction;
  readonly onPreviewAction?: OverviewViewProps["onPreviewAction"];
  readonly onConfirmAction?: OverviewViewProps["onConfirmAction"];
}) => {
  const [preview, setPreview] = useState<HubRuntimeActionPreview | undefined>();
  const [previewParams, setPreviewParams] = useState<
    Record<string, unknown> | undefined
  >();
  const [pending, setPending] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | undefined>();

  const disabled = action.disabledReason !== undefined;

  const handlePreview = async () => {
    if (
      disabled ||
      action.kind !== "bridge_preview" ||
      !action.bridgeAction ||
      !onPreviewAction
    ) {
      return;
    }
    setPending(true);
    setResultMessage(undefined);
    try {
      const nextPreview = await onPreviewAction(
        action.bridgeAction,
        action.bridgeParams ?? {},
      );
      setPreviewParams(action.bridgeParams ?? {});
      setPreview(nextPreview);
    } finally {
      setPending(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview || !previewParams || !onConfirmAction || preview.disabledReason) {
      return;
    }
    setPending(true);
    try {
      const message = await onConfirmAction(preview, previewParams);
      setResultMessage(message ?? "Action queued for CLI execution.");
      setPreview(undefined);
      setPreviewParams(undefined);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="hub-overview-action">
      <div className="hub-overview-action-copy">
        <strong>{action.label}</strong>
        <p className="hub-muted">{action.description}</p>
        {action.disabledReason ? (
          <p className="hub-muted" role="status">
            {action.disabledReason}
          </p>
        ) : null}
        <p className="hub-muted">
          CLI fallback: <code>{action.cliFallback}</code>
        </p>
      </div>
      <div className="hub-overview-action-controls">
        {action.kind === "bridge_preview" ? (
          <button
            type="button"
            className="hub-button hub-focus-ring"
            disabled={disabled || pending || !onPreviewAction}
            onClick={() => void handlePreview()}
            aria-label={`Preview ${action.label}`}
          >
            {pending ? "Working…" : "Preview"}
          </button>
        ) : (
          <button
            type="button"
            className="hub-button hub-focus-ring"
            disabled
            aria-label={`${action.label} unavailable in desktop v0`}
          >
            CLI only
          </button>
        )}
      </div>
      {preview ? (
        <div className="hub-overview-preview" role="region" aria-label="Action preview">
          <p>{preview.summary}</p>
          {preview.disabledReason ? (
            <p className="hub-muted" role="status">
              {preview.disabledReason}
            </p>
          ) : (
            <button
              type="button"
              className="hub-button hub-focus-ring"
              disabled={pending || !onConfirmAction}
              onClick={() => void handleConfirm()}
            >
              Confirm
            </button>
          )}
        </div>
      ) : null}
      {resultMessage ? (
        <p className="hub-muted" role="status">
          {resultMessage}
        </p>
      ) : null}
    </div>
  );
};

export const OverviewView = ({
  status,
  loading = false,
  runtimeError,
  viewportWidth,
  onPreviewAction,
  onConfirmAction,
}: OverviewViewProps) => {
  const model = useMemo(
    () =>
      buildHubOverviewModel({
        loading,
        runtimeError,
        status,
      }),
    [loading, runtimeError, status],
  );

  if (model.phase === "loading") {
    return (
      <div
        className="hub-overview-grid hub-overview-grid-narrow"
        aria-busy="true"
        aria-label="Loading project overview"
      >
        <section className="hub-panel hub-overview-skeleton">
          <h2>Project health</h2>
          <p className="hub-muted">Loading local Hub data…</p>
        </section>
        <section className="hub-panel hub-overview-skeleton">
          <h2>Local task store</h2>
          <p className="hub-muted">Reading Beads task counts…</p>
        </section>
      </div>
    );
  }

  if (model.phase === "runtime_unavailable") {
    return (
      <div className="hub-panel hub-empty hub-error" role="alert">
        <h2>Runtime unavailable</h2>
        <p>{model.runtimeError}</p>
        <p className="hub-muted">
          CLI fallback: <code>archloop project status</code>
        </p>
      </div>
    );
  }

  const paths = model.projectPaths;
  const gridClass = resolveHubOverviewGridClass(viewportWidth);

  return (
    <div className={gridClass} aria-label="Hub project overview">
      {model.banners.map((banner) => (
        <section
          key={banner.id}
          className={`${bannerClassName(banner.severity)} hub-panel-wide`}
          role={banner.severity === "error" ? "alert" : "status"}
          aria-label={banner.title}
        >
          <h2>{banner.title}</h2>
          <p>{banner.message}</p>
          {banner.cliFallback ? (
            <p className="hub-muted">
              CLI fallback: <code>{banner.cliFallback}</code>
            </p>
          ) : null}
        </section>
      ))}

      <section className="hub-panel" aria-labelledby="hub-overview-paths-heading">
        <h2 id="hub-overview-paths-heading">Project paths</h2>
        <dl className="hub-kv">
          <div>
            <dt>Repo root</dt>
            <dd className="hub-mono" title={paths?.repoRoot}>
              {formatHubOverviewPath(paths?.repoRoot ?? "")}
            </dd>
          </div>
          <div>
            <dt>archLoop user data</dt>
            <dd className="hub-mono" title={paths?.archloopUserDataDir}>
              {formatHubOverviewPath(paths?.archloopUserDataDir ?? "")}
            </dd>
          </div>
          <div>
            <dt>Hub project directory</dt>
            <dd className="hub-mono" title={paths?.hubProjectDir}>
              {formatHubOverviewPath(paths?.hubProjectDir ?? "")}
            </dd>
          </div>
          <div>
            <dt>Registered</dt>
            <dd>{boolLabel(paths?.projectRegistered ?? false)}</dd>
          </div>
          <div>
            <dt>Beads available</dt>
            <dd>{boolLabel(paths?.beadsAvailable ?? false)}</dd>
          </div>
          <div>
            <dt>Task store initialized</dt>
            <dd>{boolLabel(paths?.taskStoreInitialized ?? false)}</dd>
          </div>
        </dl>
      </section>

      <section className="hub-panel" aria-labelledby="hub-overview-counts-heading">
        <h2 id="hub-overview-counts-heading">Task counts</h2>
        <dl className="hub-kv">
          <div>
            <dt>Ready</dt>
            <dd>{model.taskCounts?.ready ?? 0}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{model.taskCounts?.total ?? 0}</dd>
          </div>
        </dl>
        {model.statusCountEntries.length > 0 ? (
          <ul className="hub-overview-status-list" aria-label="Per-status counts">
            {model.statusCountEntries.map((entry) => (
              <li key={entry.status}>
                <span className="hub-mono">{entry.status}</span>
                <span className="hub-chip">{entry.count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hub-muted">No Hub tasks found.</p>
        )}
      </section>

      {model.syncSections.map((section) => (
        <section
          key={section.scope}
          className={`hub-panel hub-sync-panel is-${section.scope}`}
          aria-labelledby={`hub-overview-sync-${section.scope}`}
        >
          <h2 id={`hub-overview-sync-${section.scope}`}>{section.title}</h2>
          <p className="hub-muted">{section.description}</p>
          <dl className="hub-kv">
            {section.counts.map((count) => (
              <div key={count.label}>
                <dt>{count.label}</dt>
                <dd>
                  <span className={syncToneClass(count.tone)}>{count.value}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <section className="hub-panel" aria-labelledby="hub-overview-failed-heading">
        <h2 id="hub-overview-failed-heading">Failed tasks</h2>
        {model.failedTasks.length > 0 ? (
          <ul className="hub-list">
            {model.failedTasks.map((task) => (
              <li key={task.id}>
                <span className="hub-mono">{task.id}</span>:{" "}
                {task.failureReason ?? "unknown"} — {task.nextAction}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hub-muted">No failed tasks.</p>
        )}
      </section>

      <section className="hub-panel" aria-labelledby="hub-overview-batches-heading">
        <h2 id="hub-overview-batches-heading">Active batches</h2>
        {model.activeBatches.length > 0 ? (
          <ul className="hub-list">
            {model.activeBatches.map((batch) => (
              <li key={`${batch.runId}-${batch.batchId}`}>
                <span className="hub-mono">
                  {batch.runId}/{batch.batchId}
                </span>{" "}
                — {batch.status}
                {batch.flowId ? ` (${batch.flowId})` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hub-muted">No active Hub runs.</p>
        )}
      </section>

      <section className="hub-panel" aria-labelledby="hub-overview-runs-heading">
        <h2 id="hub-overview-runs-heading">Run directories</h2>
        {model.runDirectories.length > 0 ? (
          <ul className="hub-mono-list hub-list">
            {model.runDirectories.map((runDir) => (
              <li key={runDir} title={runDir}>
                {formatHubOverviewPath(runDir)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hub-muted">No Hub run directories yet.</p>
        )}
      </section>

      <section
        className="hub-panel hub-panel-wide"
        aria-labelledby="hub-overview-events-heading"
      >
        <h2 id="hub-overview-events-heading">Recent activity</h2>
        {model.recentEvents.length > 0 ? (
          <ul className="hub-list">
            {model.recentEvents.map((event) => (
              <li key={event}>{event}</li>
            ))}
          </ul>
        ) : (
          <p className="hub-muted">No recent Hub events yet.</p>
        )}
      </section>

      <section
        className="hub-panel hub-panel-wide"
        aria-labelledby="hub-overview-leases-heading"
      >
        <h2 id="hub-overview-leases-heading">Worktree lease diagnostics</h2>
        {model.worktreeLeaseDiagnostics.length > 0 ? (
          <ul className="hub-list">
            {model.worktreeLeaseDiagnostics.map((diagnostic) => (
              <li key={diagnostic.taskId}>
                <span className="hub-mono">{diagnostic.taskId}</span>:{" "}
                {diagnostic.reason} on {diagnostic.branch} — {diagnostic.message}
                <div className="hub-muted">Next: {diagnostic.nextAction}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hub-muted">No active or inconsistent worktree leases.</p>
        )}
      </section>

      <section
        className="hub-panel hub-panel-wide"
        aria-labelledby="hub-overview-actions-heading"
      >
        <h2 id="hub-overview-actions-heading">Local actions</h2>
        <div className="hub-overview-actions">
          {model.actions.map((action) => (
            <OverviewActionButton
              key={action.id}
              action={action}
              onPreviewAction={onPreviewAction}
              onConfirmAction={onConfirmAction}
            />
          ))}
        </div>
      </section>
    </div>
  );
};
