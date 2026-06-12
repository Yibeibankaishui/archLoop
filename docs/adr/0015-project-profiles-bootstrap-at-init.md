# Project profiles generate bootstrap at init time

Sandcastle init asks for a **Project profile** (`generic`, `node`, `python`, `cpp`) that is independent of workflow template, agent runtime, and backlog manager. The selected profile drives init-time artifacts: optional Dockerfile / Containerfile tool layers (`PROJECT_PROFILE_TOOLS`), `.sandcastle/bootstrap.sh`, and stack-specific verification guidance substituted into scaffolded workflow prompts (`PROJECT_PROFILE_VERIFY_GUIDANCE`).

## Decision

1. **Init-time generation** — Bootstrap scripts are rendered during `sandcastle init` from a small Project profile registry and written to `.sandcastle/bootstrap.sh` as a user-editable scaffold. Init does not execute or validate bootstrap. Workflow prompts receive stack-specific verification guidance via `{{PROJECT_PROFILE_VERIFY_GUIDANCE}}` substitution during the same init pass.
2. **Runtime hook only** — Non-blank workflow templates run the scaffolded `bootstrap.sh` from `sandbox.onSandboxReady` after the worktree is mounted. Templates do not generate, repair, or prompt for bootstrap at run time.
3. **Image vs repo setup** — Project profiles may add language or build-tool packages to the containerfile. Bootstrap is not part of image build; it prepares the mounted repository at sandbox ready time.
4. **Orthogonal choices** — Project profile does not alter `.env.example`, cache mounts, or `copyToWorktree` defaults in the first version.
5. **Init-only surface** — Project profile is an init-time CLI concept (`--project-profile`, interactive prompt after template selection). Public runtime sandbox APIs do not expose language-stack profile options.

Bootstrap rendering lives in `src/bootstrap.ts` (`renderBootstrapScript`); profile definitions and containerfile fragments live in `src/projectProfiles.ts`.

## Considered Options

1. **Runtime bootstrap generation by the agent** — rejected. Unpredictable first run and couples repo setup to template orchestration.
2. **Automatic project detection during init** — deferred. First version uses an explicit profile choice with `generic` as the default.
3. **AI-generated bootstrap** — deferred. Deterministic profile scripts are testable and editable.
4. **Explicit Project profile registry at init** (chosen). Predictable scaffolding; localized extension point for future profiles.

## Consequences

- Adding a profile means extending `projectProfiles.ts`, tests for bootstrap and containerfile output, and init CLI help.
- Existing `.sandcastle` directories are not migrated automatically.
- Full test/build verification stays out of generated bootstrap scripts by default (setup-only).
