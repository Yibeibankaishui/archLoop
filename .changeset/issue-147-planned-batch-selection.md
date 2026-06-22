---
"@yibeibankaishui/archloop": patch
---

Add planned Hub flow batch selection. `archloop run . --flow no-review|with-review --batch-strategy planned` enriches ready_for_agent candidates with blocker context, runs the flow-owned batch planner before claim, validates planner output, records deferred reasons and fallback metadata in Hub run events, and falls back to conservative selection when the planner fails or returns invalid output.
