import type { CSSProperties } from "react";

import type { HubProjectStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";
import type { HubTaskProjection } from "@yibeibankaishui/archloop/hub-runtime-contract";

export interface InspectorPanelProps {
  readonly selectedTask?: HubTaskProjection;
  readonly projectStatus?: HubProjectStatus;
  readonly style?: CSSProperties;
}

export const InspectorPanel = ({
  selectedTask,
  projectStatus,
  style,
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
    <section className="hub-inspector-section">
      <h2>Selection</h2>
      {selectedTask ? (
        <dl className="hub-kv">
          <div>
            <dt>Task</dt>
            <dd className="hub-mono">{selectedTask.id}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`hub-status hub-status-${selectedTask.hubStatus}`}>
                {selectedTask.hubStatus}
              </span>
            </dd>
          </div>
          <div>
            <dt>Title</dt>
            <dd>{selectedTask.title}</dd>
          </div>
          {selectedTask.claim ? (
            <div>
              <dt>Claim</dt>
              <dd className="hub-mono">{selectedTask.claim.branch}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="hub-muted">Select a task to inspect local Hub metadata.</p>
      )}
    </section>
  </aside>
);
