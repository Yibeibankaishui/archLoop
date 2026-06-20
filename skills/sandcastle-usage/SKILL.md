---
name: sandcastle-usage
description: Set up and run Sandcastle (@ai-hero/sandcastle) to orchestrate AI coding agents in isolated sandboxes inside another Git project. Use when a user wants to add, configure, init, build, or run Sandcastle in a target repo; mentions @ai-hero/sandcastle, `sandcastle init`, `.sandcastle/`, parallel-planner, AFK agents, or sandbox-based agent orchestration; or hits errors from a Sandcastle run (gh 401, missing bootstrap.sh, exit 127, merger stash issues).
---

# Sandcastle Usage

Sandcastle (`@ai-hero/sandcastle`) is a TypeScript toolkit that runs AI coding agents inside isolated sandboxes (Docker/Podman/Vercel), managing prompts, branch/worktree strategy, commit collection, and logs.

**Per-project, not global.** Each target Git repo is initialized separately: dependency in the repo's `package.json`, config in the repo's `.sandcastle/`.

## Prerequisites

- Target dir is a Git repo with **at least one commit** (a fresh `git init` with no commit fails).
- A container runtime (Docker Desktop or Podman) for sandboxed runs.
- API credentials for the chosen agent runtime and backlog source.

## Distribution: local source + `npm link` (not npm registry)

This setup uses Sandcastle from **local source via `npm link`**, not a published npm package. Do **not** run `npm install @ai-hero/sandcastle` in target projects.

**One-time, in the Sandcastle source repo** (register the global link). Replace `<SANDCASTLE_REPO>` with the local Sandcastle checkout path:

```bash
cd <SANDCASTLE_REPO>
npm run build
npm link            # registers a global symlink for @ai-hero/sandcastle
```

Re-run `npm run build` after changing Sandcastle source.

## Setup workflow (in the target repo)

Replace `<TARGET_REPO>` with the project being developed.

1. **Link** (first step — do not `npm install` Sandcastle):
   ```bash
   cd <TARGET_REPO>
   npm link @ai-hero/sandcastle
   ```
   Verify it resolves and runs: `npx sandcastle --help` (confirms the link is usable).
   If you want to inspect the repo before init, `npx sandcastle project status` shows the canonical repo root, Sandcastle user data dir, `bd` availability, task counts by Hub status, active runs and batch status, failed tasks with next actions, sync state summaries, recent Hub events, and paths to Hub run directories for full logs.
   If the repo already has Beads data, `npx sandcastle tasks list` groups tasks by Hub status and shows 1-based task numbers. `npx sandcastle tasks show <task-selector>` shows a task's Beads details, Hub status, labels, metadata, comments, remote refs, and run refs. A task selector is an exact Beads id, exact task title, or the number from `tasks list`; ambiguous titles fail with candidate ids. Use `npx sandcastle tasks create <title>` to create a local `inbox` task with `origin` metadata, `npx sandcastle tasks triage [task-id]` to run the no-sandbox agent-driven triage proposal flow for inbox/needs_info tasks (interactive multi-select with an All option, `--query`, or guarded `--yes`), `npx sandcastle tasks pull` to import open GitHub Issues into Beads (`--include-closed` for history), `npx sandcastle tasks push` to push linked local collaboration labels or done/wontfix closures back to GitHub without pulling, `npx sandcastle tasks sync --dry-run` to preview the combined reconcile plan before confirmed sync, `npx sandcastle tasks from-prd <prd-ref>` to run the no-sandbox `prd-decomposition` proposal flow and create local dependency-aware Beads tasks only after structured proposal validation and approval, `npx sandcastle tasks comment <task-selector>` to append a readable Beads comment without changing task status, `npx sandcastle tasks recover <task-selector>` to repair failed or stale execution states (including `close_failed` when the branch is already merged, and failed tasks whose branch already has unmerged work), and `npx sandcastle tasks delete <task-selector> [more...]` to permanently remove local Beads tasks (not remote GitHub issues) with TTY confirmation or `--yes` / `--dry-run` guards. Proposal flows write local Beads only; use `tasks push` for remote GitHub label/closure updates. Run `npx sandcastle run . --flow no-review` to execute the first Hub flow: it reads the Beads ready queue, claims tasks, runs bundled Hub prompts, advances successful work to `waiting_for_merge`, records selected/skipped/blocked merge candidate reasons, preflights dirty source files and `.beads/` runtime/export files separately, then merges eligible batch tasks with per-task events, runs verification after each merge, and closes local Beads tasks on success. Clean Hub merges use Git directly; merge conflicts invoke the configured `merge` agent role before Hub decides whether to continue verification or mark the task failed. If no ready tasks exist but the same flow has a previous unfinished `waiting_for_merge` batch, the run resumes that old batch merge by its original batch id; if ready tasks exist too, the run starts a normal new batch and reports the old batch ids as not resumed. Use `--flow with-review` when the flow should run a reviewer stage (`reviewing`) before merge. Proposal flows `prd-decomposition` and `triage` run end-to-end via `sandcastle run . --flow <id> --input <value>` (`--input <prd-ref>` or Beads task id / `inbox,needs_info` query); the matching `tasks` shortcuts remain the recommended entry points. Configure Hub roles with `npx sandcastle agent-config init` / `show` / `set-role`; `--category` is accepted as an alias for `--kind`.
