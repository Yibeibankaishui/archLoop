---
"@yibeibankaishui/archloop": patch
---

Fix `isHubTaskClaimActive` so reviewing, waiting_for_merge, and merging are treated as active claims, not just `implementing`. A task mid-flight in any execution-phase status (implement → review → waiting-for-merge → merge) holds its original claim, so `claimHubTask` now correctly skips re-claiming a task that is already reviewing or merging instead of overwriting its in-flight claim, and `resolveHubTaskClaimState` reports those claims as `active` rather than `stale`. This keeps `isHubFlowEligibleTask`, the fresh-validation `active_claim` fallback, worktree-lease diagnostics, and `archloop tasks doctor`/`recover` consistent with the execution-phase claim sets already used elsewhere (`CLAIM_PRESERVING_STATUSES` / `CLAIM_REQUIRED_STATUSES` / `STALE_EXECUTION_STATUSES`).
