---
"@yibeibankaishui/archloop": patch
---

Hub flows now run a batch merge phase after implementation/review: eligible `waiting_for_merge` tasks move to `merging` together, emit per-task merge/verification/close events, verify after each merge, and reach `done` only after local Beads close succeeds. Failures stop the batch and mark it `partial_failed`.