2. **Init once**: `npx sandcastle init`. Interactive prompts: sandbox provider, backlog manager, workflow template, project profile, default agent, installed runtimes.
   - Non-interactive example:
     ```bash
     npx sandcastle init --agent claude-code --sandbox docker \
       --backlog github-issues --template simple-loop \
       --project-profile node --build-image true
     ```
   - `init` **refuses to overwrite** an existing `.sandcastle/`. Back up and delete manually to redo.
   - Sandcastle bundles Beads via `@beads/bd@1.0.4`. For `no-sandbox + beads`,
     `bd` can come from the bundled install, `SANDCASTLE_BD_PATH`, or host
     `PATH`.
3. **Env**: `cp .sandcastle/.env.example .sandcastle/.env`, then fill tokens (see table below). Sandcastle skips empty values, so a blank `KEY=` is treated as unset.
4. **Build image** (sandboxed providers): `npx sandcastle docker build-image` (or `podman`). Re-run after editing the Dockerfile/Containerfile.
5. **Run the entry script with npx**:
   ```bash
   npx tsx ./.sandcastle/main.ts
   ```
   (If `init` generated `main.mts`, use that filename.)

## `.sandcastle/` is local orchestration — do NOT commit it

`.sandcastle/` is agent-orchestration scaffold from `init`, not application source. Keep it out of version control: ensure the repo's `.gitignore` ignores `.sandcastle/` (the directory's own `.gitignore` already excludes `.env`, `auth/`, `logs/`, `worktrees/`). Never `git add` `.sandcastle/main.ts`, `bootstrap.sh`, prompts, or `auth/`. The files must still exist on disk for runs to work.

## Templates

| Template                       | Behavior                                          |
| ------------------------------ | ------------------------------------------------- |
| `blank`                        | Minimal scaffold; write your own `main` + prompts |
| `simple-loop`                  | Process issues one by one                         |
| `sequential-reviewer`          | Implement, then review                            |
| `parallel-planner`             | Plan → parallel branches → merge                  |
| `parallel-planner-with-review` | Parallel implement + per-branch review → merge    |

With GitHub Issues, planner templates only list the current `ready-for-agent`
queue (`Sandcastle` + `ready-for-agent` when label creation is enabled) and the
generated TypeScript fails fast if a planner returns an issue outside that
allowed queue. `parallel-planner-with-review` also enriches each ready issue with
computed `openBlockers` from live blocker state before planning, so stale
`## Blocked by` prose does not skip work whose blockers are already closed.

## Project profiles

`--project-profile` affects the Dockerfile tool layers, `bootstrap.sh`, and stack-specific verification guidance in generated workflow prompts. Choices: `generic` (default), `node`, `python`, `cpp`. v1 does not auto-detect — pick the closest. Non-blank templates run `.sandcastle/bootstrap.sh` from `sandbox.onSandboxReady`.

## Common env vars

| Var                 | Used by               |
| ------------------- | --------------------- |
| `ANTHROPIC_API_KEY` | Claude Code / Pi      |
| `OPENAI_KEY`        | Codex                 |
| `CURSOR_API_KEY`    | Cursor                |
| `OPENCODE_API_KEY`  | OpenCode              |
| `GH_TOKEN`          | GitHub Issues backlog |

