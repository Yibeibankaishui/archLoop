import type { HubProjectStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";

export const RunWorkbenchView = ({
  status,
}: {
  readonly status?: HubProjectStatus;
}) => (
  <div className="hub-panel-grid">
    <section className="hub-panel hub-panel-wide">
      <h2>Active batches</h2>
      {status?.activeBatches.length ? (
        <ul className="hub-list">
          {status.activeBatches.map((batch) => (
            <li key={`${batch.runId}:${batch.batchId}`}>
              <span className="hub-mono">{batch.runId}</span> ·{" "}
              <span className="hub-mono">{batch.batchId}</span> · {batch.status}
              {batch.flowId ? ` · ${batch.flowId}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hub-muted">No active Hub batches.</p>
      )}
    </section>
    <section className="hub-panel">
      <h2>Run directories</h2>
      {status?.runDirectories.length ? (
        <ul className="hub-list hub-mono-list">
          {status.runDirectories.map((runDir) => (
            <li key={runDir}>{runDir}</li>
          ))}
        </ul>
      ) : (
        <p className="hub-muted">No run directories discovered.</p>
      )}
    </section>
    <section className="hub-panel hub-terminal">
      <h2>Event output</h2>
      <pre className="hub-terminal-body">
        {status?.recentEvents.join("\n") || "No run events loaded."}
      </pre>
    </section>
  </div>
);
