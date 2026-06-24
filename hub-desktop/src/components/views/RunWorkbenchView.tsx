import { useMemo, useState } from "react";

import type {
  HubProjectRunSummary,
  HubProjectStatus,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  buildHubRunWorkbenchModel,
  resolveHubRunWorkbenchGridClass,
  selectDefaultRunFocus,
  type HubRunEventsSnapshot,
  type HubRunWorkbenchAction,
  type HubRunWorkbenchStageState,
  type HubRunWorkbenchTerminalPhase,
} from "@yibeibankaishui/archloop/hub-run-workbench";
import { formatHubOverviewPath } from "@yibeibankaishui/archloop/hub-project-overview";

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

type HubBatchStatus = HubProjectRunSummary["batches"][number]["status"];
type RunOutputTab = "terminal" | "jsonl";

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

const batchStatusLabel = (
  status: HubBatchStatus | undefined,
): string => {
  switch (status) {
    case "done":
      return "Completed";
    case "partial_failed":
      return "Partial failed";
    case "planned":
      return "Planned";
    case "started":
    case "merging":
      return "Running";
    default:
      return "Unknown";
  }
};

const batchStatusChipClass = (
  status: HubBatchStatus | undefined,
): string => {
  switch (status) {
    case "done":
      return "hub-chip is-ready";
    case "partial_failed":
      return "hub-chip is-error";
    case "planned":
      return "hub-chip is-warning";
    case "started":
    case "merging":
      return "hub-chip is-active";
    default:
      return "hub-chip";
  }
};

const actionPriorityClass = (
  priority: HubRunWorkbenchAction["priority"],
): string => {
  switch (priority) {
    case "primary":
      return "is-primary";
    case "secondary":
      return "is-secondary";
    case "danger":
      return "is-danger";
  }
};

const formatRunJsonlLine = (
  record: HubRunEventsSnapshot["events"][number],
): string => {
  const payload =
    typeof record.event === "string"
      ? record.event
      : JSON.stringify(record.event);
  return `${record.file}:${record.lineNumber} ${payload}`;
};

const runStateLabel = (
  terminalPhase: HubRunWorkbenchTerminalPhase,
  batchStatus: HubBatchStatus | undefined,
): string => {
  if (terminalPhase === "passed" || batchStatus === "done") {
    return "Completed";
  }
  if (terminalPhase === "failed") {
    return "Failed";
  }
  return "Running";
};

const runStateChipClass = (label: string): string => {
  switch (label) {
    case "Completed":
      return "hub-chip is-ready";
    case "Failed":
      return "hub-chip is-error";
    default:
      return "hub-chip is-warning";
  }
};

const outputEmptyStateLabel = (outputTab: RunOutputTab): string =>
  outputTab === "jsonl"
    ? "No JSONL events loaded for this batch yet."
    : "No run events loaded for this batch yet.";

