---
"@ai-hero/sandcastle": patch
---

Implement agent-driven triage proposal flow. `sandcastle tasks triage` now runs the agent-driven proposal flow instead of deterministic classification: pass a task id, use interactive multi-select with an "all" option, filter with `--query`, or triage all inbox and needs_info tasks with `--yes`. Wontfix, dependency changes, and medium/low confidence decisions require per-decision confirmation even under `--yes`; applied comments include the AI triage disclaimer. `sandcastle run . --flow triage --input <id|statuses>` executes the flow end-to-end.
