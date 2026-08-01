---
"@yibeibankaishui/archloop": patch
---

Derive Hub flow implementer success from observed branch commits plus the completion signal, so a trailing non-zero provider exit no longer marks finished work as `agent_failed` with `commitCount: 0`.
