---
"@yibeibankaishui/archloop": patch
---

Add `archloop tasks recover <id>` to repair failed and stale Hub execution states: release stale claim metadata, move recoverable `failed` tasks back to collaboration statuses, and complete `close_failed` recovery when the branch is already merged without repeating merge. Recovery writes concise Beads comments prefixed for archLoop task recovery.
