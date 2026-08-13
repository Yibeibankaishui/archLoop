# Hub landing uses durable per-task transactions and fenced target CAS

**archLoop Hub** lands verified task work through a durable per-task **landing transaction** against a stable **Hub publish target**. The default target is an archLoop-owned local Git ref and does not require a remote repository. The user's checked-out branch is a committed contribution source and best-effort projection, not the authority used to prove that a task shipped.

## Decision

Each merge-ready task freezes its source OID and receives a durable FIFO/dependency ticket for one Hub publish target. The landing coordinator builds a bounded ordered candidate chain in Hub-owned detached worktrees. Candidate creation is ordered by predecessor OID, exact candidates may verify in parallel, and target advancement is serialized. A task owns its own landing transaction; a sibling failure does not roll back or skip independent work.

The durable transaction records exact OIDs and stable idempotency identities for base pinning, candidate creation, candidate verification, local target advancement, optional remote publication, local task closure, and cleanup. Display events are projections of those checkpoints and are not recovery truth. `merge_succeeded` is retired because integration success is not landing success.

Only the exact candidate bound to a successful verification artifact may land. Semantic merge conflicts and verification failures receive at most two isolated Agent repair attempts each. Any repair, predecessor change, committed host-target contribution, or target drift invalidates affected successor candidates and their verification. Three immediate drift rebuilds are allowed per activation; continued churn retains the oldest FIFO ticket in `target_quiet_wait` until a stable window allows automatic retry.

Landing uses a short target lease, expected target OID, and Git fencing. Expensive Agent and verification work does not hold the lease. A Git ref transaction verifies the current fence and target, advances the Hub publish target, and writes a per-transaction landing receipt atomically. File lease epochs are diagnostic only; they are not sufficient fencing.

`shipped` is a derived proof. With publication off or best-effort, the exact verified candidate must be present in the Hub publish target and the local task must be closed with matching transaction/OID metadata. With required publication, remote ancestry proof is also required. Best-effort publication, checkout synchronization, and cleanup do not determine shipped.

Remote code publication is explicitly configured as off, best-effort, or required. archLoop never publishes merely because a remote exists. Publication uses a durable outbox and exact expected remote OID; unknown outcomes are observed before retry. Required publication is ordered per remote ref and blocks successor target advancement until the predecessor is remotely proven. Publication pending is not merge failure, but a required-delivery timeout returns a distinct non-zero completed-with-pending-delivery outcome.

The configured host target branch is observed as committed input. A descendant or diverged committed tip is integrated and verified before task candidates continue. Uncommitted host state is never imported. Checkout synchronization is a separate durable projection: archLoop fast-forwards only when it can prove safety and otherwise records `checkout_sync_pending` without stash, replay, WIP commits, branch switches, or run failure.

Recovery reconstructs missing checkpoints from physical evidence: deterministic candidate refs and manifests, fsynced verification artifacts, atomic landing receipts and ancestry, remote ancestry, matching task-close metadata, and idempotent resource absence. Historical `merge_succeeded` alone is never landing proof. Existing closed history remains grandfathered, while ambiguous in-flight history requires explicit integrity review rather than automatic close or reimplementation.

## Consequences

- Local Beads dirtiness and user WIP no longer participate in the Git landing transaction.
- Normal pending landing, publication, close, checkout, and cleanup work resumes automatically and does not require `archloop tasks recover`.
- Candidate construction and verification retain concurrency, while final target correctness depends on FIFO order, fencing, exact-OID verification, and CAS.
- A continuously modified external target can delay delivery, but cannot make later transactions overtake the queue head or cause an internal busy loop.
- Required remote publication introduces deliberate head-of-line delivery ordering; local-first projects avoid that remote dependency.
- Programmatic branch strategies keep their existing target-branch behavior. This decision applies to Hub flow landing.

## Considered Options

1. **Merge directly in the user's checkout** -- rejected because staged, unstaged, untracked, Beads, submodule, sparse-checkout, and external-writer state cannot be made transactionally safe without controlling the user's checkout.
2. **Automatically stash and replay user state** -- rejected because replay is not atomic or idempotent across crashes and cannot preserve every Git/worktree state.
3. **Build every candidate from the same target snapshot and repair drift at landing** -- rejected because all but the first candidate are predictably stale and most verification work is wasted.
4. **Treat a flow batch as one atomic Git merge** -- rejected because one bad task would block or roll back independent verified work.
5. **Use events or Beads status as recovery truth** -- rejected because events can be written before or after external side effects and earlier `merge_succeeded` semantics were ambiguous.
6. **Require a remote repository as the authoritative target** -- rejected because local-only and offline Hub projects must remain first-class.

## Supersedes and Amends

- Supersedes the success-event and recovery assumptions in ADR-0022; milestone events now project durable OID-bearing checkpoints.
- Amends ADR-0023 with an evidence-based `done`/`shipped` definition and a `publishing` delivery state for required publication.
- Amends ADR-0029: the stable Hub project directory is the only root for transaction journals, receipts, and run projections.
- Supersedes the merge-phase portion of ADR-0034: startup transaction reconciliation replaces event-only merge recovery and does not route managed landing work through routine `tasks recover`.
