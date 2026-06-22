---
"@yibeibankaishui/archloop": patch
---

Add limited task-board batch selection for Hub flows. `archloop run . --flow no-review|with-review --batch-strategy limited --max-tasks N` selects up to N eligible `ready_for_agent` tasks in `bd ready` queue order (not task id order), skips active claims, and records batch strategy metadata in Hub run events and flow output.
