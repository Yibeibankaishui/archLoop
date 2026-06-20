# Hub keeps Beads runtime files out of code branch merges

**Sandcastle Hub** treats Beads files under `.beads/` as **local task store** runtime/export state, not ordinary code owned by task branches. Hub flows may read and write the local task store while planning, claiming, recovering, or closing tasks, but batch merge must not require `.beads/issues.jsonl`, `.beads/interactions.jsonl`, or related `.beads/` files to be clean before normal source branches can merge.

## Decision

Hub batch merge preflight classifies dirty worktree files into source files and task-store/runtime files. Dirty source files block merge with an actionable summary. Dirty `.beads/` files in the source worktree are reported separately and do not block by themselves.

Task branches are different: if a branch diff includes `.beads/` runtime/export files, Hub blocks that branch before merge. Task state exchange with remote systems must flow through explicit `sandcastle tasks pull`, `sandcastle tasks push`, or confirmed `sandcastle tasks sync`, not through ordinary code branch merges.

## Considered Options

1. **Require a fully clean worktree before Hub batch merge** -- rejected because Hub task-board writes can update Beads local state as part of the same flow, making `.beads/` dirtiness an implementation detail rather than a source-code conflict.
2. **Let task branches merge `.beads/` files normally** -- rejected because it couples local task-store history to code branches and can overwrite unrelated Beads state from other agents or sync sessions.
3. **Classify source dirtiness and Beads runtime/export dirtiness separately** -- chosen because it keeps source merges safe while preserving Beads as the Hub-local task store.
