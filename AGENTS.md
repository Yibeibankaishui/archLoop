Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all changesets `patch` (since we're pre-1.0). Use `package.json#name` for the name.

## Docs

- When changing public-facing behavior, public APIs, CLI behavior, setup flow, or user-facing defaults, update `README.md` if the documentation is affected.
- When PRDs, issues, public APIs, CLI behavior, major features, releases, or phase status change, update `docs/roadmap.md` if the roadmap is affected.

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
