# Proposal flows run no-sandbox with mutation detection

**Proposal flows** always run with the **no-sandbox provider**. They produce **task proposals** and must not directly modify code or write to the **local task store**. They may still use normal agent exploration and prompt expansion to inspect useful host context, but prompts must clearly instruct the agent not to perform dangerous or mutating actions.

Sandcastle does not impose a shell-expression allowlist for proposal flows in v1. Instead, it provides required context up front, trusts high-capability agents to explore responsibly, and enforces the proposal-only contract after the run. Sandcastle snapshots relevant repository state and local task store state before and after the proposal flow. If unexpected repo or Beads mutations are detected, the flow fails, the proposal is not applied, and Sandcastle reports the detected changes without automatically reverting them.

## Considered Options

1. **Run proposal flows in a sandbox** -- rejected because these flows need host PRDs, Beads data, Hub context, and user interaction, while they do not modify code.
2. **Disallow prompt shell expressions** -- rejected because proposal flows should let high-capability agents inspect additional project context when useful.
3. **Use a read-only command allowlist** -- rejected for v1 because it constrains useful exploration and adds a second permission model before the flow semantics have settled.
4. **Run no-sandbox with prompt constraints and post-run mutation detection** -- chosen because it keeps proposal flows ergonomic while enforcing their non-mutating contract at the state boundary.
