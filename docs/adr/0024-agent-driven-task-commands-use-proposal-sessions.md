# Agent-driven task commands use proposal sessions

**Judgment-producing task commands** such as PRD decomposition and task triage are **agent-driven task commands**. They run as **proposal flows** and use interactive **proposal sessions** by default: Sandcastle prepares the required context, invokes an **agent**, lets the user refine a human-readable proposal, asks the agent to emit a final schema-validated **task proposal**, then validates and applies the approved proposal to the **local task store**.

The command remains a user-friendly shortcut, for example `sandcastle tasks from-prd <prd-ref>` or `sandcastle tasks triage`, but the judgment-producing work belongs to a **flow**. Sandcastle owns validation, confirmation, run artifacts, and Beads writes. The agent owns semantic judgment and final structured proposal generation. Sandcastle must not infer task proposal JSON from natural-language discussion.

Non-interactive or `--yes` mode uses a one-shot final proposal path, but still invokes the agent, validates **structured output**, and applies the same write gates.

## Considered Options

1. **Keep deterministic task commands** -- rejected because PRD decomposition and triage depend on semantic judgment, iteration with the user, and project context.
2. **Call user-local skills such as `$to-issues` or `$triage` directly** -- rejected because Hub flows must be Sandcastle-owned, packaged, versioned behavior rather than depending on host-local skill paths.
3. **Let the agent write Beads directly** -- rejected because global task state transitions belong to Sandcastle orchestration, not the agent.
4. **Use agent-driven proposal sessions** -- chosen because it preserves the conversational skill experience while keeping Hub validation and persistence deterministic.
