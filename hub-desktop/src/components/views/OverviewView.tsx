import type { HubProjectStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";

export const OverviewView = ({
  status,
}: {
  readonly status?: HubProjectStatus;
}) => (
  <div className="hub-panel-grid">
    <section className="hub-panel">
      <h2>Project health</h2>
      <dl className="hub-kv">
        <div>
          <dt>Registered</dt>
          <dd>{status?.projectRegistered ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Ready tasks</dt>
          <dd>{status?.taskCounts.ready ?? 0}</dd>
        </div>
        <div>
          <dt>Failed tasks</dt>
          <dd>{status?.failedTasks.length ?? 0}</dd>
        </div>
        <div>
          <dt>Active batches</dt>
          <dd>{status?.activeBatches.length ?? 0}</dd>
        </div>
      </dl>
    </section>
    <section className="hub-panel">
      <h2>Sync state</h2>
      <dl className="hub-kv">
        <div>
          <dt>Push pending</dt>
          <dd>{status?.syncCounts.pushPending ?? 0}</dd>
        </div>
        <div>
          <dt>Conflicts</dt>
          <dd>{status?.syncCounts.conflict ?? 0}</dd>
        </div>
        <div>
          <dt>Local only</dt>
          <dd>{status?.syncCounts.localOnly ?? 0}</dd>
        </div>
        <div>
          <dt>Synced</dt>
          <dd>{status?.syncCounts.synced ?? 0}</dd>
        </div>
      </dl>
    </section>
    <section className="hub-panel hub-panel-wide">
      <h2>Recent activity</h2>
      {status?.recentEvents.length ? (
        <ul className="hub-list">
          {status.recentEvents.map((event) => (
            <li key={event}>{event}</li>
          ))}
        </ul>
      ) : (
        <p className="hub-muted">No recent Hub events yet.</p>
      )}
    </section>
  </div>
);
