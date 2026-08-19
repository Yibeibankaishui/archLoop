---
"@yibeibankaishui/archloop": patch
---

Keep successful current Hub batches successful when stale landing integrity evidence is present. Surface the incident as a structured non-fatal warning (evidence, next action, `affectsCurrentBatch: false`) in plain, JSON, and live output without changing completed-task counts or `stopReason`.
