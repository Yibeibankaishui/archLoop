---
"@ai-hero/sandcastle": patch
---

Add agent auth failure guidance that steers users toward `sandcastle env init`, `sandcastle env set`, and `.sandcastle/.env` instead of agent login commands. Enrich Orchestrator AgentError messages and fail fast in Hub proposal and flow agent preflight checks.
