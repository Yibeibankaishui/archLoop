# PRD: Fully automatic Hub landing

## Problem Statement

archLoop Hub currently merges completed task branches through the user's checked-out repository. A Hub task-board write can stage or modify Beads runtime/export files such as `.beads/issues.jsonl` even when the task branch contains only normal code. The merge preflight classifies that Beads dirtiness as non-blocking, but the real `git merge` still runs in the dirty checkout and fails. The run then reports `merge_failed` and asks the user to run `archloop tasks recover`, even though the implementation commit is safe and preserved.

This is one symptom of a broader correctness problem. Merge integration, verification, target advancement, task closure, remote publication, checkout synchronization, and recovery are currently coupled too closely. The current `merge_succeeded` event can be written before verification and before the integration result reaches an authoritative target, yet recovery code treats it as proof that the work already landed. A process crash between any two side effects can therefore strand a task, repeat work, or falsely close it.

Users want `archloop run` to provide an unattended delivery loop. Local Beads activity and uncommitted work in the user's checkout must not block safe code landing. A single conflicting or invalid task must not stop independent tasks. Process crashes, target drift, transient network failure, task-store migration, remote publication, and checkout projection must recover automatically from durable evidence instead of requiring routine `tasks recover` commands.

## Solution

Introduce a Hub-owned landing plane whose authoritative default target is a stable local Git ref in the registered Hub project. Every task gets a durable, per-task **landing transaction**. archLoop freezes the source commit, builds an ordered **merge candidate** in a Hub-owned integration worktree, performs full verification, and advances the **Hub publish target** with an OID compare-and-swap transaction. The user's checkout becomes a best-effort projection that is synchronized only when Git can prove the update safe without stash, replay, WIP commits, branch switching, or index mutation.

Landing transactions for one target are ordered by a durable FIFO/dependency ticket. archLoop builds a bounded speculative candidate chain in that order and may verify exact candidate OIDs in parallel, while the target CAS remains serialized. Semantic conflicts and verification failures receive at most two isolated Agent repairs. A repair or external target change invalidates affected successor candidates, which are rebuilt and reverified. Repeated target churn moves the queue head into an automatically retried quiet-wait state without letting later work overtake it.

The default publish policy is local-first and does not require a remote repository. Remote code publication is explicitly configured as off, best-effort, or required; archLoop never starts pushing merely because `origin` exists. Required publication remains ordered and must be proven before the task is shipped. Best-effort publication and checkout synchronization use durable outboxes and do not undo a successful local landing.

Move the Hub Beads database and runtime/export files into the stable Hub project directory. A Git-ignored `.beads/redirect` preserves direct host `bd` usage. Existing stores migrate automatically through a journaled, resumable process; active external Beads writers defer migration while the run continues using the verified legacy store. Execution Agents receive an immutable task snapshot rather than write access to the live task store. Known legacy Beads runtime/export changes on task branches are removed deterministically from merge candidates and recorded; non-runtime Beads configuration changes are not silently discarded.

## User Stories

