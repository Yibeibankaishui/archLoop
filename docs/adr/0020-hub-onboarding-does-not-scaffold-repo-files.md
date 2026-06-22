# Hub onboarding does not scaffold repo files

**archLoop Hub** project onboarding mirrors the configuration choices and setup capabilities of `archloop init`, but Hub-owned orchestration assets are stored outside the target repo in the **archLoop user data directory**. By default, Hub onboarding does not write `.archloop/`, `main.mts`, prompts, package scripts, or Hub flow assets into the repo; any repo mutation or external state change must be an explicit **Hub setup action**.

## Considered Options

1. **Reuse init scaffolding for Hub projects** -- rejected because Hub flows would inherit project-local scaffold history and conflict with runtime flow selection.
2. **Make Hub onboarding read-only** -- rejected because feature parity with init requires useful setup actions such as GitHub label creation, provider login, and optional project dependency setup.
3. **Keep Hub assets outside the repo while allowing explicit setup actions** -- chosen because it preserves legacy init behavior, gives Hub complete configuration coverage, and avoids hidden project file writes.
