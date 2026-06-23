import { useMemo } from "react";

import type {
  HubProjectRunSummary,
  HubProjectStatus,
  HubRunEventsSnapshot,
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
}

const validationClass = (kind: HubProposalValidationError["kind"]): string => {
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

const proposalStatusLabel = (status: string): string =>
  status.replaceAll("_", " ");

const ProposalActionRow = ({
  action,
}: {
  readonly action: HubProposalWorkbenchAction;
}) => (
  <div className="hub-proposal-action">
    <div className="hub-proposal-action-copy">
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
    <div className="hub-proposal-action-controls">
      <button
        type="button"
        className="hub-button hub-focus-ring"
        disabled={action.disabledReason !== undefined}
        aria-label={
          action.disabledReason
            ? `${action.label} unavailable: ${action.disabledReason}`
            : `${action.label} via CLI`
        }
      >
        CLI only
      </button>
    </div>
  </div>
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
          <h2>Source context</h2>
          <p className="hub-muted">Loading proposal session artifacts…</p>
        </section>
        <section className="hub-panel hub-proposal-skeleton">
          <h2>Proposed tasks</h2>
          <p className="hub-muted">Reading local Hub run directories…</p>
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

  return (
    <div className={gridClass} aria-label="Hub proposal session">
      <section
        className="hub-panel hub-panel-wide"
        aria-labelledby="hub-proposal-select-heading"
      >
        <h2 id="hub-proposal-select-heading">Proposal sessions</h2>
        <div className="hub-banner" role="note">
          <strong>Local writes only</strong>
          <p className="hub-muted">{model.localWriteCopy}</p>
          <p className="hub-muted">{model.remoteSyncCopy}</p>
        </div>
        {model.sessionOptions.length > 0 ? (
          <div className="hub-proposal-selector">
            <label className="hub-proposal-selector-label" htmlFor="hub-proposal-select">
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
          <dl className="hub-meta-grid">
            <div>
              <dt>Flow</dt>
              <dd>
                <code>{metadata.flowId}</code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{proposalStatusLabel(metadata.proposalStatus)}</dd>
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
          </dl>
        ) : null}
      </section>

      {model.sourceContext ? (
        <section className="hub-panel" aria-labelledby="hub-proposal-source-heading">
          <h2 id="hub-proposal-source-heading">{model.sourceContext.title}</h2>
          {model.sourceContext.summary ? (
            <p className="hub-muted">{model.sourceContext.summary}</p>
          ) : null}
          <ul className="hub-list">
            {model.sourceContext.highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
          {metadata?.agentRationale ? (
            <div className="hub-proposal-rationale" role="note">
              <strong>Agent rationale</strong>
              <p className="hub-muted">{metadata.agentRationale}</p>
            </div>
          ) : null}
          {model.sourceContext.transcriptExcerpt.length > 0 ? (
            <div className="hub-proposal-transcript">
              <h3 className="hub-run-subheading">Recent transcript</h3>
              <ul className="hub-list">
                {model.sourceContext.transcriptExcerpt.map((turn, index) => (
                  <li key={`${turn.role}-${index}`}>
                    <strong>{turn.role}</strong>: {turn.content}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section
        className="hub-panel hub-panel-wide"
        aria-labelledby="hub-proposal-tasks-heading"
      >
        <h2 id="hub-proposal-tasks-heading">Proposed tasks</h2>
        {model.taskCards.length === 0 ? (
          <p className="hub-muted">No structured proposal tasks are available yet.</p>
        ) : (
          <ul className="hub-proposal-card-list">
            {model.taskCards.map((card) => (
              <li key={card.id} className={taskCardClass(card)}>
                <div className="hub-proposal-card-header">
                  <strong>{card.title}</strong>
                  <code>{card.id}</code>
                </div>
                <dl className="hub-meta-grid">
                  {card.intendedHubStatus ? (
                    <div>
                      <dt>Hub status</dt>
                      <dd>
                        <code>{card.intendedHubStatus}</code>
                      </dd>
                    </div>
                  ) : null}
                  {card.classification ? (
                    <div>
                      <dt>Classification</dt>
                      <dd>{card.classification}</dd>
                    </div>
                  ) : null}
                  {card.confidence ? (
                    <div>
                      <dt>Confidence</dt>
                      <dd>{card.confidence}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Dependencies</dt>
                    <dd>
                      {card.dependencies.length > 0
                        ? card.dependencies.join(", ")
                        : "None"}
                    </dd>
                  </div>
                </dl>
                {card.rationale ? (
                  <p className="hub-muted">{card.rationale}</p>
                ) : null}
                {card.warnings.length > 0 ? (
                  <ul className="hub-list">
                    {card.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="hub-panel"
        aria-labelledby="hub-proposal-validation-heading"
      >
        <h2 id="hub-proposal-validation-heading">Validation</h2>
        {model.validationErrors.length === 0 ? (
          <p className="hub-muted" role="status">
            No blocking validation issues detected.
          </p>
        ) : (
          <ul className="hub-list">
            {model.validationErrors.map((error, index) => (
              <li key={`${error.kind}-${index}`} className={validationClass(error.kind)}>
                <strong>{error.kind.replaceAll("_", " ")}</strong>
                <p>{error.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {model.applyState ? (
        <section
          className="hub-panel hub-panel-wide"
          aria-labelledby="hub-proposal-apply-heading"
        >
          <h2 id="hub-proposal-apply-heading">Apply result</h2>
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

      {metadata ? (
        <section
          className="hub-panel"
          aria-labelledby="hub-proposal-artifacts-heading"
        >
          <h2 id="hub-proposal-artifacts-heading">Artifacts</h2>
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

      <section
        className="hub-panel hub-panel-wide hub-proposal-decision-bar"
        aria-labelledby="hub-proposal-actions-heading"
      >
        <h2 id="hub-proposal-actions-heading">Decision actions</h2>
        <div className="hub-proposal-actions">
          {model.actions.map((action) => (
            <ProposalActionRow key={action.id} action={action} />
          ))}
        </div>
      </section>
    </div>
  );
};
