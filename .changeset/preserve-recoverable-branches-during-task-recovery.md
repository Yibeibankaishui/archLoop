---
"@yibeibankaishui/archloop": patch
---

`archloop tasks recover` now preserves failed task branches that still have unmerged work for retry, and it performs best-effort non-force cleanup of safe Hub-managed empty branches only when recovery returns the task to a collaboration state. Active worktree leases, checked-out worktrees, dirty preserved worktrees, and preexisting branch ownership block deletion with recovery diagnostics.
