---
"@yibeibankaishui/archloop": patch
---

Add a pure interrupted-execution detector predicate that decides whether a Hub task is an interrupted execution (`implementing` / `reviewing` / `merging` hub status with no live worktree lease for its branch). The detector returns whether the task is interrupted and, if so, which phase it is stuck in. It deliberately does not rely on `claimState` alone, because `claimState` misclassifies `reviewing` / `merging` as stale even mid-legitimate-execution; a live worktree lease is the authoritative proof that an execution is still running. It is a filesystem- and board-free predicate (the caller resolves the lease via `listWorktreeLeases` and the existing task-to-lease matching) with an exhaustive test suite, intended as the shared source of truth that the `archloop run` startup scan, `tasks doctor`, and the `tasks list` badge will call in follow-up tasks.
