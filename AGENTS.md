Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all changesets `patch` (since we're pre-1.0). Use `package.json#name` for the name.

## Docs

- When changing public-facing behavior, public APIs, CLI behavior, setup flow, or user-facing defaults, update `README.md` if the documentation is affected.
- When PRDs, issues, public APIs, CLI behavior, major features, releases, or phase status change, update `docs/roadmap.md` if the roadmap is affected.

## Bundled skill (`skills/archloop-usage/SKILL.md`)

The repo ships a portable agent skill at `skills/archloop-usage/SKILL.md` that teaches other agents how to set up and run archLoop in a target project. It must not go stale across releases.

- Treat the skill as user-facing docs: whenever you change CLI commands/flags, `archloop init` prompts or defaults, template names, project profiles, env var names, public API surface (`run`/`interactive`/`createSandbox`/`createWorktree`, provider factories), the `.archloop/` layout, or known failure modes/diagnostics, update `skills/archloop-usage/SKILL.md` in the same change.
- Keep it consistent with `README.md`, `readme_cn.md`, and `user_guide.md`; if those move, reconcile the skill.
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

For this clone, treat `yibeibankaishui/archloop` as the default remote repository for all `gh issue`, `gh pr`, PRD publication, and other GitHub CLI write operations. Before creating or editing issues/PRs, verify that `gh repo set-default --view` resolves to `yibeibankaishui/archloop`; if it does not, either run `gh repo set-default yibeibankaishui/archloop` or pass `-R yibeibankaishui/archloop` explicitly on the command.

Do not assume `origin` is the writable/default GitHub target for agent operations.

See `docs/agents/issue-tracker.md` for general `gh` default-repository behavior.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