## Minimal API example

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});
```

Key APIs: `run()`, `interactive()`, `createSandbox()`, `createWorktree()`; sandboxes `docker()/podman()/vercel()/noSandbox()`; agents `claudeCode()/codex()/cursor()/opencode()/pi()`. `promptFile` resolves against `process.cwd()`, not the `cwd` option. Branch strategies: `head`, `merge-to-head`, `branch`.

## Common CLI

| Command                                          | Purpose                                   |
| ------------------------------------------------ | ----------------------------------------- |
| `sandcastle init`                                | Generate `.sandcastle/`                   |
| `sandcastle project status`                      | Show Hub task board summary               |
| `sandcastle agent-config path`                   | Show Hub agent config path                |
| `sandcastle agent-config show`                   | Show configured Hub agent roles           |
| `sandcastle agent-config init`                   | Interactive Hub agent role setup          |
| `sandcastle agent-config configure`              | Alias for `agent-config init`             |
| `sandcastle agent-config set-role <role>`        | Save a Hub agent role provider/model      |
| `sandcastle env path`                            | Show Hub env file path                    |
| `sandcastle env show`                            | Show configured Hub env keys              |
| `sandcastle env init`                            | Interactive Hub credential setup          |
| `sandcastle env configure`                       | Alias for `env init`                      |
| `sandcastle env set <key> [value]`               | Save one Hub env value                    |
| `sandcastle auth show`                           | Show provider auth source/status          |
| `sandcastle auth path <provider>`                | Show Hub auth dir for a provider          |
| `sandcastle auth login codex`                    | Run Codex login with Hub `CODEX_HOME`     |
| `sandcastle auth login github`                   | Run GitHub login with Hub `GH_CONFIG_DIR` |
| `sandcastle tasks list`                          | Group Beads tasks by status               |
| `sandcastle tasks show <selector>`               | Show one Beads task                       |
| `sandcastle run . --flow <id> [--input <value>]` | Run a Hub flow                            |
| `sandcastle tasks create <title>`                | Create a local Hub task                   |
| `sandcastle tasks triage [task-id]`              | Agent-driven triage proposal flow         |
| `sandcastle tasks pull`                          | Pull open GitHub Issues into Beads        |
| `sandcastle tasks push`                          | Push local task state to GitHub           |
| `sandcastle tasks sync`                          | Preview/confirm bidirectional sync        |
| `sandcastle tasks from-prd <ref>`                | Agent-driven PRD proposal flow            |
| `sandcastle tasks comment <selector>`            | Append a Beads comment                    |
| `sandcastle tasks recover <selector>`            | Repair failed/stale task state            |
| `sandcastle tasks delete <selector> [more...]`   | Delete local Beads tasks                  |
| `sandcastle docker build-image`                  | Build image from Dockerfile               |
| `sandcastle docker remove-image`                 | Remove image                              |
| `sandcastle --help`                              | Help                                      |

## Troubleshooting (known failure modes)

- **Missing Hub agent role config / non-interactive flow failure**: Hub flows need provider/model settings for roles such as planning, triage, implementation, review, merge, and recovery. Run `sandcastle agent-config init` (or `configure`) in a TTY for first-time setup, `sandcastle agent-config show` to inspect roles, or `sandcastle agent-config set-role <role> --provider <provider> --model <model>` in scripts/CI.
- **Cursor auth / `CURSOR_API_KEY` required in Hub flows**: Hub proposal and task flows run `agent --print` headlessly. `agent login` is not enough for automation. Run `sandcastle env init` to store shared credentials in the Sandcastle user data directory (`sandcastle env path`), or `sandcastle env set CURSOR_API_KEY <value>`. `process.env` overrides file values at runtime.
- **Codex auth model confusion**: `OPENAI_KEY` in the Hub env file uses OpenAI API billing. To use a Codex/ChatGPT CLI login session for Hub flows, run `sandcastle auth login codex`; inspect the Hub-owned `CODEX_HOME` path with `sandcastle auth path codex`.
- **`gh ... 401 Bad credentials` / `PromptError` during planner prompt expansion**: The sandbox `gh` uses Hub auth (`sandcastle auth login github`) or `GH_TOKEN`, independent of the host keyring. Host `gh auth status` succeeding does NOT mean the sandbox is authed. Fix: run `sandcastle auth login github`, or set a valid `GH_TOKEN` with `sandcastle env set GH_TOKEN <value>`. Inspect current source/status with `sandcastle auth show`.
- **`bash .sandcastle/bootstrap.sh: No such file or directory` (exit 127)**: The hook script referenced by `onSandboxReady` is missing from the worktree. Restore it (`sandcastle init` for the profile, or recover from a stash). Often caused by a merge agent running `git stash push -u`, which sweeps untracked `.sandcastle/` files — recover with `git stash pop`.
- **Long-lived loop keeps using stale config**: `main.ts` hooks are read once at process start. After editing `.sandcastle/main.ts`, restart the `main.ts` process; it does not hot-reload.
- **Hub flow merge selection/preflight**: `sandcastle run . --flow ...` prints selected/skipped/blocked reasons for merge candidates. Dirty source files block before merge; clean or stash them and retry. Dirty `.beads/` runtime/export files are reported separately and do not block by themselves, but a task branch that changes `.beads/` files is blocked. Keep Beads local state out of code branches and use `sandcastle tasks pull` / `push` / `sync` for remote task exchange.
- **Hub flow merge failure / `failed(merge_failed)` / `failed(merge_conflict)`**: `sandcastle run . --flow ...` includes the first useful Git diagnostic in the merge summary and Hub events. Clean merges use Git directly; merge conflicts require a configured `merge` role and are rechecked for unresolved files and unfinished `MERGE_HEAD` before verification continues. Use the diagnostics to decide whether to configure the merge role, clean the host worktree, inspect the branch state, or rerun `sandcastle tasks recover <selector>` before retrying the flow.
- **Merge phase loses local files**: Instruct the merge agent to avoid `git stash push -u`; if stashing tracked app changes, omit `-u` and `git stash pop` afterward. Never stash/delete/`git add` `.sandcastle/`.
- **`empty HEAD` / no commits**: The repo needs at least one commit before Sandcastle can create worktrees.

## Verify a run

- `git log` / `git status` show the expected branch and commits.
- `.sandcastle/logs/` has the run log.
- Sandbox can run the project's key commands (test/build/start); if not, edit the Dockerfile and `bootstrap.sh`.
- All env vars from the init prompt are filled in `.sandcastle/.env`.