1. As a Hub user, I want to keep running `archloop run`, so that the automatic landing redesign does not require a new normal command.
2. As a Hub user, I want Beads runtime/export changes in my checkout to be irrelevant to code landing, so that task-board activity cannot break a safe merge.
3. As a Hub user, I want staged `.beads/issues.jsonl` changes to remain untouched, so that archLoop does not modify my index while landing code.
4. As a Hub user, I want uncommitted application changes to remain byte-for-byte unchanged, so that unattended runs cannot damage work in progress.
5. As a Hub user, I want a task to ship even when my checkout cannot be synchronized safely, so that local WIP does not stop later tasks.
6. As a Hub user, I want checkout synchronization to retry automatically, so that cleaning or switching my checkout eventually makes the landed code visible without recovery commands.
7. As a Hub user, I want archLoop never to stash or replay my WIP automatically, so that a crash cannot leave a partially restored checkout.
8. As a Hub user, I want archLoop never to create hidden WIP commits or switch my branch, so that my Git history and current context remain mine.
9. As a local-only user, I want Hub flows to finish without a remote repository, so that archLoop remains useful offline and for private work.
10. As an upgrading user, I want remote code publication to remain off until I configure it, so that an upgrade cannot introduce unexpected pushes.
11. As a team user, I want optional best-effort remote publication, so that local work can ship while transient network failures retry in the background.
12. As a delivery user, I want required remote publication, so that `shipped` can mean the configured remote ref contains the verified candidate.
13. As a delivery user, I want required publication pending to be distinguishable from merge failure, so that I know the code is landed locally and delivery is queued.
14. As a CI user, I want required publication timeout to return non-zero without marking the task failed, so that automation can enforce delivery while archLoop continues safe retries.
15. As a Hub user, I want code publication state to be distinct from GitHub task-sync state, so that `target_publish_pending` is not confused with issue push status.
16. As a Hub user, I want each task in a batch to land independently, so that one bad sibling does not roll back successful work.
17. As a Hub user, I want independent siblings to continue after one task is blocked, so that a single semantic problem does not stop the run.
18. As a Hub user, I want dependent siblings to wait when their prerequisite cannot land, so that dependency semantics remain correct.
19. As a Hub user, I want mixed batch outcomes to report `partial_failed`, so that the summary represents both shipped and blocked tasks accurately.
20. As a Hub user, I want Git conflicts to be resolved automatically when possible, so that routine overlap does not require intervention.
21. As a Hub user, I want conflict repair to be bounded, so that an unresolvable task cannot consume Agents forever.
22. As a Hub user, I want verification failures to receive bounded automatic repair, so that fixable integration regressions remain unattended.
23. As a Hub user, I want unverified candidates never to land, so that automation does not trade safety for apparent progress.
24. As a Hub user, I want semantic repair exhaustion to block only the affected task with a precise reason, so that I can inspect the real problem later.
25. As a Hub user, I want transient I/O, lock, and network errors to remain durable pending work, so that infrastructure failures do not become false semantic failures.
26. As a Hub user, I want target drift to rebuild and reverify candidates automatically, so that landed code is always the exact tree that passed verification.
27. As a Hub user, I want repeated target churn to avoid busy loops, so that external commits cannot cause unbounded CPU or Agent spend.
28. As a Hub user, I want the oldest ready transaction to retain queue priority during churn, so that new tasks cannot starve older work.
29. As a Hub user, I want my committed changes on the configured host target branch to enter the canonical target automatically, so that Hub does not ignore normal human Git commits.
30. As a Hub user, I want uncommitted host changes excluded from canonical reconciliation, so that only deliberate commits become shared inputs.
31. As a Hub user, I want candidate construction and verification to run concurrently where safe, so that correctness does not force fully serial task execution.
32. As a Hub user, I want landing itself to use OID compare-and-swap, so that two coordinators cannot overwrite each other's work.
33. As a Hub user, I want stale coordinators fenced from landing, so that a paused process cannot publish an obsolete candidate after ownership changes.
34. As a Hub user, I want crash recovery to use Git refs, receipts, artifacts, remote ancestry, and task metadata, so that UI events are not mistaken for durable proof.
35. As a Hub user, I want a crash after candidate creation to reuse the exact candidate, so that integration is not repeated unnecessarily.
36. As a Hub user, I want a crash after verification to reuse a valid verification artifact bound to the exact candidate and verifier fingerprint.
37. As a Hub user, I want a crash after local CAS to reconstruct landing from an atomic receipt, so that the task is not merged twice.
38. As a Hub user, I want a crash after remote push to reconstruct publication from remote ancestry, so that unknown push outcomes do not cause duplicate publication.
39. As a Hub user, I want a crash after Beads closure to reconstruct closure from transaction metadata, so that closing a task is idempotent.
40. As a Hub user, I want cleanup to be independently retryable, so that branch or worktree cleanup cannot roll back shipped work.
41. As an existing user, I want old `merge_succeeded` events treated cautiously, so that pre-upgrade events cannot falsely prove landing.
42. As an existing user, I want already closed historical tasks to remain closed, so that the upgrade does not reopen completed work.
43. As an existing user, I want ambiguous legacy in-flight work surfaced for inspection rather than silently closed or reimplemented.
44. As a Hub user, I want normal landing, publication, closure, checkout, and task-store pending states to recover without `archloop tasks recover`.
45. As an operator, I want `tasks doctor` to remain a read-only diagnostic surface, so that observing state does not trigger hidden reconciliation.
46. As an operator, I want transaction journals and receipts under the stable Hub project directory, so that project rename or path movement does not split recovery state.
47. As a Beads user, I want the live task database outside the code repository, so that runtime/export files cannot participate in code merge conflicts.
48. As a Beads user, I want direct host `bd ready` and `bd show` to continue working, so that external Beads workflows remain convenient.
49. As an existing Beads user, I want task-store migration to happen automatically on first use, so that I do not need a migration command.
50. As an existing Beads user, I want an active external `bd` writer to defer migration rather than block my run, so that compatibility is safe and non-disruptive.
51. As an existing Beads user, I want migration to resume after a process crash, so that a partial move cannot strand the task store.
52. As an existing Beads user, I want the original task database retained as a backup in the first release, so that migration is recoverable.
53. As an existing Beads user, I want cross-filesystem migration to copy only a quarantined cold database, so that the destination is consistent.
54. As an operator, I want split-brain task-store detection to stop automatic writes, so that two independently modified databases are never silently combined.
55. As a Hub user, I want execution Agents to receive only the selected task context, so that an Agent cannot mutate unrelated task state.
56. As a Hub user, I want Agent notes applied by Hub orchestration, so that useful feedback survives without granting task-store write access.
57. As a maintainer, I want immutable task snapshots to exclude credentials and unrelated tasks, so that external Agent providers receive minimal context.
58. As a maintainer, I want legacy task branches containing known Beads runtime/export paths to keep their code changes, so that migration does not require branch surgery.
59. As a maintainer, I want Beads configuration or intentionally tracked documentation changes reviewed normally, so that runtime filtering does not silently delete real source changes.
60. As a maintainer, I want all user-visible landing events to carry transaction and commit identities, so that logs can be correlated with durable state.
61. As a maintainer, I want `integration_candidate_created` to be distinct from `target_landing_succeeded`, so that integration is never reported as delivery.
62. As a maintainer, I want `shipped` to be a derived proof, so that no single mutable status or event can claim completion incorrectly.
63. As a maintainer, I want every side-effect boundary covered by restart fault injection, so that crash recovery is continuously verified.
64. As a maintainer, I want two runs targeting the same project to be deterministic and idempotent, so that concurrent automation cannot duplicate work.
65. As a maintainer, I want target ABA and stale-owner scenarios tested, so that OID CAS is not assumed to provide fencing by itself.
66. As a maintainer, I want required remote publication serialized per remote ref, so that task delivery order remains meaningful.
67. As a maintainer, I want remote force rewrites after an ambiguous successful push reported as integrity incidents, so that lost publication proof is never hidden as normal drift.
68. As a maintainer, I want the programmatic `run()` branch-strategy API to keep its existing target-branch semantics, so that the Hub redesign does not silently change library callers.
69. As a CLI user, I want project landing policy stored in Hub-owned project state, so that configuring delivery does not dirty the code repository.
70. As a CLI user, I want project configuration to expose target branch, optional remote, and publish policy explicitly, so that delivery behavior is auditable.

