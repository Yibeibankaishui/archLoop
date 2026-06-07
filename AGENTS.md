Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all changesets `patch` (since we're pre-1.0). Use `package.json#name` for the name.

## Docs

- When changing public-facing behavior, public APIs, CLI behavior, setup flow, or user-facing defaults, update `README.md` if the documentation is affected.
- When PRDs, issues, public APIs, CLI behavior, major features, releases, or phase status change, update `docs/roadmap.md` if the roadmap is affected.

## Bundled skill (`skills/sandcastle-usage/SKILL.md`)

The repo ships a portable agent skill at `skills/sandcastle-usage/SKILL.md` that teaches other agents how to set up and run Sandcastle in a target project. It must not go stale across releases.

- Treat the skill as user-facing docs: whenever you change CLI commands/flags, `sandcastle init` prompts or defaults, template names, project profiles, env var names, public API surface (`run`/`interactive`/`createSandbox`/`createWorktree`, provider factories), the `.sandcastle/` layout, or known failure modes/diagnostics, update `skills/sandcastle-usage/SKILL.md` in the same change.
- Keep it consistent with `README.md`, `readme_cn.md`, and `user_guide.md`; if those move, reconcile the skill.
- Preserve the YAML frontmatter (`name`, `description`) and keep the description's WHAT/WHEN trigger terms accurate. Keep the body concise (< 500 lines) and use placeholders like `<SANDCASTLE_REPO>` / `<TARGET_REPO>` rather than absolute paths.
- This skill is distributed by copying into a user skills directory (see README "Agent skill" section); it is not auto-installed.

## Roadmap

- Maintain `docs/roadmap.md` when PRDs, issues, public APIs, CLI behavior, major features, releases, or phase status change.
- Keep roadmap phases in `## NN name` format with valid `Status`, one-sentence `Goal`, `Scope`, and `Deliverables`.
- Completed phases must include `Version`; blocked phases must include `Blocked by`.
- Keep the roadmap synced to Feishu. Use `sync-doc-feishu`, resolve conflicts by manual review first, then overwrite the Feishu document from the local `docs/roadmap.md`.

## Agent skills

### Issue tracker

Issues are GitHub issues in the repository `gh` resolves for this clone (`gh repo view`). See `docs/agents/issue-tracker.md` for how to point `gh issue` at a fork (`gh repo set-default`). Upstream source repository: `mattpocock/sandcastle`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
