# Hub task statuses

**archLoop Hub** task board v1 uses these canonical task statuses: `inbox`, `needs_info`, `ready_for_agent`, `ready_for_human`, `blocked`, `implementing`, `reviewing`, `waiting_for_merge`, `merging`, `done`, `wontfix`, `failed`, and `sync_conflict`. Ambiguous or transient terms such as `pending`, `triaging`, `waiting_for_review`, `planning`, `reserved`, `claimed`, and `deferred` are not task statuses.

`blocked` and `failed` carry reason fields instead of expanding into separate statuses. Execution statuses such as `implementing`, `reviewing`, `waiting_for_merge`, and `merging` are driven by Hub flow events or recovery commands, not by normal task edits. `done` means the branch was merged, verification passed, and the local Beads task was closed; remote sync may still be pending.

**Flow batch** statuses are `planning`, `implementing`, `reviewing`, `waiting_for_merge`, `merging`, `done`, `partial_failed`, and `failed`. `planning` is a batch status only, not a task status.

**Hub run** statuses are `starting`, `running`, `completed`, `completed_with_failures`, `failed`, and `cancelled`.
