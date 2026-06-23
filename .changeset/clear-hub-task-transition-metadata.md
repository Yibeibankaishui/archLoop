---
"@yibeibankaishui/archloop": patch
---

Clear stale Hub task metadata with explicit Beads unset operations so task close, failure, and recovery transitions do not leave old claim, done, or failure fields behind.
