---
"@yibeibankaishui/archloop": patch
---

Parallel planner templates now derive issue branch names deterministically as
`archloop/issue-{id}` in `main.mts`, ignoring any title-derived slug the
planner LLM may emit. This prevents multi-iteration slug drift from leaving
orphan worktrees and surfacing `spawn sh ENOENT` when createSandbox reuses a
stale worktree path.
