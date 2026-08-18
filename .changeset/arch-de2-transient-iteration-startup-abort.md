---
"@yibeibankaishui/archloop": patch
---

Keep a multi-iteration run alive when a later iteration aborts during provider startup with no agent output, and nudge the next turn to implement after an exploration-only iteration. Exhausting the iteration limit with no completion signal and no commits is still `agent_failed`; the already-merged zero-commit judgment and `acceptRecoverableExit` path are unchanged.
