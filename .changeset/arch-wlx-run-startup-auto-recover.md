---
"@yibeibankaishui/archloop": patch
---

Auto-recover and resume interrupted Hub tasks at `archloop run` startup.

When a task-board flow run is re-launched after being killed mid-execution, tasks left stuck in `implementing` / `reviewing` / `merging` with no live worktree lease are now detected and recovered automatically before the run selects its first batch, instead of silently no-opping. Each interrupted task is routed through the existing event-aware recovery wiring: a `merging` task whose review already completed resumes at `waiting_for_merge` (claim preserved) and is picked up by the resumed-batch merge path; a `reviewing` task whose implementation already completed resumes at `reviewing` (claim preserved) so the finished implementation is never re-implemented; and a task interrupted with no phase-completion event retries from `ready_for_agent` (claim released) and is re-implemented by the planner, reusing the preserved worktree when the branch already has commits. The run reports how many tasks were auto-recovered and to which phase each was routed (full summary in human output; a structured `autoRecover` count in JSON). Recovery is best-effort — a failure on one task is recorded against that task and does not abort the run — and is a no-op on repos with no readable task board.
