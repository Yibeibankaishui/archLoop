# Hub flows own their prompts

`archloop run <project> --flow <id>` uses prompts owned by the selected **flow**, not prompt files scaffolded by `archloop init` into the project's config directory. The existing scaffolded `main.mts` path remains fully supported for users who want to run or customize init-generated prompts, while Hub flows provide a separate runtime-selectable path whose behavior is not tied to whichever scaffold template was chosen earlier.

## Considered Options

1. **Reuse scaffolded project prompts** -- rejected because changing flows at runtime would still depend on the project's previous init template and any local prompt edits.
2. **Let flows own their prompts** -- chosen because it keeps the legacy scaffolded path compatible while making Hub flow selection predictable.
