# Hub task statuses

> Amended by [ADR-0035](./0035-hub-landing-uses-durable-fenced-transactions.md). Required code publication adds `publishing`, and `done`/`shipped` are derived from durable landing evidence rather than an ambiguous merge event.

**archLoop Hub** task board uses these canonical task statuses: `inbox`, `needs_info`, `ready_for_agent`, `ready_for_human`, `blocked`, `implementing`, `reviewing`, `waiting_for_merge`, `merging`, `publishing`, `done`, `wontfix`, `failed`, and `sync_conflict`. Transaction conditions such as target quiet-wait, task-close pending, checkout-sync pending, cleanup pending, and best-effort publication pending are not additional task statuses.

`blocked` and `failed` carry reason fields instead of expanding into separate statuses. Execution statuses such as `implementing`, `reviewing`, `waiting_for_merge`, `merging`, and `publishing` are driven by Hub transaction checkpoints and their event projection, not by normal task edits. `done` means the exact verified candidate satisfied the configured landing/publication proof and the local Beads task was closed with matching transaction metadata. Remote task sync, best-effort code publication, checkout synchronization, and cleanup may still be pending.

**Flow batch** statuses are `planning`, `implementing`, `reviewing`, `waiting_for_merge`, `merging`, `done`, `partial_failed`, and `failed`. `planning` is a batch status only, not a task status.

**Hub run** statuses are `starting`, `running`, `completed`, `completed_with_failures`, `failed`, and `cancelled`.
