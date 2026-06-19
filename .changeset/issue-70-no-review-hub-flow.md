---
"@ai-hero/sandcastle": patch
---

Add the first Hub flow (`sandcastle run . --flow no-review`) that reads the Beads ready queue, claims tasks, runs bundled Hub implementer prompts, and advances successful work to `waiting_for_merge`.
