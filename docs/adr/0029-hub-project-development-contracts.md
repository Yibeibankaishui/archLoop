# Hub projects own development contracts

**archLoop Hub** stores a **project profile** in each **Hub project config** and uses it, along with observed **project facts** and user edits, to derive a persistent **project development contract**. The contract lives in **Hub project assets** and is consumed by **flows** for setup, verification, context, and diagnostics; `archloop project configure` creates or updates it, while `archloop run <project> --flow <id>` consumes it and creates a generic contract when none exists.

This keeps Hub's multi-project model explicit: different repos can carry different language and build-system priors without requiring `archloop init` or depending on repo-local `.archloop/` scaffold files. `run --flow` does not accept a one-off project-profile override in the first version, and low-level runtime APIs such as `run()`, `createSandbox()`, and sandbox providers still do not expose project profile options.

## Considered Options

1. **Keep project profiles init-only** -- rejected because Hub manages multiple projects whose flows need durable project-specific development priors.
2. **Inject project profile directly into flow prompts** -- rejected because prompts are only one carrier; setup, verification, context, and diagnostics need a visible, editable contract.
3. **Let `run --flow` mutate repo-local project files** -- rejected because ordinary flow execution should consume Hub-owned configuration rather than silently rewriting application repos or `.archloop/` scaffolds.
