---
"@ai-hero/sandcastle": patch
---

Non-blank workflow templates scaffold `sandbox.onSandboxReady` bootstrap hooks with a 5-minute `timeoutMs` so dependency installs are not cut off by the generic 60 s hook default.
