---
"@yibeibankaishui/archloop": patch
---

Preserve Hub flow recovery boundaries when a resumable merge-ready batch cannot be resumed cleanly. `archloop run --flow` now stops the execution with `batch_failed` instead of falling through to a fresh ready-queue scan, so stale or inconsistent merge state does not claim new work.
