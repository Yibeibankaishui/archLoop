---
"@yibeibankaishui/archloop": patch
---

Wire the event-aware recovery router into `recoverHubTask` so recovering an interrupted Hub task (`implementing` / `reviewing` / `merging`) consults the run event log instead of unconditionally resetting to `ready_for_agent`.

A task whose review already completed (`task_review_succeeded`) now resumes at `waiting_for_merge` with its claim preserved (the merge was interrupted), and a task whose implementation completed (`task_implementation_succeeded`, reviewer flow) resumes at `reviewing` with its claim preserved — finished phases are no longer redone. A task interrupted with no phase-completion event still retries from `ready_for_agent`, dropping the claim and reusing the preserved worktree when the branch already has commits. The `undefined` failure reason previously passed to `resolveFailedRecoveryTarget` is fixed to use the task's real failure reason, so the human-failure-reason override to `ready_for_human` (merge_conflict / verification_failure) can fire for stale-execution recovery rather than being bypassed.
