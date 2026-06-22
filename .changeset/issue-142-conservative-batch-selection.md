---
"@yibeibankaishui/archloop": patch
---

Add conservative task-board batch selection for Hub flows. `archloop run . --flow no-review|with-review --batch-strategy conservative` selects at most one eligible `ready_for_agent` task, validates `--max-tasks` (1–10), rejects those options on proposal flows, and records batch strategy metadata in Hub run events and flow output.
