export const ProposalSessionView = () => (
  <div className="hub-panel">
    <h2>Proposal session</h2>
    <p className="hub-muted">
      Proposal sessions load from local Hub run directories through the runtime
      bridge. Start a PRD or triage flow from the CLI, then inspect the session
      artifacts here in a later slice.
    </p>
    <p className="hub-muted">
      CLI fallback: <code>archloop tasks from-prd</code> or{" "}
      <code>archloop tasks triage</code>
    </p>
  </div>
);
