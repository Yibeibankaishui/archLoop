---
"@yibeibankaishui/archloop": patch
---

Add worktree lease stale recovery: detect dead owner processes, remove stale lease files atomically, prune orphan leases during worktree prune, and fail with recovery diagnostics on malformed lease metadata without touching worktrees.
