Finalize the approved triage recommendations as structured JSON.

Rules:

- Include one entry per approved task in `recommendations`.
- Use only task ids from the prepared context.
- `outcome` must be one of: needs_info, ready_for_agent, ready_for_human, wontfix.
- `confidence` must be one of: high, medium, low.
- `labels` is optional; include only extra labels beyond the outcome label.
- `comment` must be concise and suitable for Beads task history.
- `dependencyChanges` is optional; each entry needs action (add or remove), dependentTaskId, and blockerTaskId.
- Do not include the AI triage disclaimer in comments; Hub adds it when writing to Beads.
- Do not mutate remote GitHub issues or repository files.

Prepared context:

{{PREPARED_CONTEXT}}
