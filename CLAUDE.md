Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all changesets `patch` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check `README.md` to see if the documentation needs updating.

## Bundled skill (`skills/sandcastle-usage/SKILL.md`)

The repo ships a portable agent skill at `skills/sandcastle-usage/SKILL.md` that teaches other agents how to set up and run Sandcastle in a target project. Keep it from going stale across releases.

- Treat the skill as user-facing docs: whenever you change CLI commands/flags, `sandcastle init` prompts or defaults, template names, project profiles, env var names, public API surface (`run`/`interactive`/`createSandbox`/`createWorktree`, provider factories), the `.sandcastle/` layout, or known failure modes/diagnostics, update `skills/sandcastle-usage/SKILL.md` in the same change.
- Keep it consistent with `README.md`, `readme_cn.md`, and `user_guide.md`.
- Preserve the YAML frontmatter (`name`, `description`); keep the body concise (< 500 lines) and use placeholders like `<SANDCASTLE_REPO>` / `<TARGET_REPO>` rather than absolute paths.

## Roadmap

- Maintain `docs/roadmap.md` when PRDs, issues, public APIs, CLI behavior, major features, releases, or phase status change.
- Keep roadmap phases in `## NN name` format with valid `Status`, one-sentence `Goal`, `Scope`, and `Deliverables`.
- Completed phases must include `Version`; blocked phases must include `Blocked by`.
- If Feishu sync is enabled, use `sync-doc-feishu` and resolve conflicts by manual review before overwriting the cloud document.

## Agent skills

### Issue tracker

Issues are GitHub issues in the repository `gh` resolves for this clone (`gh repo view`). See `docs/agents/issue-tracker.md` for how to point `gh issue` at a fork (`gh repo set-default`). Upstream source repository: `mattpocock/sandcastle`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
