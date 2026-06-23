---
"@yibeibankaishui/archloop": patch
---

Hold worktree leases for the lifetime of `createWorktree()` and `createSandbox()` handles. A second caller targeting the same active worktree fails fast until the handle is closed.
