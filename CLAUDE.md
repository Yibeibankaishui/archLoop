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
- GitHub owner/repo: `yibeibankaishui/archloop`

Do not introduce new references to the old Sandcastle identity, including `Sandcastle`, `sandcastle`, `.sandcastle/`, `SANDCASTLE_*`, `@ai-hero/sandcastle`, `ai-hero`, or `mattpocock`, except inside explicit historical rename/migration documents.

`docs/rename-to-archloop.md` and `docs/rename-to-archloop-implementation.md` intentionally mention old names as historical migration context; do not treat those old names as current API, CLI, package, repo, or directory names.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all changesets `patch` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check `README.md` to see if the documentation needs updating.

## Bundled skill (`skills/archloop-usage/SKILL.md`)

The repo ships a portable agent skill at `skills/archloop-usage/SKILL.md` that teaches other agents how to set up and run archLoop in a target project. Keep it from going stale across releases.

- Treat the skill as user-facing docs: whenever you change CLI commands/flags, `archloop init` prompts or defaults, template names, project profiles, env var names, public API surface (`run`/`interactive`/`createSandbox`/`createWorktree`, provider factories), the `.archloop/` layout, or known failure modes/diagnostics, update `skills/archloop-usage/SKILL.md` in the same change.
- Keep it consistent with `README.md`, `readme_cn.md`, and `user_guide.md`.
- Preserve the YAML frontmatter (`name`, `description`); keep the body concise (< 500 lines) and use placeholders like `<ARCHLOOP_REPO>` / `<TARGET_REPO>` rather than absolute paths.

## Roadmap

- Maintain `docs/roadmap.md` when PRDs, issues, public APIs, CLI behavior, major features, releases, or phase status change.
- Keep roadmap phases in `## NN name` format with valid `Status`, one-sentence `Goal`, `Scope`, and `Deliverables`.
- Completed phases must include `Version`; blocked phases must include `Blocked by`.
- If Feishu sync is enabled, use `sync-doc-feishu` and resolve conflicts by manual review before overwriting the cloud document.

## Agent skills

### Issue tracker

Issues are GitHub issues in the repository `gh` resolves for this clone (`gh repo view`). See `docs/agents/issue-tracker.md` for how to point `gh issue` at the intended repository (`gh repo set-default yibeibankaishui/archloop`).

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