## Implementation Decisions

- Build a **Hub project landing policy** module that owns the pinned host target branch, stable Hub publish target identity, optional explicit remote target, publish policy (`off`, `best_effort`, or `required`), and safe checkout-sync policy. Existing projects pin the branch active on first upgraded Hub run to preserve current behavior and default to publication off. The policy lives in the stable Hub project directory, not in the code repository.
- Build a **landing transaction store** as a deep module with append/reduce semantics, stable transaction ids, atomic writes, fsync boundaries, and exact Git OIDs. The durable checkpoints are opened, base pinned, candidate created, candidate verified, local target staged/landed, optional remote published, task closed, and cleaned. Display events are derived projections and are never the source of recovery truth.
- Build a **landing coordinator** per Hub publish target. It assigns durable FIFO/dependency tickets, freezes task source OIDs, reconciles committed host-target contributions, creates a bounded speculative candidate chain, schedules exact-OID verification in parallel, and serializes target advancement. Expensive merge, Agent repair, and verification work never holds the short landing lease.
- Represent the default authoritative target with an archLoop-owned local ref namespace keyed by stable project/target identity. The configured host branch remains a committed contribution source and checkout projection, not the transaction's mutable authority. Before candidate construction and landing, committed host changes are merged into the canonical chain and fully verified; uncommitted state is never imported.
- Create each merge candidate in a Hub-owned detached worktree from a pinned predecessor OID and frozen source OID. Candidate refs and manifests are deterministic recovery anchors. A bounded speculative chain uses the previous candidate as the next candidate's base; candidates do not all verify against the same stale target snapshot.
- Bind every verification artifact to the exact candidate OID, verification script/configuration hash, runtime fingerprint, exit result, and output artifact hash. A valid fsynced artifact can reconstruct a missing verification checkpoint; otherwise verification reruns.
- Give semantic Git conflicts at most two merge-role Agent repairs per transaction. Give verification failure at most two candidate-repair Agent attempts. Every repair produces a new candidate generation and triggers full verification. Repair counts do not reset merely because the target drifted.
- When a predecessor changes or fails, invalidate its speculative suffix. Rebuild and reverify independent successors against the new predecessor; keep dependent tasks blocked until their prerequisite satisfies the configured shipped proof.
- Give each queue-head activation at most three immediate target-drift rebuilds with jittered backoff. After that, retain its FIFO ticket and enter `target_quiet_wait`; later transactions cannot overtake it. A stable window starts a new activation. This avoids internal starvation while acknowledging that a continuously modified external target cannot guarantee a completion deadline.
- Implement the landing lease with owner nonce, PID start identity, and boot identity. Do not steal a lease from a live owner merely because a TTL elapsed. Use a Git fence ref and update the fence, Hub publish target, and per-transaction landing receipt in one `git update-ref --stdin` transaction that verifies the expected target and fence OIDs. A file epoch alone is diagnostic, not fencing.
- Derive `shipped` from evidence. Under `off` and `best_effort`, the exact verified candidate must be in the Hub publish target and the Beads task must be closed with matching transaction/OID metadata. Under `required`, matching remote-publication proof is also required. Checkout sync, best-effort publication, and cleanup never affect shipped.
- Rename success events to describe actual milestones: integration candidate created, candidate verification passed, target landing succeeded, target publish succeeded, and task close succeeded. Each carries the transaction id and relevant OIDs. Stop emitting ambiguous `merge_succeeded` for integration-only progress.
- Replace batch fail-fast behavior with independent per-task outcomes. A task failure does not skip independent siblings. The batch is an orchestration and summary boundary, not a Git transaction boundary.
- Treat semantic repair exhaustion as `blocked` with a reason such as `merge_conflict_unresolved` or `verification_failed`. Treat locks, I/O, target churn, publication, closure, checkout projection, cleanup, and migration as durable pending conditions with automatic retry. Normal pending work never directs the user to `tasks recover`.
- Build a **transaction reconciler** that runs at safe mutating entry points such as run startup and run completion. It reconstructs missing checkpoints from candidate refs/manifests, verification artifacts, atomic landing receipts, remote ancestry, Beads transaction metadata, and resource absence. Read-only commands display reconciliation state but do not mutate it.
- Import legacy in-flight history only when Git ancestry proves the task branch reached the configured target. A legacy `merge_succeeded` event alone is never proof because earlier versions emitted it before verification/final landing. Already closed historical tasks remain grandfathered as completed; ambiguous in-flight history becomes an explicit legacy integrity condition rather than automatic close or reimplementation.
- Build a **remote publication outbox** separate from GitHub task sync. Items are idempotently keyed by transaction, remote, ref, candidate OID, and expected remote OID. Remote publication uses observation plus exact lease semantics, never unqualified force push. Unknown push outcomes are observed before retry; candidate ancestry at the current remote tip proves a completed publication.
- For required publication, serialize both publication and local target progression per remote ref: a successor may build and verify, but it cannot advance the local delivery sequence past an unacknowledged required predecessor. A remote integrity incident cannot be silently converted into ordinary drift.
- Default runs in required mode drive publication until the configured delivery timeout. If still pending, return a distinct completed-with-pending-delivery outcome and non-zero exit code without marking the task failed. Off and best-effort modes exit successfully after the local shipped proof; pending best-effort code publication is a warning.
- Build a **checkout projection outbox** independent of landing. An un-checked-out local branch can move via OID CAS. A checked-out branch may fast-forward only in its owning worktree when Git safety checks prove the index, working tree, operation state, untracked paths, sparse checkout, submodules, and other worktrees safe. Otherwise retain `checkout_sync_pending`. Never stash, replay, auto-commit WIP, switch branches, or run user hooks in background projection.
- Build a **Hub task-store resolver** that supports legacy repository-local, Hub-managed, and redirect-to-managed states. All Hub Beads invocations receive an explicit managed task-store location once migration is verified.
- Build a **task-store migration transaction** with a dedicated lease and journal. Its phases are legacy active, snapshot prepared, legacy quarantined, managed copied, redirect installed, and verified. Cross-filesystem copies operate only on the quarantined cold database. The switch is accepted only after Beads location/health, database identity, prefix/schema, task ids/counts, dependencies/comments summary, and working state are verified.
- If an external Beads writer or source-generation change is detected before quarantine, keep the verified legacy store active and mark migration pending. If both legacy and managed stores are modified after redirect, stop automatic task-store writes and report a split-brain integrity incident. The first release retains migration backups.
- Install the official Git-ignored `.beads/redirect` so direct host `bd` commands discover the managed store. Preserve existing tracked Beads configuration/documentation instead of manufacturing repository deletions. Compatibility is guaranteed for the host and archLoop-managed sandboxes, not arbitrary third-party containers that cannot access host paths.
- Build an **immutable task snapshot** module that supplies only the selected task, parent PRD, dependencies, comments, acceptance criteria, and required remote refs. Snapshot directories/files use restrictive permissions and reject symlink replacement. Agents receive a read-only mount or prompt content and return structured notes for Hub to apply; they do not write the live task store.
- Define an exact allowlist of Beads runtime/export paths that are excluded from legacy merge candidates and recorded in transaction diagnostics. Do not classify every `.beads/` path as disposable: configuration, documentation, hooks, or other intentional tracked content remains normal source change.
- Keep the existing programmatic `run()` target-branch and branch-strategy behavior outside Hub flows. The managed landing plane is a Hub orchestration capability, not an implicit rewrite of the public library API.

