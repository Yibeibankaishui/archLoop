---
"@yibeibankaishui/archloop": patch
---

`archloop tasks list` now surfaces tasks in `blocked`, `failed`, or `sync_conflict` state under a new red `! attention · N` badge and group, instead of silently routing them into the `todo` bucket. The bucket only appears when at least one task needs attention — a healthy board still reads as `● todo · ◐ in_progress · ✓ done`. When the attention bucket holds only a single kind of trouble, the badge and group render the specific label (`! 1 blocked`, `✗ 2 failed`, `! 1 sync_conflict`, `! 1 needs_info`) so the user sees the actual state at a glance; the generic `attention` label reappears only when several trouble kinds coexist. Fixes the visibility gap where a task in `blocked` state showed up next to real todo work with no visual cue that it needed human intervention.
