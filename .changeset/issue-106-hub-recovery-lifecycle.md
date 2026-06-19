---
"@ai-hero/sandcastle": patch
---

Route Hub task recovery state changes through the Hub task lifecycle module. Recovery keeps path selection; lifecycle owns claim/failure metadata cleanup, status persistence, and close-failed completion. Closing a Hub task now clears stale claim metadata.
