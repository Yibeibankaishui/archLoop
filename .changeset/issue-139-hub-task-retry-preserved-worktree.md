---
"@yibeibankaishui/archloop": patch
---

Make Hub task retry lease-aware: block duplicate execution when a worktree lease is active, clear stale leases before retry, reuse preserved worktrees, and inject retry context into implementer prompts.
