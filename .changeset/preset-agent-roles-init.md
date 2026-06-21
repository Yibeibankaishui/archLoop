---
"@yibeibankaishui/archloop": patch
---

Add optional **preset agent roles** during `archloop init` (multi-select after template choice) and a non-interactive `scaffold({ presetAgentIds })` path. Copies role prompts to `.archloop/agents/`, bundled skills to `.archloop/skills/`, and writes `.archloop/agent-profiles.json` with recommended provider/model metadata; shared skills are copied once when multiple roles need them.
