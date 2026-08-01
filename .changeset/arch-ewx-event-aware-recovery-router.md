---
"@yibeibankaishui/archloop": patch
---

Add a pure event-aware recovery router that decides where an interrupted Hub task (`implementing` / `reviewing` / `merging`) should resume. The router consults the task's latest phase-completion event (`task_review_succeeded` → `waiting_for_merge`; `task_implementation_succeeded` with status `reviewing` → `reviewing`; review-less `waiting_for_merge` → `waiting_for_merge`) and preserves the claim for those routes, or retries from `ready_for_agent` (dropping the claim) when no success event fired. It is a filesystem- and board-free decision table with an exhaustive test suite, intended as the single source of truth that `recoverStaleExecutionStatus` and `tasks recover --stale` will call in a follow-up.
