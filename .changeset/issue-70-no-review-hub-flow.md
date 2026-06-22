---
"@yibeibankaishui/archloop": patch
---

Add the first Hub flow (`archloop run . --flow no-review`) that reads the Beads ready queue, claims tasks, runs bundled Hub implementer prompts, and advances successful work to `waiting_for_merge`.
