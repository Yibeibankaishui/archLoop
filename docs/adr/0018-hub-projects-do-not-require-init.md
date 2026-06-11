# Hub projects do not require init

**Sandcastle Hub** project onboarding is separate from `sandcastle init`. `sandcastle init` remains the supported path for generating a repo-local config directory and scaffolded `main.mts`, while Hub commands such as `sandcastle project add` and `sandcastle run <project> --flow <id>` use **Hub project config** and Hub-owned **flow** assets instead of requiring or reusing `.sandcastle/` scaffold output.

## Considered Options

1. **Require `sandcastle init` before Hub runs** -- rejected because Hub flow behavior would still depend on whichever scaffold template and project-local files were generated earlier.
2. **Reuse the `init` command for Hub onboarding** -- rejected because it would blur two different products: repo-local scaffold generation and Hub-managed multi-project orchestration.
3. **Add separate Hub project onboarding** -- chosen so the legacy scaffolded path stays compatible while Hub can own projects, credentials, flows, and run history independently.
