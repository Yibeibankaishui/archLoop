---
"@yibeibankaishui/archloop": patch
---

`archloop tasks list` now surfaces tasks in `blocked`, `failed`, or `sync_conflict` state under a new red `! attention · N` badge and group, instead of silently routing them into the `todo` bucket. The bucket only appears when at least one task needs attention — a healthy board still reads as `● todo · ◐ in_progress · ✓ done`. Fixes the visibility gap where `arch-qz9` in `blocked` state showed up next to real todo work with no visual cue that it needed human intervention.
