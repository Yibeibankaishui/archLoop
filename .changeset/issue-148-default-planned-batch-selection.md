---
"@yibeibankaishui/archloop": patch
---

Task-board Hub flows (`no-review`, `with-review`) now default to `planned` batch selection with a maximum of 3 tasks. `ready_for_agent` remains the candidate pool; only the selected batch is claimed. Override with `--batch-strategy` (`planned`, `limited`, `conservative`) and `--max-tasks` (1–10). Until the flow-owned planner is wired, `planned` falls back to conservative selection and records `planner_unavailable` in batch events and CLI output.
