# Project profiles generate bootstrap at init time

archLoop init asks for a **Project profile** (`generic`, `node`, `python`, `cpp`) that is independent of workflow template, agent runtime, and backlog manager. In the init path, the selected profile drives init-time artifacts: optional Dockerfile / Containerfile tool layers (`PROJECT_PROFILE_TOOLS`), `.archloop/bootstrap.sh`, and stack-specific verification guidance substituted into scaffolded workflow prompts (`PROJECT_PROFILE_VERIFY_GUIDANCE`).

## Decision

1. **Init-time generation** — Bootstrap scripts are rendered during `archloop init` from a small Project profile registry and written to `.archloop/bootstrap.sh` as a user-editable scaffold. Init does not execute or validate bootstrap. Workflow prompts receive stack-specific verification guidance via `{{PROJECT_PROFILE_VERIFY_GUIDANCE}}` substitution during the same init pass.
2. **Runtime hook only** — Non-blank workflow templates run the scaffolded `bootstrap.sh` from `sandbox.onSandboxReady` after the worktree is mounted. Templates do not generate, repair, or prompt for bootstrap at run time.
3. **Image vs repo setup** — Project profiles may add language or build-tool packages to the containerfile. Bootstrap is not part of image build; it prepares the mounted repository at sandbox ready time.
4. **Orthogonal choices** — Project profile does not alter `.env.example`, cache mounts, or `copyToWorktree` defaults in the first version.
5. **Runtime API boundary** — Project profile is shared by init and **Hub project config** (see ADR-0029), but public runtime sandbox APIs such as `run()`, `createSandbox()`, and sandbox providers do not expose language-stack profile options.

Bootstrap rendering lives in `src/bootstrap.ts` (`renderBootstrapScript`); profile definitions and containerfile fragments live in `src/projectProfiles.ts`.

## Considered Options

1. **Runtime bootstrap generation by the agent** — rejected. Unpredictable first run and couples repo setup to template orchestration.
2. **Automatic project detection during init** — deferred. First version uses an explicit profile choice with `generic` as the default.
3. **AI-generated bootstrap** — deferred. Deterministic profile scripts are testable and editable.
4. **Explicit Project profile registry at init** (chosen). Predictable scaffolding; localized extension point for future profiles.

## Consequences

- Adding a profile means extending `projectProfiles.ts`, tests for bootstrap and containerfile output, and init CLI help.
- Existing `.archloop` directories are not migrated automatically.
- Full test/build verification stays out of generated bootstrap scripts by default (setup-only).
- Hub flows use project profiles through **Hub project config** and **project development contracts**, not by reusing init-generated `.archloop/` scaffold files.
