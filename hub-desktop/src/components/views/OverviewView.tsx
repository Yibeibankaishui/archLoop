import { useEffect, useMemo, useState } from "react";

import type {
  HubProjectStatus,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  buildHubOverviewModel,
  formatHubOverviewPath,
  resolveHubOverviewGridClass,
  resolveHubOverviewSyncNowAction,
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

type OverviewTimelineItemKind = "batch" | "event" | "failed_task" | "lease";

interface OverviewTimelineItem {
  readonly id: string;
  readonly kind: OverviewTimelineItemKind;
  readonly title: string;
  readonly summary: string;
  readonly badge: string;
  readonly tone: "ready" | "active" | "warning" | "error" | "neutral";
  readonly sourcePath?: string;
  readonly lockedBy?: string;
  readonly leaseId?: string;
  readonly statusLabel?: string;
  readonly nextAction?: string;
  readonly details: readonly [string, string][];
}

interface UseBridgePreviewActionInput {
  readonly action: HubOverviewAction;
  readonly onPreviewAction?: OverviewViewProps["onPreviewAction"];
  readonly onConfirmAction?: OverviewViewProps["onConfirmAction"];
  readonly defaultResultMessage?: string;
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

const syncToneClass = (
  tone: "warning" | "danger" | "neutral" | undefined,
): string => {
  switch (tone) {
    case "warning":
      return "hub-chip is-warning";
    case "danger":
      return "hub-chip is-error";
    default:
      return "hub-chip";
  }
};

const timelineToneClass = (tone: OverviewTimelineItem["tone"]): string => {
  switch (tone) {
    case "ready":
      return "hub-chip is-ready";
    case "active":
      return "hub-chip is-active";
    case "warning":
      return "hub-chip is-warning";
    case "error":
      return "hub-chip is-error";
    default:
      return "hub-chip";
  }
};

const leaseTimelineTone = (
  leaseState: HubProjectStatus["worktreeLeaseDiagnostics"][number]["leaseState"],
): OverviewTimelineItem["tone"] => {
  switch (leaseState) {
    case "active":
      return "active";
    case "stale":
      return "warning";
    default:
      return "neutral";
  }
};

const formatLeaseOwner = (
  diagnostic: HubProjectStatus["worktreeLeaseDiagnostics"][number],
): string => {
  if (!diagnostic.owner) {
    return "unknown owner";
  }

  if (diagnostic.owner.kind !== "hub" || !diagnostic.owner.taskId) {
    return "direct execution";
  }

  const ownerParts = [`task ${diagnostic.owner.taskId}`];
  if (diagnostic.owner.flowId) {
    ownerParts.push(`flow ${diagnostic.owner.flowId}`);
  }
  if (diagnostic.owner.batchId) {
    ownerParts.push(`batch ${diagnostic.owner.batchId}`);
  }

  return ownerParts.join(", ");
};

const inspectorStatusClassName = (
  item: OverviewTimelineItem | undefined,
): string => {
  if (item?.statusLabel === "DONE") {
    return "hub-chip is-ready";
  }

  switch (item?.tone) {
    case "error":
      return "hub-chip is-error";
    case "warning":
      return "hub-chip is-warning";
    default:
      return "hub-chip is-active";
  }
};

const boolLabel = (value: boolean): string => (value ? "yes" : "no");

const buildOverviewTimelineItems = (
  status: HubProjectStatus | undefined,
): readonly OverviewTimelineItem[] => {
  if (!status) {
    return [];
  }

  const items: OverviewTimelineItem[] = [];

  for (const batch of status.activeBatches) {
    items.push({
      id: `batch-${batch.runId}-${batch.batchId}`,
      kind: "batch",
      title: `${batch.runId} / ${batch.batchId}`,
      summary: `Flow batch ${batch.status} with ${batch.taskCount ?? 0} task(s) on ${batch.flowId ?? "unknown flow"}.`,
      badge: "Flow batch",
      tone: batch.active ? "active" : "neutral",
      sourcePath: batch.runDir,
      statusLabel: batch.status.replaceAll("_", " "),
      details: [
        ["Run ID", batch.runId],
        ["Batch ID", batch.batchId],
        ["Branch", batch.flowId ?? "—"],
        ["Run dir", batch.runDir],
      ],
    });
  }

  for (const task of status.failedTasks) {
    items.push({
      id: `failed-${task.id}`,
      kind: "failed_task",
      title: `${task.id} · ${task.title}`,
      summary: task.failureReason
        ? `${task.failureReason} detected. ${task.nextAction}`
        : task.nextAction,
      badge: "Failed task",
      tone: "error",
      sourcePath: status.hubProjectDir,
      leaseId: `lease-${task.id}`,
      statusLabel: "DONE",
      nextAction: task.nextAction,
      details: [
        ["Task ID", task.id],
        ["Title", task.title],
        ["Failure reason", task.failureReason ?? "unknown"],
        ["Next action", task.nextAction],
      ],
    });
  }

  for (const diagnostic of status.worktreeLeaseDiagnostics) {
    items.push({
      id: `lease-${diagnostic.taskId}`,
      kind: "lease",
      title: `${diagnostic.taskId} · ${diagnostic.reason.replaceAll("_", " ")}`,
      summary: diagnostic.message,
      badge: "Lease",
      tone: leaseTimelineTone(diagnostic.leaseState),
      sourcePath: diagnostic.branch,
      lockedBy: formatLeaseOwner(diagnostic),
      leaseId: diagnostic.worktreeName,
      statusLabel: diagnostic.leaseState === "active" ? "ACTIVE" : "DONE",
      nextAction: diagnostic.nextAction,
      details: [
        ["Lease ID", diagnostic.worktreeName],
        ["Branch", diagnostic.branch],
        ["Lease state", diagnostic.leaseState],
        ["Claim state", diagnostic.claimState],
        ["Next action", diagnostic.nextAction],
      ],
    });
  }

  for (const [index, event] of status.recentEvents.entries()) {
    items.push({
      id: `event-${index}`,
      kind: "event",
      title: `Event ${index + 1}`,
      summary: event,
      badge: "Activity",
      tone: index === 0 ? "neutral" : "warning",
      sourcePath: status.repoRoot,
      details: [["Event", event]],
    });
  }

  return items;
};

const resolveDefaultTimelineItemId = (
  items: readonly OverviewTimelineItem[],
): string | undefined =>
  items.find((item) => item.kind === "lease")?.id ??
  items.find((item) => item.kind === "failed_task")?.id ??
  items.find((item) => item.kind === "batch")?.id ??
  items[0]?.id;

const useBridgePreviewAction = ({
  action,
  onPreviewAction,
  onConfirmAction,
  defaultResultMessage,
}: UseBridgePreviewActionInput) => {
  const [preview, setPreview] = useState<HubRuntimeActionPreview | undefined>();
  const [previewParams, setPreviewParams] = useState<
    Record<string, unknown> | undefined
  >();
  const [pending, setPending] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | undefined>();

  const disabled = action.disabledReason !== undefined;
  const canPreview =
    !disabled &&
    action.kind === "bridge_preview" &&
    action.bridgeAction !== undefined &&
    onPreviewAction !== undefined;

  const handlePreview = async () => {
    if (!canPreview || !onPreviewAction || !action.bridgeAction) {
      return;
    }

    setPending(true);
    setResultMessage(undefined);

    try {
      const params = action.bridgeParams ?? {};
      const nextPreview = await onPreviewAction(action.bridgeAction, params);
      setPreviewParams(params);
      setPreview(nextPreview);
    } finally {
      setPending(false);
    }
  };

  const handleConfirm = async () => {
    if (
      !preview ||
      !previewParams ||
      !onConfirmAction ||
      preview.disabledReason
    ) {
      return;
    }

    setPending(true);

    try {
      const message = await onConfirmAction(preview, previewParams);
      if (defaultResultMessage) {
        setResultMessage(message ?? defaultResultMessage);
      }
      setPreview(undefined);
      setPreviewParams(undefined);
    } finally {
      setPending(false);
    }
  };

  return {
    preview,
    pending,
    disabled,
    canPreview,
    resultMessage,
    handlePreview,
    handleConfirm,
  };
};

const OverviewActionButton = ({
  action,
  onPreviewAction,
  onConfirmAction,
}: {
  readonly action: HubOverviewAction;
  readonly onPreviewAction?: OverviewViewProps["onPreviewAction"];
  readonly onConfirmAction?: OverviewViewProps["onConfirmAction"];
}) => {
  const {
    preview,
    pending,
    disabled,
    resultMessage,
    handlePreview,
    handleConfirm,
  } = useBridgePreviewAction({
    action,
    onPreviewAction,
    onConfirmAction,
    defaultResultMessage: "Action queued for CLI execution.",
  });

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
        <div
          className="hub-overview-preview"
          role="region"
          aria-label="Action preview"
        >
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

const CompactActionButton = ({
  action,
  onPreviewAction,
  onConfirmAction,
}: {
  readonly action: HubOverviewAction;
  readonly onPreviewAction?: OverviewViewProps["onPreviewAction"];
  readonly onConfirmAction?: OverviewViewProps["onConfirmAction"];
}) => {
  const { preview, pending, disabled, handlePreview, handleConfirm } =
    useBridgePreviewAction({
      action,
      onPreviewAction,
      onConfirmAction,
    });

  return (
    <div className="hub-overview-sync-action">
      <button
        type="button"
        className="hub-button hub-focus-ring"
        disabled={disabled || pending || !onPreviewAction}
        onClick={() => void handlePreview()}
      >
        {pending ? `${action.label}…` : action.label}
      </button>
      {preview ? (
        <div
          className="hub-overview-sync-preview"
          role="region"
          aria-label="Sync preview"
        >
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
    </div>
  );
};

const OverviewMetricCard = ({
  label,
  value,
  tone = "neutral",
}: {
  readonly label: string;
  readonly value: string | number;
  readonly tone?: "ready" | "active" | "warning" | "error" | "neutral";
}) => (
  <article className="hub-overview-metric">
    <p className="hub-muted">{label}</p>
    <span className={timelineToneClass(tone)}>{value}</span>
  </article>
);

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

  const syncBannerAction = useMemo(
    () => resolveHubOverviewSyncNowAction(status),
    [status],
  );

  const timelineItems = useMemo(
    () => buildOverviewTimelineItems(status),
    [status],
  );

  const [selectedTimelineItemId, setSelectedTimelineItemId] = useState<
    string | undefined
  >(() => resolveDefaultTimelineItemId(timelineItems));

  useEffect(() => {
    const defaultId = resolveDefaultTimelineItemId(timelineItems);
    if (
      !selectedTimelineItemId ||
      !timelineItems.some((item) => item.id === selectedTimelineItemId)
    ) {
      setSelectedTimelineItemId(defaultId);
    }
  }, [selectedTimelineItemId, timelineItems]);

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
          <h2>Activity timeline</h2>
          <p className="hub-muted">Reading local Hub events…</p>
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
  const selectedTimelineItem =
    timelineItems.find((item) => item.id === selectedTimelineItemId) ??
    timelineItems[0];

  return (
    <div className="hub-overview-shell" aria-label="Hub project overview">
      <section className="hub-panel hub-banner hub-overview-sync-banner hub-overview-span">
        <div className="hub-overview-sync-copy">
          <p className="hub-eyebrow">Project Overview</p>
          <h2>SYNC NOW</h2>
          <p className="hub-muted">
            Remote sync is preview-confirm gated. Local task metadata stays
            separate from remote task source changes.
          </p>
        </div>
        <div className="hub-overview-sync-controls">
          {syncBannerAction ? (
            <CompactActionButton
              action={syncBannerAction}
              onPreviewAction={onPreviewAction}
              onConfirmAction={onConfirmAction}
            />
          ) : null}
          <div className="hub-overview-sync-summary">
            <span className="hub-chip is-active">
              {model.statusCountEntries.length} status bucket(s)
            </span>
            <span className="hub-chip is-ready">
              {model.taskCounts?.ready ?? 0} ready
            </span>
          </div>
        </div>
      </section>

      <div className={gridClass}>
        <aside className="hub-panel hub-overview-column hub-overview-left">
          <section className="hub-overview-stack">
            <div className="hub-overview-heading-row">
              <div>
                <p className="hub-eyebrow">Project health</p>
                <h2>Hub project</h2>
              </div>
              <span
                className={`hub-chip ${paths?.projectRegistered ? "is-ready" : "is-warning"}`}
              >
                {paths?.projectRegistered ? "registered" : "not registered"}
              </span>
            </div>

            <dl className="hub-kv hub-overview-kv">
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
                <dt>Hub project dir</dt>
                <dd className="hub-mono" title={paths?.hubProjectDir}>
                  {formatHubOverviewPath(paths?.hubProjectDir ?? "")}
                </dd>
              </div>
              <div>
                <dt>Beads</dt>
                <dd>
                  <span
                    className={`hub-chip ${paths?.beadsAvailable ? "is-ready" : "is-warning"}`}
                  >
                    {paths?.beadsAvailable ? "available" : "unavailable"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Task store</dt>
                <dd>
                  <span
                    className={`hub-chip ${paths?.taskStoreInitialized ? "is-ready" : "is-warning"}`}
                  >
                    {paths?.taskStoreInitialized ? "initialized" : "missing"}
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <section className="hub-overview-stack">
            <div className="hub-overview-heading-row">
              <div>
                <p className="hub-eyebrow">Metrics</p>
                <h2>System status</h2>
              </div>
            </div>
            <div className="hub-overview-metrics">
              <OverviewMetricCard
                label="Ready"
                value={model.taskCounts?.ready ?? 0}
                tone="ready"
              />
              <OverviewMetricCard
                label="Total"
                value={model.taskCounts?.total ?? 0}
                tone="neutral"
              />
              <OverviewMetricCard
                label="Active batches"
                value={model.activeBatches.length}
                tone="active"
              />
              <OverviewMetricCard
                label="Failed tasks"
                value={model.failedTasks.length}
                tone={model.failedTasks.length > 0 ? "error" : "neutral"}
              />
            </div>
          </section>

          <section className="hub-overview-stack">
            <div className="hub-overview-heading-row">
              <div>
                <p className="hub-eyebrow">Warnings</p>
                <h2>Status banners</h2>
              </div>
            </div>
            {model.banners.length > 0 ? (
              <div className="hub-overview-warning-stack">
                {model.banners.map((banner) => (
                  <section
                    key={banner.id}
                    className={bannerClassName(banner.severity)}
                    role={banner.severity === "error" ? "alert" : "status"}
                    aria-label={banner.title}
                  >
                    <h3>{banner.title}</h3>
                    <p>{banner.message}</p>
                    {banner.cliFallback ? (
                      <p className="hub-muted">
                        CLI fallback: <code>{banner.cliFallback}</code>
                      </p>
                    ) : null}
                  </section>
                ))}
              </div>
            ) : (
              <p className="hub-muted">No sync or recovery warnings.</p>
            )}
          </section>

          <section className="hub-overview-stack">
            <div className="hub-overview-heading-row">
              <div>
                <p className="hub-eyebrow">Actions</p>
                <h2>Hub actions</h2>
              </div>
            </div>
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
            <div className="hub-overview-note">
              <p className="hub-muted">
                Sync and recovery stay preview-confirm gated. CLI-only actions
                keep their fallback visible.
              </p>
            </div>
          </section>

          <section className="hub-overview-stack">
            <div className="hub-overview-heading-row">
              <div>
                <p className="hub-eyebrow">Sync state</p>
                <h2>Remote metadata</h2>
              </div>
            </div>
            {model.syncSections.map((section) => (
              <section
                key={section.scope}
                className={`hub-sync-panel is-${section.scope}`}
                aria-labelledby={`hub-overview-sync-${section.scope}`}
              >
                <h3 id={`hub-overview-sync-${section.scope}`}>
                  {section.title}
                </h3>
                <p className="hub-muted">{section.description}</p>
                <dl className="hub-kv">
                  {section.counts.map((count) => (
                    <div key={count.label}>
                      <dt>{count.label}</dt>
                      <dd>
                        <span className={syncToneClass(count.tone)}>
                          {count.value}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </section>
        </aside>

        <section className="hub-panel hub-overview-column hub-overview-center">
          <div className="hub-overview-heading-row">
            <div>
              <p className="hub-eyebrow">Activity</p>
              <h2>Activity timeline</h2>
            </div>
            <span className="hub-chip is-active">
              {timelineItems.length} item(s)
            </span>
          </div>

          {timelineItems.length > 0 ? (
            <ol className="hub-overview-timeline">
              {timelineItems.map((item) => {
                const selected = item.id === selectedTimelineItem?.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`hub-overview-timeline-item hub-focus-ring ${selected ? "is-selected" : ""}`}
                      aria-pressed={selected}
                      onClick={() => setSelectedTimelineItemId(item.id)}
                    >
                      <span
                        className="hub-overview-timeline-rail"
                        aria-hidden="true"
                      >
                        <span
                          className={`hub-overview-timeline-dot ${selected ? "is-selected" : ""}`}
                        />
                      </span>
                      <div className="hub-overview-timeline-card">
                        <div className="hub-overview-timeline-header">
                          <div className="hub-overview-timeline-title">
                            <span className="hub-eyebrow">{item.badge}</span>
                            <strong>{item.title}</strong>
                          </div>
                          <span className={timelineToneClass(item.tone)}>
                            {item.statusLabel ?? item.badge}
                          </span>
                        </div>
                        <p className="hub-muted">{item.summary}</p>
                        {item.sourcePath ? (
                          <p
                            className="hub-mono hub-muted"
                            title={item.sourcePath}
                          >
                            {formatHubOverviewPath(item.sourcePath)}
                          </p>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="hub-panel hub-empty">
              <h3>No recent activity</h3>
              <p className="hub-muted">
                The timeline is empty until Hub records events.
              </p>
            </div>
          )}
        </section>

        <aside className="hub-panel hub-overview-column hub-overview-right">
          <div className="hub-overview-heading-row">
            <div>
              <p className="hub-eyebrow">Inspector</p>
              <h2>Lease inspector</h2>
            </div>
            <span className={inspectorStatusClassName(selectedTimelineItem)}>
              {selectedTimelineItem?.statusLabel ?? "DONE"}
            </span>
          </div>

          {selectedTimelineItem ? (
            <div className="hub-overview-inspector">
              <section className="hub-overview-inspector-card">
                <h3>{selectedTimelineItem.title}</h3>
                <p className="hub-muted">{selectedTimelineItem.summary}</p>
              </section>

              <dl className="hub-kv hub-overview-kv">
                {selectedTimelineItem.details.map(([key, value]) => (
                  <div key={`${selectedTimelineItem.id}-${key}`}>
                    <dt>{key}</dt>
                    <dd className="hub-mono">{value}</dd>
                  </div>
                ))}
                <div>
                  <dt>Lease ID</dt>
                  <dd className="hub-mono">
                    {selectedTimelineItem.leaseId ??
                      selectedTimelineItem.sourcePath ??
                      selectedTimelineItem.id}
                  </dd>
                </div>
                <div>
                  <dt>Source path</dt>
                  <dd className="hub-mono">
                    {selectedTimelineItem.sourcePath
                      ? formatHubOverviewPath(selectedTimelineItem.sourcePath)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Locked by</dt>
                  <dd className="hub-mono">
                    {selectedTimelineItem.lockedBy ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt>Next action</dt>
                  <dd>
                    {selectedTimelineItem.nextAction ??
                      "Inspect the selected activity."}
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className="hub-panel hub-empty">
              <h3>Lease inspector</h3>
              <p className="hub-muted">
                Select a timeline item to inspect the current lease or activity.
              </p>
            </div>
          )}
        </aside>
      </div>

      <footer className="hub-panel hub-overview-footer hub-overview-span">
        <div className="hub-overview-footer-copy">
          <p className="hub-eyebrow">Diagnostics</p>
          <h2>Operational summary</h2>
          <p className="hub-muted">
            {boolLabel(paths?.beadsAvailable ?? false)} Beads,{" "}
            {boolLabel(paths?.taskStoreInitialized ?? false)} task store,{" "}
            {model.activeBatches.length} active batch(es),{" "}
            {model.failedTasks.length} failed task(s).
          </p>
        </div>
        <div className="hub-overview-footer-actions">
          <button
            type="button"
            className="hub-button hub-focus-ring"
            disabled
            title="Generate a report from the CLI path in v0."
          >
            Generate Report
          </button>
          <button
            type="button"
            className="hub-button hub-focus-ring"
            disabled
            title="Open repo information from the CLI path in v0."
          >
            View Repo Info
          </button>
          <span className="hub-chip is-active">Uptime: live</span>
        </div>
      </footer>
    </div>
  );
};
