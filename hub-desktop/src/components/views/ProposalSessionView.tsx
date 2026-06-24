import { useMemo } from "react";

import type {
  HubProjectRunSummary,
  HubProjectStatus,
  HubRunEventsSnapshot,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import { formatHubOverviewPath } from "@yibeibankaishui/archloop/hub-project-overview";
import {
  buildHubProposalWorkbenchModel,
  resolveHubProposalWorkbenchGridClass,
  selectDefaultProposalRunDir,
  type HubProposalTaskCard,
  type HubProposalValidationError,
  type HubProposalWorkbenchAction,
  type ProposalSessionArtifactsSnapshot,
} from "@yibeibankaishui/archloop/hub-proposal-workbench";

import { HubWorkbenchActionButton } from "../HubWorkbenchActionButton";

export interface ProposalSessionViewProps {
  readonly status?: HubProjectStatus;
  readonly runSummaries?: readonly HubProjectRunSummary[];
  readonly sessionArtifacts?: ProposalSessionArtifactsSnapshot;
  readonly eventsSnapshot?: HubRunEventsSnapshot;
  readonly loading?: boolean;
  readonly runtimeError?: string;
  readonly viewportWidth: number;
  readonly selectedRunDir?: string;
  readonly onSelectRunDir?: (runDir: string) => void;
  readonly onPreviewAction?: (
    action: HubRuntimePreviewAction,
    params: Record<string, unknown>,
  ) => Promise<HubRuntimeActionPreview | undefined>;
  readonly onConfirmAction?: (
    preview: HubRuntimeActionPreview,
    params: Record<string, unknown>,
  ) => Promise<string | undefined>;
}

const proposalStatusLabel = (status: string): string =>
  status.replaceAll("_", " ");

const validationItemClass = (
  kind: HubProposalValidationError["kind"],
): string => {
  switch (kind) {
    case "mutation_detection_failure":
    case "schema_mismatch":
    case "invalid_dependencies":
    case "missing_acceptance_criteria":
      return "hub-banner is-error";
    default:
      return "hub-banner is-warning";
  }
};

const taskCardClass = (card: HubProposalTaskCard): string => {
  switch (card.validationState) {
    case "error":
      return "hub-proposal-card is-error";
    case "warning":
      return "hub-proposal-card is-warning";
    default:
      return "hub-proposal-card";
  }
};

const taskValidationChipClass = (
  validationState: HubProposalTaskCard["validationState"],
): string => {
  switch (validationState) {
    case "error":
      return "hub-chip is-error";
    case "warning":
      return "hub-chip is-warning";
    default:
      return "hub-chip";
  }
};

const dependencySummary = (dependencies: readonly string[]): string => {
  if (dependencies.length === 0) {
    return "No dependencies";
  }
  if (dependencies.length === 1) {
    return "1 dependency";
  }
  return `${dependencies.length} dependencies`;
};

const ProposalSecondaryAction = ({
  action,
}: {
  readonly action: HubProposalWorkbenchAction;
}) => (
  <div className="hub-proposal-secondary-action">
    <button
      type="button"
      className="hub-button hub-focus-ring"
      disabled
      aria-disabled="true"
      title={action.disabledReason ?? action.cliFallback}
    >
      {action.label}
    </button>
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
);

const ProposalTaskCardView = ({
  card,
  index,
}: {
  readonly card: HubProposalTaskCard;
  readonly index: number;
}) => (
  <li className={taskCardClass(card)}>
    <div className="hub-proposal-card-header">
      <div className="hub-proposal-card-header-copy">
        <p className="hub-eyebrow">Task {index + 1}</p>
        <strong>{card.title}</strong>
      </div>
      <code>{card.id}</code>
    </div>
    <div className="hub-proposal-chip-row">
      {card.intendedHubStatus ? (
        <span className="hub-chip is-active">
          {card.intendedHubStatus.replaceAll("_", " ")}
        </span>
      ) : null}
      {card.classification ? (
        <span className="hub-chip">{card.classification}</span>
      ) : null}
      {card.confidence ? (
        <span className="hub-chip">{card.confidence} confidence</span>
      ) : null}
      <span className="hub-chip">{dependencySummary(card.dependencies)}</span>
      <span className={taskValidationChipClass(card.validationState)}>
        {card.validationState}
      </span>
    </div>
    {card.rationale ? <p className="hub-muted">{card.rationale}</p> : null}
    {card.warnings.length > 0 ? (
      <div className="hub-banner is-warning">
        <strong>Warnings</strong>
        <ul className="hub-list">
          {card.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </div>
    ) : null}
    {card.validationState === "error" ? (
      <p className="hub-muted">
        Blocked until the validation block is resolved.
      </p>
    ) : null}
  </li>
);

export const ProposalSessionView = ({
  status,
  runSummaries,
  sessionArtifacts,
  eventsSnapshot,
  loading = false,
  runtimeError,
  viewportWidth,
  selectedRunDir,
  onSelectRunDir,
  onPreviewAction,
  onConfirmAction,
}: ProposalSessionViewProps) => {
  const defaultRunDir = useMemo(
    () => selectDefaultProposalRunDir(runSummaries ?? []),
    [runSummaries],
  );

  const model = useMemo(
    () =>
      buildHubProposalWorkbenchModel({
        loading,
        runtimeError,
        runSummaries,
        sessionArtifacts,
        proposalEvents: eventsSnapshot?.events,
        projectStatus: status,
        selectedRunDir: selectedRunDir ?? defaultRunDir,
      }),
    [
      loading,
      runtimeError,
      runSummaries,
      sessionArtifacts,
      eventsSnapshot,
      status,
      selectedRunDir,
      defaultRunDir,
    ],
  );

  if (model.phase === "loading") {
    return (
      <div
        className="hub-proposal-grid hub-proposal-grid-narrow"
        aria-busy="true"
        aria-label="Loading proposal session"
      >
        <section className="hub-panel hub-proposal-skeleton">
          <h2>Source document</h2>
          <p className="hub-muted">Loading proposal session artifacts...</p>
        </section>
        <section className="hub-panel hub-proposal-skeleton">
          <h2>Task decomposition</h2>
          <p className="hub-muted">Reading local Hub run directories...</p>
        </section>
        <section className="hub-panel hub-proposal-skeleton">
          <h2>Inspector</h2>
          <p className="hub-muted">Loading lease and artifact details...</p>
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
        <h2>No proposal sessions yet</h2>
        <p className="hub-muted">
          Start a PRD decomposition or triage proposal flow from the CLI, then
          inspect the session artifacts here.
        </p>
        <p className="hub-muted">
          CLI fallback: <code>{model.cliFallback}</code>
        </p>
      </div>
    );
  }

  const metadata = model.metadata;
  const gridClass = resolveHubProposalWorkbenchGridClass(viewportWidth);
  const approveAction = model.actions.find((action) => action.id === "approve");
  const rejectAction = model.actions.find((action) => action.id === "reject");
  const reviseAction = model.actions.find((action) => action.id === "revise");

  return (
    <div className={gridClass} aria-label="Hub proposal session">
      <section
        className="hub-panel hub-proposal-pane hub-proposal-source-pane"
        aria-labelledby="hub-proposal-source-heading"
      >
        <header className="hub-proposal-pane-header">
          <div className="hub-proposal-pane-header-copy">
            <p className="hub-eyebrow">Proposal sessions</p>
            <h2 id="hub-proposal-source-heading">Source document</h2>
          </div>
          <div className="hub-proposal-pane-header-meta">
            <span className="hub-chip is-active">
              {proposalStatusLabel(metadata?.proposalStatus ?? "drafting")}
            </span>
            {metadata?.confidenceSummary ? (
              <span className="hub-chip">{metadata.confidenceSummary}</span>
            ) : null}
          </div>
        </header>

        {model.sessionOptions.length > 0 ? (
          <div className="hub-proposal-selector">
            <label
              className="hub-proposal-selector-label"
              htmlFor="hub-proposal-select"
            >
              Run directory
            </label>
            <select
              id="hub-proposal-select"
              className="hub-proposal-select hub-focus-ring"
              value={model.selectedRunDir ?? ""}
              onChange={(event) => onSelectRunDir?.(event.target.value)}
            >
              {model.sessionOptions.map((option) => (
                <option key={option.runDir} value={option.runDir}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {metadata ? (
          <dl className="hub-kv hub-proposal-meta">
            <div>
              <dt>Flow</dt>
              <dd>
                <code>{metadata.flowId}</code>
              </dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>
                <code>{metadata.runId}</code>
              </dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>
                <code>{metadata.branch ?? "—"}</code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{proposalStatusLabel(metadata.proposalStatus)}</dd>
            </div>
          </dl>
        ) : null}

        {model.sourceContext ? (
          <>
            {model.sourceContext.highlights.length > 0 ? (
              <ul className="hub-proposal-highlight-list">
                {model.sourceContext.highlights.map((highlight) => (
                  <li key={highlight} className="hub-chip">
                    {highlight}
                  </li>
                ))}
              </ul>
            ) : null}

            {model.sourceContext.extractedRequirementText ? (
              <div className="hub-banner hub-proposal-highlight" role="note">
                <strong>Extracted requirement</strong>
                <p className="hub-muted">
                  {model.sourceContext.extractedRequirementText}
                </p>
              </div>
            ) : null}

            {model.sourceContext.requirements.length > 0 ? (
              <ol className="hub-proposal-requirements">
                {model.sourceContext.requirements.map((requirement, index) => (
                  <li key={`${index}-${requirement}`}>
                    <span className="hub-proposal-requirement-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="hub-proposal-requirement-copy">
                      {requirement}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}

            {model.sourceContext.summary ? (
              <p className="hub-muted">{model.sourceContext.summary}</p>
            ) : null}

            {metadata?.agentRationale ? (
              <div className="hub-proposal-rationale" role="note">
                <strong>Agent rationale</strong>
                <p className="hub-muted">{metadata.agentRationale}</p>
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section
        className="hub-panel hub-proposal-pane hub-proposal-center-pane"
        aria-labelledby="hub-proposal-tasks-heading"
      >
        <header className="hub-proposal-pane-header">
          <div className="hub-proposal-pane-header-copy">
            <p className="hub-eyebrow">Task decomposition</p>
            <h2 id="hub-proposal-tasks-heading">Proposed tasks</h2>
          </div>
          <span className="hub-chip is-active">Local draft</span>
        </header>

        {model.taskCards.length === 0 ? (
          <p className="hub-muted">
            No structured proposal tasks are available yet.
          </p>
        ) : (
          <ol className="hub-proposal-card-list">
            {model.taskCards.map((card, index) => (
              <ProposalTaskCardView key={card.id} card={card} index={index} />
            ))}
          </ol>
        )}

        <section
          className="hub-proposal-validation-panel"
          aria-labelledby="hub-proposal-validation-heading"
        >
          <div className="hub-proposal-pane-header">
            <div className="hub-proposal-pane-header-copy">
              <p className="hub-eyebrow">Validation</p>
              <h3 id="hub-proposal-validation-heading">Blocking issues</h3>
            </div>
            <span
              className={
                model.validationErrors.length > 0
                  ? "hub-chip is-error"
                  : "hub-chip"
              }
            >
              {model.validationErrors.length > 0
                ? `${model.validationErrors.length} issue${model.validationErrors.length === 1 ? "" : "s"}`
                : "No blocking issues"}
            </span>
          </div>

          {model.validationErrors.length === 0 ? (
            <p className="hub-muted" role="status">
              No blocking validation issues detected.
            </p>
          ) : (
            <div className="hub-banner is-error">
              <strong>Validation errors</strong>
              <ul className="hub-list">
                {model.validationErrors.map((error, index) => (
                  <li
                    key={`${error.kind}-${index}`}
                    className={validationItemClass(error.kind)}
                  >
                    <strong>{error.kind.replaceAll("_", " ")}</strong>
                    <p>{error.message}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {model.applyState ? (
          <section
            className="hub-proposal-apply-panel"
            aria-label="Apply result"
          >
            <div className="hub-proposal-pane-header">
              <div className="hub-proposal-pane-header-copy">
                <p className="hub-eyebrow">Local apply</p>
                <h3>Apply result</h3>
              </div>
              <span className="hub-chip">{model.applyState.status}</span>
            </div>
            <p>{model.applyState.message}</p>
            <p className="hub-muted">{model.applyState.nextStep}</p>
            {model.applyState.artifactReferences.length > 0 ? (
              <ul className="hub-list">
                {model.applyState.artifactReferences.map((reference) => (
                  <li key={reference}>
                    <code>{reference}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </section>

      <aside
        className="hub-panel hub-proposal-pane hub-proposal-inspector-pane"
        aria-labelledby="hub-proposal-inspector-heading"
      >
        <header className="hub-proposal-pane-header">
          <div className="hub-proposal-pane-header-copy">
            <p className="hub-eyebrow">Inspector</p>
            <h2 id="hub-proposal-inspector-heading">Worktree lease</h2>
          </div>
          {metadata?.runId ? <code>{metadata.runId}</code> : null}
        </header>

        {metadata ? (
          <dl className="hub-kv hub-proposal-inspector-kv">
            <div>
              <dt>Worktree lease</dt>
              <dd>{metadata.worktreeLeaseSummary}</dd>
            </div>
            <div>
              <dt>Local writes</dt>
              <dd>{metadata.localWriteSummary}</dd>
            </div>
            <div>
              <dt>Agent log</dt>
              <dd className="hub-mono">
                {formatHubOverviewPath(metadata.agentLogPath)}
              </dd>
            </div>
            <div>
              <dt>ID</dt>
              <dd className="hub-mono">{metadata.runId}</dd>
            </div>
          </dl>
        ) : null}

        {metadata ? (
          <section className="hub-proposal-artifacts">
            <h3 className="hub-run-subheading">Artifacts</h3>
            <ul className="hub-list">
              {metadata.artifactPaths.map((artifact) => (
                <li key={artifact.path}>
                  <strong>{artifact.label}</strong>
                  <br />
                  <code>{formatHubOverviewPath(artifact.path)}</code>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="hub-banner hub-proposal-inspector-note" role="note">
          <strong>Note</strong>
          <p className="hub-muted">{model.localWriteCopy}</p>
          <p className="hub-muted">{model.remoteSyncCopy}</p>
        </div>
      </aside>

      <section
        className="hub-panel hub-panel-wide hub-proposal-decision-bar"
        aria-labelledby="hub-proposal-decision-heading"
      >
        <div className="hub-proposal-decision-copy">
          <p className="hub-eyebrow">Decision bar</p>
          <h2 id="hub-proposal-decision-heading">Proposal state</h2>
          <p className="hub-muted">
            {metadata
              ? proposalStatusLabel(metadata.proposalStatus)
              : "drafting"}
          </p>
        </div>
        <div className="hub-proposal-decision-actions">
          {rejectAction ? (
            <ProposalSecondaryAction action={rejectAction} />
          ) : null}
          {reviseAction ? (
            <ProposalSecondaryAction action={reviseAction} />
          ) : null}
          {approveAction ? (
            <div className="hub-proposal-decision-primary">
              <HubWorkbenchActionButton
                action={approveAction}
                variant="inspector"
                onPreviewAction={onPreviewAction}
                onConfirmAction={onConfirmAction}
              />
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
};
