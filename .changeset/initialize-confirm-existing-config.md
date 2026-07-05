---
"@yibeibankaishui/archloop": patch
---

Refine `archloop initialize` so reruns ask before changing complete existing Hub agent role and env settings, while still repairing missing settings through guided prompts. Hub env values equal to placeholder strings such as `undefined` or `null` are now treated as empty values for display, resolution, and readiness checks.
