import { useState } from "react";
import type { CSSProperties } from "react";

import type {
  HubProjectStatus,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import type {
  HubTaskBoardAction,
  HubTaskInspectorModel,
} from "@yibeibankaishui/archloop/hub-task-board-workbench";

export interface InspectorPanelProps {
  readonly taskInspector?: HubTaskInspectorModel;
  readonly projectStatus?: HubProjectStatus;
  readonly style?: CSSProperties;
  readonly onPreviewAction?: (
    action: HubRuntimePreviewAction,
    params: Record<string, unknown>,
  ) => Promise<HubRuntimeActionPreview | undefined>;
  readonly onConfirmAction?: (
    preview: HubRuntimeActionPreview,
    params: Record<string, unknown>,
  ) => Promise<string | undefined>;
}

const InspectorActionButton = ({
  action,
  onPreviewAction,
  onConfirmAction,
}: {
  readonly action: HubTaskBoardAction;
  readonly onPreviewAction?: InspectorPanelProps["onPreviewAction"];
  readonly onConfirmAction?: InspectorPanelProps["onConfirmAction"];
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
    <div className="hub-inspector-action">
      <strong>{action.label}</strong>
      <p className="hub-muted">{action.description}</p>
      {action.disabledReason ? (
        <p className="hub-muted">{action.disabledReason}</p>
      ) : null}
      <p className="hub-muted">
        CLI: <code>{action.cliFallback}</code>
      </p>
      {resultMessage ? <p className="hub-muted">{resultMessage}</p> : null}
      {preview ? (
        <div className="hub-panel">
          <p>{preview.summary}</p>
          {preview.disabledReason ? (
            <p className="hub-muted">{preview.disabledReason}</p>
          ) : null}
        </div>
      ) : null}
      <div className="hub-inspector-action-controls">
        {action.kind === "bridge_preview" ? (
          <>
            <button
              type="button"
              className="hub-button hub-focus-ring"
              disabled={disabled || pending}
              onClick={() => void handlePreview()}
            >
              Preview
            </button>
            <button
              type="button"
              className="hub-button hub-focus-ring"
              disabled={!preview || pending || Boolean(preview.disabledReason)}
              onClick={() => void handleConfirm()}
            >
              Confirm
            </button>
          </>
        ) : (
          <button
            type="button"
            className="hub-button hub-focus-ring"
            disabled={disabled}
            title={action.disabledReason ?? action.cliFallback}
          >
            CLI only
          </button>
        )}
      </div>
    </div>
  );
};

export const InspectorPanel = ({
  taskInspector,
  projectStatus,
  style,
  onPreviewAction,
  onConfirmAction,
}: InspectorPanelProps) => (
  <aside className="hub-inspector" style={style} aria-label="Inspector">
    <section className="hub-inspector-section">
      <h2>Project</h2>
      <dl className="hub-kv">
        <div>
          <dt>Repo</dt>
          <dd className="hub-mono">{projectStatus?.repoRoot ?? "—"}</dd>
        </div>
        <div>
          <dt>Hub dir</dt>
          <dd className="hub-mono">{projectStatus?.hubProjectDir ?? "—"}</dd>
        </div>
        <div>
          <dt>Task store</dt>
          <dd>
            {projectStatus?.taskStoreInitialized ? "initialized" : "missing"}
          </dd>
        </div>
      </dl>
    </section>

    {taskInspector ? (
      <>
        <section className="hub-inspector-section">
          <h2>{taskInspector.title}</h2>
          <p className="hub-muted hub-mono">{taskInspector.taskId}</p>
          <span
            className={`hub-status hub-status-${taskInspector.hubStatus}`}
          >
            {taskInspector.hubStatus}
          </span>
          <p className="hub-muted">{taskInspector.commentsSummary}</p>
        </section>

        {taskInspector.sections.map((section) => (
          <section key={section.id} className="hub-inspector-section">
            <h2>{section.title}</h2>
            <dl className="hub-kv">
              {section.rows.map((row) => (
                <div key={`${section.id}-${row.key}`}>
                  <dt>{row.key}</dt>
                  <dd className="hub-mono">{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        {taskInspector.nextActions.length > 0 ? (
          <section className="hub-inspector-section">
            <h2>Next actions</h2>
            <ul className="hub-list">
              {taskInspector.nextActions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="hub-inspector-section">
          <h2>Actions</h2>
          <div className="hub-inspector-action-list">
            {taskInspector.actions.map((action) => (
              <InspectorActionButton
                key={action.id}
                action={action}
                onPreviewAction={onPreviewAction}
                onConfirmAction={onConfirmAction}
              />
            ))}
          </div>
        </section>
      </>
    ) : (
      <section className="hub-inspector-section">
        <h2>Selection</h2>
        <p className="hub-muted">Select a task to inspect local Hub metadata.</p>
      </section>
    )}
  </aside>
);