## Testing Decisions

- Tests must assert externally observable safety and durable proof, not private class structure. The core invariant is that only the exact verified candidate can satisfy landing and shipped, while the user's checkout, index, HEAD, staged entries, untracked files, and WIP remain unchanged unless a separately proven safe projection succeeds.
- Add characterization coverage for the original staged `.beads/issues.jsonl` failure using the real Git merger path. The task code must land, the staged Beads entry must remain byte-for-byte and index-identical, and no recovery command may be required.
- Test the landing transaction store and reducer with truncated journal tails, duplicate records, stable event replay, atomic receipt reconstruction, and invalid/mismatched OIDs.
- Add fault injection immediately before and immediately after each side effect but before its checkpoint/event: candidate ref creation, conflict-repair ref update, verification artifact write, atomic target/receipt/fence update, remote push, Beads close, cleanup, checkout projection, and every task-store migration boundary. Restart must produce at most one landing and one close.
- Test two transactions for the same target, two runs for the same task, paused stale owners, dead owners, PID reuse, fence replacement, target ABA, compare-and-swap failure, and stale candidates after repair.
- Test ordered speculative chains with parallel verification, predecessor repair, predecessor failure, independent suffix rebuild, dependency blocking, and partial batch success.
- Test more than three consecutive target changes: the oldest ticket must enter quiet-wait without dropping queue position, later tickets must not overtake it, and a subsequent stable window must resume automatically.
- Test host target reconciliation for behind, descendant, and diverged committed tips. Verify that committed human work is included and uncommitted work is neither imported nor modified.
- Test both semantic-repair budgets, candidate-generation invalidation, verifier-fingerprint changes, and the rule that an unverified or stale verification artifact cannot land.
- Test publication off, best-effort, and required. Cover exact remote CAS, unknown successful push, remote tip advancing after publication, remote divergence before push, force rewrite after ambiguous success, protected-branch rejection, credential expiry, strict required ordering, timeout outcome, and exit codes.
- Test task closure after local landing, close success before checkpoint, close retry, matching transaction metadata, legacy done without proof, and dependency readiness only after the configured shipped proof.
- Test checkout projection for clean fast-forward, dirty non-overlap, dirty overlap, staged/unstaged changes, untracked collision, rename/delete, merge/rebase/cherry-pick/bisect state, submodules, sparse checkout, multiple worktrees, branch divergence, hook suppression, and indefinitely pending WIP.
- Test task-store resolution in legacy, managed, and redirect states. Cover active external writer, source fingerprint change, same- and cross-filesystem migration, quarantine crash, copy crash, redirect crash, invalid redirect, database health mismatch, split brain, permissions, and retained backups.
- Test direct host `bd` compatibility after redirect and explicit managed task-store injection in every archLoop-created worktree/sandbox. Test that execution Agents cannot mutate the live store and receive only the selected immutable task snapshot.
- Test runtime/export filtering with an allowlisted legacy JSONL change plus normal code, and separately test intentional Beads config/documentation changes to ensure they are not silently discarded.
- Test legacy event import: `merge_succeeded` without ancestry cannot close a task; ancestry-proven branches can enter a new verified transaction; already closed history remains closed; missing ambiguous branches are surfaced without reimplementation.
- Extend plain, JSON, and terminal projections to test distinct candidate, verified, local target, publication, closure, checkout pending, migration pending, quiet-wait, and integrity-incident states. Avoid tests that depend on spinner timing or private storage filenames.
- Run `npm run typecheck` as the required type check, plus focused Vitest suites for deep modules and real-Git integration tests for OID/ref/worktree behavior.

