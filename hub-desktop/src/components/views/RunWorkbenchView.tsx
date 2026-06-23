import { useMemo, useState } from "react";

import type {
  HubProjectRunSummary,
  HubProjectStatus,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  buildHubRunWorkbenchModel,
  formatHubOverviewPath,
  resolveHubRunWorkbenchGridClass,
  selectDefaultRunFocus,
  type HubRunEventsSnapshot,
  type HubRunWorkbenchAction,
  type HubRunWorkbenchStageState,
  type HubRunWorkbenchTerminalPhase,
} from "@yibeibankaishui/archloop/hub-run-workbench";

export interface RunWorkbenchViewProps {
  readonly status?: HubProjectStatus;
  readonly runSummaries?: readonly HubProjectRunSummary[];
  readonly eventsSnapshot?: HubRunEventsSnapshot;
  readonly loading?: boolean;
  readonly runtimeError?: string;
  readonly viewportWidth: number;
  readonly selectedRunId?: string;
  readonly selectedBatchId?: string;
  readonly onSelectRun?: (runId: string, batchId: string) => void;
  readonly onPreviewAction?: (
    action: HubRuntimePreviewAction,
    params: Record<string, unknown>,
  ) => Promise<HubRuntimeActionPreview | undefined>;
  readonly onConfirmAction?: (
    preview: HubRuntimeActionPreview,
    params: Record<string, unknown>,
  ) => Promise<string | undefined>;
}

const stageStateClass = (state: HubRunWorkbenchStageState): string => {
  switch (state) {
    case "active":
      return "hub-run-stage is-active";
    case "complete":
      return "hub-run-stage is-complete";
    case "failed":
      return "hub-run-stage is-failed";
    case "skipped":
      return "hub-run-stage is-skipped";
    default:
      return "hub-run-stage";
  }
};

const terminalPhaseLabel = (phase: HubRunWorkbenchTerminalPhase): string => {
  switch (phase) {
    case "no_events":
      return "No events yet";
    case "running":
      return "Running";
    case "passed":
      return "Verification passed";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
  }
};

