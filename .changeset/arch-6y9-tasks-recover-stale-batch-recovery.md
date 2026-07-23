---
"@yibeibankaishui/archloop": patch
---

Add `archloop tasks recover --stale` for batch recovery of every interrupted-execution task on the board in one command, with a dry-run preview by default.

With `--stale`, `tasks recover` loads the task board, worktree leases, and run event log; runs the shared interrupted-execution detector; and routes each interrupted task (`implementing` / `reviewing` / `merging` with no live worktree lease) through the event-aware recovery router — the same routing the per-task path uses, so a finished phase is never redone. By default it prints a dry-run preview of the planned routing per task (prior status -> target, claim preserved or released, and the reason); it applies the recovery only when `--yes` is passed (or confirmed interactively), mirroring the existing `tasks repair-state` confirmation pattern. The per-task `tasks recover <id>` form is unchanged.