## Out of Scope

- Guaranteeing that every semantic code conflict or failing test can be repaired automatically.
- Touching, stashing, replaying, committing, discarding, or switching the user's uncommitted checkout state.
- Treating arbitrary third-party containers as able to follow a host-absolute Beads redirect.
- Automatically enabling remote publication from a detected Git remote.
- Force-overwriting a diverged remote ref or bypassing protected-branch policy.
- Providing distributed multi-host landing coordination without a shared atomic coordination backend. The first implementation may use one local coordinator plus Git fencing.
- Replacing Beads as the Hub task store or merging two independently modified split-brain Beads databases automatically.
- Changing the programmatic `run()`, `interactive()`, `createSandbox()`, `createWorktree()`, or branch-strategy API contracts.
- Removing explicit recovery/doctor commands for historical, non-landing maintenance. They cease to be the normal path for managed landing transactions.

## Further Notes

- The immediate bug tracked in GitHub issue #120 is a P0 compatibility slice of this PRD, not the complete solution. A narrow conditional clean-worktree fix prevents the observed failure but does not establish durable landing, correct event semantics, or crash recovery.
- The authoritative local target avoids mandatory remote coupling. The configured host branch remains important as a committed contribution source and user-visible projection; archLoop must reconcile its commits instead of silently treating it as read-only.
- The design intentionally separates five transactions: landing, task closure, remote code publication, checkout projection, and task-store migration. A later transaction may be pending without falsifying or rolling back the durable evidence of an earlier one.
- This PRD supersedes the recovery assumption that a historical `merge_succeeded` event alone proves delivery. Durable proof is based on OIDs, artifacts, receipts, ancestry, and task metadata.
