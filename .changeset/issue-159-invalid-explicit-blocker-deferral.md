---
"@yibeibankaishui/archloop": patch
---

Hub batch planning now rejects false `explicit_blocker` deferrals when a candidate has no live blockers and no dependency on a selected task, recovers the safe task up to `maxTasks`, and records `invalid_explicit_blocker_deferral` in batch diagnostics.