const SelectedTaskChipCloud = ({
  taskIds,
}: {
  readonly taskIds: readonly string[];
}) => (
  <div className="hub-run-chip-cloud" aria-label="Selected tasks">
    {taskIds.length > 0 ? (
      taskIds.map((taskId) => (
        <span key={taskId} className="hub-chip">
          {taskId}
        </span>
      ))
    ) : (
      <span className="hub-muted">No selected tasks recorded.</span>
    )}
  </div>
);

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
      setResultMessage(message ?? "Action queued for CLI execution.");
      setPreview(undefined);
      setPreviewParams(undefined);
    } finally {
      setPending(false);
    }
  };

  return (
    <article
      className={`hub-run-action ${actionPriorityClass(action.priority)}`}
    >
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
          <>
            <button
              type="button"
              className="hub-button hub-focus-ring"
              disabled={disabled || pending || !onPreviewAction}
              onClick={() => void handlePreview()}
              aria-label={`Preview ${action.label}`}
            >
              {pending ? "Working…" : "Preview"}
            </button>
            <button
              type="button"
              className="hub-button hub-focus-ring"
              disabled={!preview || pending || Boolean(preview.disabledReason)}
              onClick={() => void handleConfirm()}
              aria-label={`Confirm ${action.label}`}
            >
              Confirm
            </button>
          </>
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
          className="hub-run-preview"
          role="region"
          aria-label="Action preview"
        >
          <p>{preview.summary}</p>
          {preview.disabledReason ? (
            <p className="hub-muted" role="status">
              {preview.disabledReason}
            </p>
          ) : null}
        </div>
      ) : null}
      {resultMessage ? (
        <p className="hub-muted" role="status">
          {resultMessage}
        </p>
      ) : null}
    </article>
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
  const [outputTab, setOutputTab] = useState<RunOutputTab>("terminal");
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

  const jsonlLines = useMemo(
    () => eventsSnapshot?.events.map(formatRunJsonlLine) ?? [],
    [eventsSnapshot],
  );
  const outputLines = outputTab === "jsonl" ? jsonlLines : model.terminalLines;

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
  const selectedRunValue = `${model.selectedRunId}:${model.selectedBatchId}`;
  const commandFallback = `archloop run . --flow ${metadata?.flowId ?? "<id>"}`;
  const currentRunStateLabel = runStateLabel(
    model.terminalPhase,
    metadata?.batchStatus,
  );

  return (
    <div className={gridClass} aria-label="Hub run workbench">
      <section className="hub-panel hub-panel-wide hub-run-hero">
        <div className="hub-run-hero-top">
          <div className="hub-run-hero-copy">
            <p className="hub-eyebrow">Run workbench</p>
            <h2 className="hub-run-hero-title">
              {metadata?.runId ?? "Run"} / {metadata?.batchId ?? "Batch"}
            </h2>
            <p className="hub-muted">
              Monitor the live batch, terminal output, and recovery actions.
            </p>
          </div>
          <div className="hub-run-hero-controls">
            {model.runOptions.length > 0 ? (
              <div className="hub-run-selector">
                <label
                  className="hub-run-selector-label"
                  htmlFor="hub-run-select"
                >
                  Run / batch
                </label>
                <select
                  id="hub-run-select"
                  className="hub-run-select hub-focus-ring"
                  value={selectedRunValue}
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
          </div>
        </div>
        <div className="hub-run-hero-chips">
          <span className="hub-chip is-active">
            Run ID <span className="hub-mono">{metadata?.runId ?? "—"}</span>
          </span>
          <span className="hub-chip">
            Flow ID <span className="hub-mono">{metadata?.flowId ?? "—"}</span>
          </span>
          <span className="hub-chip">
            Branch <span className="hub-mono">{metadata?.branch ?? "—"}</span>
          </span>
          <span className={batchStatusChipClass(metadata?.batchStatus)}>
            {batchStatusLabel(metadata?.batchStatus)}
          </span>
          <span className={runStateChipClass(currentRunStateLabel)}>
            {currentRunStateLabel}
          </span>
        </div>
        <div className="hub-run-hero-command">
          <span className="hub-muted">Command</span>
          <code>{commandFallback}</code>
        </div>
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

      <section className="hub-panel hub-panel-wide hub-run-workbench-body">
        <div className="hub-run-primary">
          <section
            className="hub-panel hub-run-selected-batch"
            aria-labelledby="hub-run-selected-batch-heading"
          >
            <div className="hub-run-section-header">
              <div>
                <p className="hub-eyebrow">Selected batch</p>
                <h2 id="hub-run-selected-batch-heading">
                  Batch timeline focus
                </h2>
              </div>
              <span className={batchStatusChipClass(metadata?.batchStatus)}>
                {batchStatusLabel(metadata?.batchStatus)}
              </span>
            </div>
            <p className="hub-muted">
              {metadata?.rationale ?? "No batch rationale recorded."}
            </p>
            <SelectedTaskChipCloud taskIds={metadata?.selectedTaskIds ?? []} />
            {metadata && metadata.deferredTasks.length > 0 ? (
              <div className="hub-run-callout">
                <p className="hub-muted">Deferred tasks</p>
                <ul className="hub-list">
                  {metadata.deferredTasks.map((task) => (
                    <li key={task.taskId}>
                      <span className="hub-mono">{task.taskId}</span> —{" "}
                      {task.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <section
            className="hub-panel"
            aria-labelledby="hub-run-timeline-heading"
          >
            <div className="hub-run-section-header">
              <div>
                <p className="hub-eyebrow">Timeline</p>
                <h2 id="hub-run-timeline-heading">Stage timeline</h2>
              </div>
              <span className="hub-muted">{model.stages.length} stages</span>
            </div>
            <ol className="hub-run-timeline" aria-label="Hub run stages">
              {model.stages.map((stage) => (
                <li key={stage.id} className={stageStateClass(stage.state)}>
                  <span className="hub-run-stage-marker" aria-hidden="true" />
                  <div className="hub-run-stage-copy">
                    <div className="hub-run-stage-row">
                      <span className="hub-run-stage-label">{stage.label}</span>
                      <span className="hub-chip">{stage.state}</span>
                    </div>
                    {stage.timestamp ? (
                      <span className="hub-mono hub-muted">
                        {stage.timestamp}
                      </span>
                    ) : null}
                    {stage.detail ? (
                      <span className="hub-muted hub-run-stage-detail">
                        {stage.detail}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside
          className="hub-panel hub-run-inspector"
          aria-labelledby="hub-run-inspector-heading"
        >
          <div className="hub-run-section-header">
            <div>
              <p className="hub-eyebrow">Inspector</p>
              <h2 id="hub-run-inspector-heading">Batch details</h2>
            </div>
            <span className="hub-mono hub-muted">
              {metadata?.batchId ?? "—"}
            </span>
          </div>

          <dl className="hub-kv">
            <div>
              <dt>Run id</dt>
              <dd className="hub-mono">{metadata?.runId ?? "—"}</dd>
            </div>
            <div>
              <dt>Flow id</dt>
              <dd className="hub-mono">{metadata?.flowId ?? "—"}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd className="hub-mono">{metadata?.branch ?? "—"}</dd>
            </div>
            <div>
              <dt>Batch strategy</dt>
              <dd className="hub-chip is-active">
                {metadata?.batchStrategy ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Run directory</dt>
              <dd className="hub-mono" title={metadata?.runDir}>
                {formatHubOverviewPath(metadata?.runDir ?? "")}
              </dd>
            </div>
            <div>
              <dt>Batch status</dt>
              <dd className={batchStatusChipClass(metadata?.batchStatus)}>
                {batchStatusLabel(metadata?.batchStatus)}
              </dd>
            </div>
          </dl>

          <section className="hub-run-inspector-block">
            <h3>Tasks in batch</h3>
            <SelectedTaskChipCloud taskIds={metadata?.selectedTaskIds ?? []} />
          </section>

          <section className="hub-run-inspector-block">
            <h3>Rationale</h3>
            <p className="hub-muted">
              {metadata?.rationale ?? "No batch rationale recorded."}
            </p>
          </section>

          <section className="hub-run-inspector-block">
            <h3>Related commits</h3>
            {metadata && metadata.relatedCommits.length > 0 ? (
              <div className="hub-run-chip-cloud">
                {metadata.relatedCommits.map((commit) => (
                  <span key={commit} className="hub-chip">
                    {commit}
                  </span>
                ))}
              </div>
            ) : (
              <p className="hub-muted">No related commits recorded.</p>
            )}
          </section>

          <section className="hub-run-inspector-block">
            <h3>Worktree lease</h3>
            {metadata && metadata.worktreeLeases.length > 0 ? (
              <div className="hub-run-callout">
                <ul className="hub-list">
                  {metadata.worktreeLeases.map((lease) => (
                    <li key={lease.taskId}>
                      <span className="hub-mono">{lease.taskId}</span> on{" "}
                      <span className="hub-mono">{lease.branch}</span>
                      {lease.claimState ? ` — claim ${lease.claimState}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="hub-muted">
                No worktree lease diagnostics for this run.
              </p>
            )}
          </section>
        </aside>
      </section>

      <section
        className="hub-panel hub-panel-wide"
        aria-labelledby="hub-run-actions-heading"
      >
        <div className="hub-run-section-header">
          <div>
            <p className="hub-eyebrow">Actions</p>
            <h2 id="hub-run-actions-heading">Run controls</h2>
          </div>
          <span className="hub-muted">
            Preview-confirm where supported; CLI-only where required.
          </span>
        </div>
        <div className="hub-run-actions">
          {model.actions.map((action) => (
            <RunWorkbenchActionButton
              key={`${model.selectedRunId}:${model.selectedBatchId}:${action.id}`}
              action={action}
              onPreviewAction={onPreviewAction}
              onConfirmAction={onConfirmAction}
            />
          ))}
        </div>
      </section>

      <section
        className={`hub-panel hub-terminal hub-panel-wide hub-run-terminal is-${model.terminalPhase}`}
        aria-labelledby="hub-run-terminal-heading"
      >
        <div className="hub-run-terminal-header">
          <div
            className="hub-run-terminal-tabs"
            role="tablist"
            aria-label="Run output tabs"
          >
            <button
              type="button"
              className={`hub-run-terminal-tab hub-focus-ring ${
                outputTab === "terminal" ? "is-active" : ""
              }`}
              role="tab"
              aria-selected={outputTab === "terminal"}
              onClick={() => setOutputTab("terminal")}
            >
              Terminal Output
            </button>
            <button
              type="button"
              className={`hub-run-terminal-tab hub-focus-ring ${
                outputTab === "jsonl" ? "is-active" : ""
              }`}
              role="tab"
              aria-selected={outputTab === "jsonl"}
              onClick={() => setOutputTab("jsonl")}
            >
              JSONL Stream
            </button>
          </div>
          <span className="hub-status" role="status">
            {terminalPhaseLabel(model.terminalPhase)}
          </span>
        </div>
        <pre className="hub-terminal-body" aria-live="polite">
          {outputLines.length > 0
            ? outputLines.join("\n")
            : outputEmptyStateLabel(outputTab)}
        </pre>
      </section>
    </div>
  );
};
