# Hub-wide agent roles configure flow stages

**Hub agent config** is **Sandcastle Hub**-wide, not project-scoped. It configures reusable **Hub agent roles** such as `planning`, `triage`, `implementation`, `review`, `merge`, and `recovery`. Each role selects an **agent provider**, model, and provider-specific options for stages inside **flows**.

Flow definitions map their internal stages to Hub agent roles. For example, `prd-decomposition` uses `planning`, `triage` uses `triage`, and implementation flows use `implementation`, `review`, and `merge` as appropriate. The first version exposes role-level CLI commands such as show, path, and set-role. It does not expose project-specific or flow/stage-specific override commands.

Hub agent config stores provider/model/options only. Credentials and login state remain separate in the **Hub env file**, **Hub auth directory**, process environment, or provider-specific auth stores. Flow execution performs provider readiness checks before invoking an agent.

## Considered Options

1. **Use one default agent config for everything** -- rejected because planning, triage, implementation, review, and merge have different model and effort needs.
2. **Store agent config per Hub project** -- rejected because the user wants consistent provider/model policy across all projects.
3. **Expose per-flow and per-stage overrides in v1** -- rejected because it prematurely adds precedence rules and complicates GUI and CLI configuration.
4. **Use Hub-wide stage roles** -- chosen because it captures stable user preferences while keeping the first configuration surface small and GUI-ready.
