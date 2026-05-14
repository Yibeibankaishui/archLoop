---
"@ai-hero/sandcastle": patch
---

Add optional **preset agent roles** during `sandcastle init` (multi-select after template choice) and a non-interactive `scaffold({ presetAgentIds })` path. Copies role prompts to `.sandcastle/agents/`, bundled skills to `.sandcastle/skills/`, and writes `.sandcastle/agent-profiles.json` with recommended provider/model metadata; shared skills are copied once when multiple roles need them.
