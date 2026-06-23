---
"@yibeibankaishui/archloop": patch
---

Hub batch planner candidates now strip description-derived blocker prose from
planner payloads, and the bundled no-review/with-review batch planner prompts
treat empty `openBlockers` plus `unknownBlockers` as the unblocked signal.
