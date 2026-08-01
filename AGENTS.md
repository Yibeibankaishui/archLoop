Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

## Project Identity

Current product identity is archLoop.

Use these names for all new code, docs, tests, generated files, and user-facing output:

- Display name: archLoop
- npm package: `@yibeibankaishui/archloop`
- CLI command: `archloop`
- Repo-local config directory: `.archloop/`
- User data directory name: `archloop`
- Env var prefix: `ARCHLOOP_`
- Managed branch prefix: `archloop/`
- GitHub owner/repo: `Yibeibankaishui/archLoop`

Do not introduce new references to the old Sandcastle identity, including `Sandcastle`, `sandcastle`, `.sandcastle/`, `SANDCASTLE_*`, `@ai-hero/sandcastle`, `ai-hero`, or `mattpocock`, except inside explicit historical rename/migration documents.

`docs/rename-to-archloop.md` and `docs/rename-to-archloop-implementation.md` intentionally mention old names as historical migration context; do not treat those old names as current API, CLI, package, repo, or directory names.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all changesets `patch` (since we're pre-1.0). Use `package.json#name` for the name.

## Docs

- `docs/content/docs/` is the source of truth for complete user documentation. Organize it by user task under Getting Started, Concepts, Guides, CLI, API, and Reference.
- Keep `README.md` and `readme_cn.md` as short product entry pages. They should explain the recommended Hub path, provide the canonical quick start, and link to deeper documentation instead of duplicating the full CLI or API reference.
- The canonical Hub quick start is `npm install --save-dev @yibeibankaishui/archloop` -> `npx archloop initialize` -> `npx archloop project add` -> `npx archloop check` -> `npx archloop run --flow with-review`.
- Treat `archloop init` and `.archloop/` as the legacy repo-local custom-scaffold path. Do not imply that Hub projects require repo-local initialization.
- When changing public-facing behavior, public APIs, CLI behavior, setup flow, or user-facing defaults, update the task-oriented page and the relevant CLI/API/reference page. Update README only when the product entry path or headline capabilities change.
- Reconcile `readme_cn.md` and `user_guide.md` when a workflow they cover changes. Keep the user guide's document change record current.
- Never add developer usernames, personal absolute paths, obsolete global install commands, or current-product references using the old identity to user documentation.
- Run `npm run docs:lint` while editing documentation and `npm run docs:check` before completion. `docs:check` includes the Fumadocs production build.
- When adding or moving documentation pages, update the nearest `meta.json` navigation file and verify local links.
- When PRDs, issues, public APIs, CLI behavior, major features, releases, or phase status change, update `docs/roadmap.md` if the roadmap is affected.

## Bundled skill (`skills/archloop-usage/SKILL.md`)

The repo ships a portable agent skill at `skills/archloop-usage/SKILL.md` that teaches other agents how to set up and run archLoop in a target project. It must not go stale across releases.

- Treat the skill as user-facing docs: whenever you change CLI commands/flags, `archloop init` prompts or defaults, template names, project profiles, env var names, public API surface (`run`/`interactive`/`createSandbox`/`createWorktree`, provider factories), the `.archloop/` layout, or known failure modes/diagnostics, update `skills/archloop-usage/SKILL.md` in the same change.
- Keep it consistent with the canonical docs under `docs/content/docs/`, plus the covered entry paths in `README.md`, `readme_cn.md`, and `user_guide.md`; if those move, reconcile the skill.
- Preserve the YAML frontmatter (`name`, `description`) and keep the description's WHAT/WHEN trigger terms accurate. Keep the body concise (< 500 lines) and use placeholders like `<ARCHLOOP_REPO>` / `<TARGET_REPO>` rather than absolute paths.
- This skill is distributed by copying into a user skills directory (see README "Agent skill" section); it is not auto-installed.

## Roadmap

- Maintain `docs/roadmap.md` when PRDs, issues, public APIs, CLI behavior, major features, releases, or phase status change.
- Keep roadmap phases in `## NN name` format with valid `Status`, one-sentence `Goal`, `Scope`, and `Deliverables`.
- Completed phases must include `Version`; blocked phases must include `Blocked by`.
- Keep the roadmap synced to Feishu. Use `sync-doc-feishu`, resolve conflicts by manual review first, then overwrite the Feishu document from the local `docs/roadmap.md`.

## Agent skills

### Issue tracker

Issues are GitHub issues in the repository `gh` resolves for this clone (`gh repo view`).

For this clone, treat `Yibeibankaishui/archLoop` as the default remote repository for all `gh issue`, `gh pr`, PRD publication, and other GitHub CLI write operations. Before creating or editing issues/PRs, verify that `gh repo set-default --view` resolves to `Yibeibankaishui/archLoop`; if it does not, either run `gh repo set-default Yibeibankaishui/archLoop` or pass `-R Yibeibankaishui/archLoop` explicitly on the command.

Do not assume `origin` is the writable/default GitHub target for agent operations.

See `docs/agents/issue-tracker.md` for general `gh` default-repository behavior.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->

## Beads Issue Tracker

This project has **bd (beads)** available for Hub task-store and issue-tracker work. Do not use Beads for ordinary code changes unless the user explicitly asks for Beads tracking or the task is specifically about Beads/Hub task integration.

Treat `.beads/issues.jsonl` and `.beads/interactions.jsonl` as local runtime/export data. Do not stage or commit them unless the user explicitly asks.

When you do need Beads, run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` only for explicitly requested Beads workflows or Beads/Hub task integration work.
- Run `bd prime` before using Beads commands.
- Use `bd remember` for persistent Beads knowledge when Beads is in scope.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Beads Session Completion

When a work session actively used Beads for task tracking, complete the Beads workflow before ending the session.

Workflow:

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Push code changes when appropriate**:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

If Beads was not used for the session, ignore this Beads-specific completion protocol.

<!-- END BEADS INTEGRATION -->
