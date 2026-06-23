import type { CSSProperties } from "react";

import type {
  HubProjectStatus,
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import type { HubTaskInspectorModel } from "@yibeibankaishui/archloop/hub-task-board-workbench";

import { HubWorkbenchActionButton } from "./HubWorkbenchActionButton";

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
              <HubWorkbenchActionButton
                key={action.id}
                action={action}
                variant="inspector"
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
