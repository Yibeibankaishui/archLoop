---
"@yibeibankaishui/archloop": patch
---

Add one-shot worktree leases for non-head `run()` and `interactive()` execution. Non-head branch strategies acquire an exclusive file-based lease before agent use, fail fast on active conflicts, and release automatically when the call completes.
