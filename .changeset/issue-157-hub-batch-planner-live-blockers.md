---
"@yibeibankaishui/archloop": patch
---

Hub batch planner candidates now resolve mixed `## Blocked by` refs from task descriptions, including GitHub issue numbers, GitHub issue URLs, and Beads ids, into live `blockersResolved`, `openBlockers`, and `unknownBlockers` fields before planning.
