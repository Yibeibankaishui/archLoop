---
"@yibeibankaishui/archloop": patch
---

Document `archloop run` startup auto-recovery of interrupted tasks, and fix the hubProjectDir phase-completion event resolver.

The child slices already shipped the detector, event-aware router, `tasks recover --stale`, doctor `interrupted_execution`, list badge, and run-startup auto-recover (ADR-0034). Docs still described re-running as only resuming `waiting_for_merge` batches and still claimed failed/stale states were never automatically modified. Align README / skill / user guides / roadmap with the shipped behavior.

Also fix `createHubProjectDirPhaseCompletionEventResolver`: it called a nonexistent `readPhaseCompletionEventsByTask` symbol (typecheck failure; would throw at runtime). It now uses the shared `readTaskEvents` + `latestPhaseCompletionEventByTask` path, matching the default resolver, so run-startup auto-recover reads the same event log the run writes.