const RunWorkbenchActionButton = ({
  action,
  onPreviewAction,
  onConfirmAction,
}: {
  readonly action: HubRunWorkbenchAction;
  readonly onPreviewAction?: RunWorkbenchViewProps["onPreviewAction"];
  readonly onConfirmAction?: RunWorkbenchViewProps["onConfirmAction"];
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
    <div className="hub-run-action">
      <div className="hub-run-action-copy">
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
      <div className="hub-run-action-controls">
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
        <div className="hub-run-preview" role="region" aria-label="Action preview">
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

export const RunWorkbenchView = ({
  status,
  runSummaries,
  eventsSnapshot,
  loading = false,
  runtimeError,
  viewportWidth,
  selectedRunId,
  selectedBatchId,
  onSelectRun,
  onPreviewAction,
  onConfirmAction,
}: RunWorkbenchViewProps) => {
  const defaultFocus = useMemo(
    () => selectDefaultRunFocus(runSummaries ?? [], status),
    [runSummaries, status],
  );

  const model = useMemo(
    () =>
      buildHubRunWorkbenchModel({
        loading,
        runtimeError,
        runSummaries,
        eventsSnapshot,
        projectStatus: status,
        selectedRunId: selectedRunId ?? defaultFocus.runId,
        selectedBatchId: selectedBatchId ?? defaultFocus.batchId,
      }),
    [
      loading,
      runtimeError,
      runSummaries,
      eventsSnapshot,
      status,
      selectedRunId,
      selectedBatchId,
      defaultFocus.runId,
      defaultFocus.batchId,
    ],
  );

  if (model.phase === "loading") {
    return (
      <div
        className="hub-run-grid hub-run-grid-narrow"
        aria-busy="true"
        aria-label="Loading run workbench"
      >
        <section className="hub-panel hub-run-skeleton">
          <h2>Run metadata</h2>
          <p className="hub-muted">Loading Hub run summaries…</p>
        </section>
        <section className="hub-panel hub-run-skeleton">
          <h2>Stage timeline</h2>
          <p className="hub-muted">Reading run events…</p>
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
          CLI fallback: <code>{model.cliFallback}</code>
        </p>
      </div>
    );
  }

  if (model.phase === "empty") {
    return (
      <div className="hub-panel hub-empty" role="status">
        <h2>No Hub runs yet</h2>
        <p className="hub-muted">
          Start a flow from the CLI to populate the run workbench.
        </p>
        <p className="hub-muted">
          CLI fallback: <code>{model.cliFallback}</code>
        </p>
      </div>
    );
  }

  const metadata = model.metadata;
  const gridClass = resolveHubRunWorkbenchGridClass(viewportWidth);

  return (
    <div className={gridClass} aria-label="Hub run workbench">
      <section className="hub-panel hub-panel-wide" aria-labelledby="hub-run-select-heading">
        <h2 id="hub-run-select-heading">Active and recent runs</h2>
        {model.runOptions.length > 0 ? (
          <div className="hub-run-selector">
            <label className="hub-run-selector-label" htmlFor="hub-run-select">
              Run / batch
            </label>
            <select
              id="hub-run-select"
              className="hub-run-select hub-focus-ring"
              value={`${model.selectedRunId}:${model.selectedBatchId}`}
              onChange={(event) => {
                const [runId, batchId] = event.target.value.split(":");
                if (runId && batchId) {
                  onSelectRun?.(runId, batchId);
                }
              }}
            >
              {model.runOptions.map((option) => (
                <option
                  key={`${option.runId}:${option.batchId}`}
                  value={`${option.runId}:${option.batchId}`}
                >
                  {option.label}
                  {option.active ? " (active)" : ""}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="hub-muted">No run options available.</p>
        )}
      </section>

      {model.gates.map((gate) => (
        <section
          key={gate.kind}
          className="hub-banner is-error hub-panel-wide"
          role="alert"
          aria-label={gate.title}
        >
          <h2>{gate.title}</h2>
          <p>{gate.message}</p>
          <p className="hub-muted">Next step: {gate.nextStep}</p>
          <p className="hub-muted">
            CLI fallback: <code>{gate.cliFallback}</code>
          </p>
        </section>
      ))}

      <section className="hub-panel" aria-labelledby="hub-run-metadata-heading">
        <h2 id="hub-run-metadata-heading">Run metadata</h2>
        {metadata ? (
          <dl className="hub-kv">
            <div>
              <dt>Run id</dt>
              <dd className="hub-mono">{metadata.runId}</dd>
            </div>
            <div>
              <dt>Batch id</dt>
              <dd className="hub-mono">{metadata.batchId}</dd>
            </div>
            <div>
              <dt>Flow id</dt>
              <dd className="hub-mono">{metadata.flowId ?? "—"}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd className="hub-mono">{metadata.branch ?? "—"}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd className="hub-mono">{metadata.startedAt ?? "—"}</dd>
            </div>
            <div>
              <dt>Batch status</dt>
              <dd>
                <span className="hub-chip is-active">{metadata.batchStatus}</span>
              </dd>
            </div>
            <div>
              <dt>Run directory</dt>
              <dd className="hub-mono" title={metadata.runDir}>
                {formatHubOverviewPath(metadata.runDir)}
              </dd>
            </div>
            <div>
              <dt>Batch strategy</dt>
              <dd className="hub-mono">{metadata.batchStrategy ?? "—"}</dd>
            </div>
            <div>
              <dt>Rationale</dt>
              <dd>{metadata.rationale ?? "—"}</dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="hub-panel" aria-labelledby="hub-run-tasks-heading">
        <h2 id="hub-run-tasks-heading">Selected tasks</h2>
        {metadata && metadata.selectedTaskIds.length > 0 ? (
          <ul className="hub-mono-list hub-list">
            {metadata.selectedTaskIds.map((taskId) => (
              <li key={taskId}>{taskId}</li>
            ))}
          </ul>
        ) : (
          <p className="hub-muted">No selected tasks recorded.</p>
        )}
        {metadata && metadata.deferredTasks.length > 0 ? (
          <>
            <h3 className="hub-run-subheading">Deferred tasks</h3>
            <ul className="hub-list">
              {metadata.deferredTasks.map((task) => (
                <li key={task.taskId}>
                  <span className="hub-mono">{task.taskId}</span> — {task.reason}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="hub-panel" aria-labelledby="hub-run-leases-heading">
        <h2 id="hub-run-leases-heading">Worktree leases</h2>
        {metadata && metadata.worktreeLeases.length > 0 ? (
          <ul className="hub-list">
            {metadata.worktreeLeases.map((lease) => (
              <li key={lease.taskId}>
                <span className="hub-mono">{lease.taskId}</span> on{" "}
                <span className="hub-mono">{lease.branch}</span>
                {lease.claimState ? ` — claim ${lease.claimState}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hub-muted">No worktree lease diagnostics for this run.</p>
        )}
      </section>

      <section
        className="hub-panel hub-panel-wide"
        aria-labelledby="hub-run-timeline-heading"
      >
        <h2 id="hub-run-timeline-heading">Stage timeline</h2>
        <ol className="hub-run-timeline" aria-label="Hub run stages">
          {model.stages.map((stage) => (
            <li key={stage.id} className={stageStateClass(stage.state)}>
              <span className="hub-run-stage-label">{stage.label}</span>
              <span className="hub-chip">{stage.state}</span>
              {stage.detail ? (
                <span className="hub-muted hub-run-stage-detail">{stage.detail}</span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <section
        className={`hub-panel hub-terminal hub-panel-wide hub-run-terminal is-${model.terminalPhase}`}
        aria-labelledby="hub-run-terminal-heading"
      >
        <div className="hub-run-terminal-header">
          <h2 id="hub-run-terminal-heading">Event output</h2>
          <span className="hub-status" role="status">
            {terminalPhaseLabel(model.terminalPhase)}
          </span>
        </div>
        <pre className="hub-terminal-body" aria-live="polite">
          {model.terminalLines.length > 0
            ? model.terminalLines.join("\n")
            : "No run events loaded for this batch yet."}
        </pre>
      </section>

      <section
        className="hub-panel hub-panel-wide"
        aria-labelledby="hub-run-actions-heading"
      >
        <h2 id="hub-run-actions-heading">Run actions</h2>
        <div className="hub-run-actions">
          {model.actions.map((action) => (
            <RunWorkbenchActionButton
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
