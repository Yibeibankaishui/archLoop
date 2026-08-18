---
"@yibeibankaishui/archloop": patch
---

Treat a fresh Hub-managed Beads store reached through a healthy repository redirect as steady state instead of an interrupted legacy migration. First mutating task commands after `project add` with immediate task-store initialization no longer demand a missing source snapshot or leave a stranded migration lease.
