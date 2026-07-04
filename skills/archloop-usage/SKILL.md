---
name: archloop-usage
description: Set up and run archLoop (@yibeibankaishui/archloop) to orchestrate AI coding agents in isolated sandboxes inside another Git project. Use when a user wants to add, configure, init, build, or run archLoop in a target repo; mentions @yibeibankaishui/archloop, `archloop init`, `.archloop/`, parallel-planner, AFK agents, or sandbox-based agent orchestration; or hits errors from a archLoop run (gh 401, missing bootstrap.sh, exit 127, dirty merge overlap diagnostics, merger stash issues).
---

# archLoop Usage

archLoop (`@yibeibankaishui/archloop`) is a TypeScript toolkit that runs AI coding agents inside isolated sandboxes (Docker/Podman/Vercel), managing prompts, branch/worktree strategy, commit collection, and logs.

**Per-project, not global.** Each target Git repo is initialized separately: dependency in the repo's `package.json`, config in the repo's `.archloop/`.

## Prerequisites

- Target dir is a Git repo with **at least one commit** (a fresh `git init` with no commit fails).
- A container runtime (Docker Desktop or Podman) for sandboxed runs.
- API credentials for the chosen agent runtime and backlog source.

## Distribution: local source + `npm link` (not npm registry)

This setup uses archLoop from **local source via `npm link`**, not a published npm package. Do **not** run `npm install @yibeibankaishui/archloop` in target projects.

**One-time, in the archLoop source repo** (register the global link). Replace `<ARCHLOOP_REPO>` with the local archLoop checkout path:

```bash
cd <ARCHLOOP_REPO>
npm run build
npm link            # registers a global symlink for @yibeibankaishui/archloop
```

Re-run `npm run build` after changing archLoop source.

## Setup workflow (in the target repo)

Replace `<TARGET_REPO>` with the project being developed.

1. **Link** (first step — do not `npm install` archLoop):
   ```bash
   cd <TARGET_REPO>
   npm link @yibeibankaishui/archloop
   ```
   Verify it resolves and runs: `npx archloop --help` (confirms the link is usable).
   If you want to inspect or register Hub projects before init, `npx archloop project add --name <name> --path <repo>` registers an existing repo from any directory, `npx archloop project list` shows the shared registry, selected Hub project, repo path, profile, path validity, task readiness labels, ready/failed/total counts when available, and active run presence, `npx archloop project select <name>` updates the CLI default target, `npx archloop project status [--project <name>]` resolves the explicit or selected Hub project target first and then shows the canonical repo root, archLoop user data dir, Hub project directory, selected Hub project profile, contract path, `bd` availability, task-store initialization status, task counts by Hub status, active runs and batch status, failed tasks with next actions, sync state summaries, recent Hub events, worktree lease diagnostics for Hub-owned executions, managed branch cleanup diagnostics, and paths to Hub run directories for full logs. `npx archloop check --hub` runs the Hub-wide readiness slice from any directory, shows visible progress for each validation step, and now performs grouped provider/model smoke checks through the real provider path while listing the roles covered by each check.
   `npx archloop project configure [--project <name>] --project-profile node` creates or updates the Hub project development contract under the Hub project assets directory. Omit `--project` in a TTY to pick from the Hub project picker when no project is selected, and omit `--project-profile` in a TTY to pick from a prompt; non-interactive runs must pass the explicit flags they need. Re-running with the same profile preserves user-edited `setup`, `verify`, and `context` sections while refreshing advisory facts such as manifests, lockfiles, build files, and configured scripts; changing the profile writes a timestamped backup of the previous contract before replacing it. `npx archloop run . --flow no-review` and `with-review` load that contract before invoking implementers; if a contract is missing, `run --flow` creates a generic fallback contract, reports that fallback, continues, and tells you to specialize it with `archloop project configure [--project <name>] --project-profile <profile>`.
   If the repo has no local task store yet, run `npx archloop tasks init` before other `tasks` commands. Task commands target the selected Hub project by default; pass `--project <name>` to override it explicitly. If the repo already has Beads data, `npx archloop tasks list` groups tasks by Hub status and shows 1-based task numbers. `npx archloop tasks show <task-selector>` shows a task's Beads details, Hub status, labels, metadata, comments, remote refs, and run refs. A task selector is an exact Beads id, exact task title, or the number from `tasks list`; ambiguous titles fail with candidate ids. Use `npx archloop tasks create <title>` to create a local `inbox` task with `origin` metadata, `npx archloop tasks triage [task-id]` to run the no-sandbox agent-driven triage proposal flow for inbox/needs_info tasks (interactive multi-select with an All option, `--query`, or guarded `--yes`), `npx archloop tasks pull` to import open GitHub Issues into Beads (`--include-closed` for history), `npx archloop tasks push` to push linked local collaboration labels or done/wontfix closures back to GitHub without pulling, `npx archloop tasks sync --dry-run` to preview the combined reconcile plan before confirmed sync, `npx archloop tasks from-prd <prd-ref>` to run the no-sandbox `prd-decomposition` proposal flow and create local dependency-aware Beads tasks only after structured proposal validation and approval, `npx archloop tasks comment <task-selector>` to append a readable Beads comment without changing task status, `npx archloop tasks recover <task-selector>` to repair failed or stale execution states, keep recoverable branch work intact for retry, and clean safe Hub-managed empty branches only when cleanup is safe, `npx archloop tasks doctor` to audit task-state drift read-only, `npx archloop tasks repair-state <task-selector>` to preview/confirm local Beads state repair, and `npx archloop tasks delete <task-selector> [more...]` to permanently remove local Beads tasks (not remote GitHub issues) with TTY confirmation or `--yes` / `--dry-run` guards. Use `npx archloop tasks cleanup --dry-run` to preview managed branch cleanup, `npx archloop tasks cleanup --yes` to confirm safe managed branch deletion, and `npx archloop tasks cleanup --yes --include-unowned` to opt in to safe historical unowned `archloop/...` branches, which remain preserved by default. Proposal flows write local Beads only; use `tasks push` for remote GitHub label/closure updates. Run `npx archloop run . --flow no-review` to execute the first Hub flow: it reads the Beads ready queue, warns early about dirty source files, claims the selected task batch, starts selected implementers concurrently, advances successful work to `waiting_for_merge`, records selected/skipped/blocked merge candidate reasons, preflights dirty source files and `.beads/` runtime/export files separately, then merges eligible batch tasks with per-task events, runs verification after each merge, records a run-level completion event, closes local Beads tasks on success, and then attempts best-effort cleanup of the safe managed task branch with non-force `git branch -d`. Cleanup failures surface as warnings/events without changing the task out of `done`. Dirty-compatible Hub merges verify in a clean integration worktree/branch and land back only when host dirty files do not overlap the files changed by the merge; if they overlap, CLI output lists the blocking files and tells the user to commit, stash, or discard them before rerunning the same flow. The CLI summary reports aggregate completed batches, completed tasks, and a stop reason of `no_ready_tasks`, `max_batches_reached`, or `batch_failed`. Clean Hub merges use Git directly; merge conflicts invoke the configured `merge` agent role before Hub decides whether to continue verification or mark the task failed. If no ready tasks exist but the same flow has a previous unfinished `waiting_for_merge` batch, the run resumes that old batch merge by its original batch id; if ready tasks exist too, the run still resumes the unfinished merge-ready batch first and leaves the ready tasks unclaimed until merge completes. Use `--flow with-review` when the flow should run a reviewer stage (`reviewing`) before merge; selected task pipelines run concurrently within each batch, with each task's reviewer starting after that task's implementation succeeds. Proposal flows `prd-decomposition` and `triage` run end-to-end via `archloop run . --flow <id> --input <value>` (`--input <prd-ref>` or Beads task id / `inbox,needs_info` query); the matching `tasks` shortcuts remain the recommended entry points. Configure Hub roles with `npx archloop agent-config init` / `show` / `set-role`; `--category` is accepted as an alias for `--kind`.
   Planned Hub batches treat a valid empty planner selection as "no safe batch": the run records the deferrals and stops without claiming a conservative fallback task. Planner failures or invalid output still fall back conservatively.
2. **Init once**: `npx archloop init`. Interactive prompts: sandbox provider, backlog manager, workflow template, project profile, default agent, installed runtimes.
   - Non-interactive example:
     ```bash
     npx archloop init --agent claude-code --sandbox docker \
       --backlog github-issues --template simple-loop \
       --project-profile node --build-image true
     ```
   - `init` **refuses to overwrite** an existing `.archloop/`. Back up and delete manually to redo.
   - archLoop bundles Beads via `@beads/bd@1.0.4`. For `no-sandbox + beads`,
     `bd` can come from the bundled install, `ARCHLOOP_BD_PATH`, or host
     `PATH`.
3. **Env**: `cp .archloop/.env.example .archloop/.env`, then fill tokens (see table below). archLoop skips empty values, so a blank `KEY=` is treated as unset.
4. **Build image** (sandboxed providers): `npx archloop docker build-image` (or `podman`). Re-run after editing the Dockerfile/Containerfile.
5. **Run the entry script with npx**:
   ```bash
   npx tsx ./.archloop/main.ts
   ```
   (If `init` generated `main.mts`, use that filename.)

## `.archloop/` is local orchestration — do NOT commit it

`.archloop/` is agent-orchestration scaffold from `init`, not application source. Keep it out of version control: ensure the repo's `.gitignore` ignores `.archloop/` (the directory's own `.gitignore` already excludes `.env`, `auth/`, `logs/`, `worktrees/`). Never `git add` `.archloop/main.ts`, `bootstrap.sh`, prompts, or `auth/`. The files must still exist on disk for runs to work.

## Templates

| Template                       | Behavior                                          |
| ------------------------------ | ------------------------------------------------- |
| `blank`                        | Minimal scaffold; write your own `main` + prompts |
| `simple-loop`                  | Process issues one by one                         |
| `sequential-reviewer`          | Implement, then review                            |
| `parallel-planner`             | Plan → parallel branches → merge                  |
| `parallel-planner-with-review` | Parallel implement + per-branch review → merge    |

With GitHub Issues, planner templates only list the current `ready-for-agent`
queue (`archLoop` + `ready-for-agent` when label creation is enabled) and the
generated TypeScript fails fast if a planner returns an issue outside that
allowed queue. Hub batch planner candidate enrichment computes
`blockersResolved`, `openBlockers`, and `unknownBlockers` from live blocker
state before planning, and the planner payload only exposes those structured
fields. `openBlockers=[]` and `unknownBlockers=[]` mean the candidate is
unblocked, even if the task body still contains stale `## Blocked by` prose.
If the planner returns an `explicit_blocker` deferral for a candidate with no
live `openBlockers`, no `unknownBlockers`, and no dependency on a selected
task, Hub rejects that deferral, recovers the safe candidate up to
`maxTasks`, and records `invalid_explicit_blocker_deferral` in batch events
and CLI diagnostics. The blocker parser recognizes GitHub issue refs such as
`#152` or issue URLs as well as Beads ids, and unresolved refs are treated
conservatively.

## Project profiles

`--project-profile` affects the Dockerfile tool layers, `bootstrap.sh`, and stack-specific verification guidance in generated workflow prompts. Choices: `generic` (default), `node`, `python`, `cpp`. v1 does not auto-detect — pick the closest. Non-blank templates run `.archloop/bootstrap.sh` from `sandbox.onSandboxReady`.

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
import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  promptFile: ".archloop/prompt.md",
});
```

Key APIs: `run()`, `interactive()`, `createSandbox()`, `createWorktree()`; sandboxes `docker()/podman()/vercel()/noSandbox()`; agents `claudeCode()/codex()/cursor()/opencode()/pi()`. `promptFile` resolves against `process.cwd()`, not the `cwd` option. Branch strategies: `head`, `merge-to-head`, `branch`.

## Common CLI

| Command                                                                                                                                | Purpose                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archloop init`                                                                                                                        | Generate `.archloop/`                                                                                                                                                                       |
| `archloop project add --name <name> --path <repo>`                                                                                     | Register an existing git repo as a Hub project; TTY mode prompts for missing path/name, suggests a repo-derived name/profile, can initialize the local task store, and selects the project. |
| `archloop project list`                                                                                                                | Show registered Hub projects, the selected project, path validity, task readiness labels, ready/failed/total counts when available, and active run presence.                                |
| `archloop project select [<name>]`                                                                                                     | Set the CLI selected Hub project.                                                                                                                                                           |
| `archloop project status [--project <name>]`                                                                                           | Show Hub project status for the selected or explicit Hub project and its contract summary.                                                                                                  |
| `archloop check [--hub]`                                                                                                               | Run the Hub-wide readiness slice with visible progress.                                                                                                                                     |
| `archloop project configure [--project <name>] --project-profile <profile>`                                                            | Create or update the Hub project development contract for the selected or explicit Hub project.                                                                                             |
| `archloop agent-config path`                                                                                                           | Show Hub agent config path.                                                                                                                                                                 |
| `archloop agent-config show`                                                                                                           | Show configured Hub agent roles.                                                                                                                                                            |
| `archloop agent-config init`                                                                                                           | Interactive Hub agent role setup with model picker and provider options.                                                                                                                    |
| `archloop agent-config configure`                                                                                                      | Alias for `agent-config init`.                                                                                                                                                              |
| `archloop agent-config set-role <role>`                                                                                                | Save a Hub agent role provider/model.                                                                                                                                                       |
| `archloop env path`                                                                                                                    | Show Hub env file path.                                                                                                                                                                     |
| `archloop env show`                                                                                                                    | Show configured Hub env keys, with hints for empty keys.                                                                                                                                    |
| `archloop env init`                                                                                                                    | Interactive Hub credential setup with per-key guidance.                                                                                                                                     |
| `archloop env configure`                                                                                                               | Alias for `env init`.                                                                                                                                                                       |
| `archloop env set <key> [value]`                                                                                                       | Save one Hub env value.                                                                                                                                                                     |
| `archloop auth show`                                                                                                                   | Show provider auth source/status.                                                                                                                                                           |
| `archloop auth path <provider>`                                                                                                        | Show Hub auth dir for a provider.                                                                                                                                                           |
| `archloop auth login codex`                                                                                                            | Run Codex login with Hub `CODEX_HOME`.                                                                                                                                                      |
| `archloop auth login github`                                                                                                           | Run GitHub login with Hub `GH_CONFIG_DIR`.                                                                                                                                                  |
| `archloop tasks init`                                                                                                                  | Initialize the local Hub task store.                                                                                                                                                        |
| `archloop tasks list`                                                                                                                  | Group Beads tasks by status.                                                                                                                                                                |
| `archloop tasks show <selector>`                                                                                                       | Show one Beads task.                                                                                                                                                                        |
| `archloop run . --flow <id> [--input <value>] [--batch-strategy planned \| limited \| conservative] [--max-tasks N] [--max-batches N]` | Run a Hub flow and print the flow-level completion summary; task-board flows default to planned batch selection with max 3 tasks per batch.                                                 |
| `archloop tasks create <title>`                                                                                                        | Create a local Hub task.                                                                                                                                                                    |
| `archloop tasks triage [task-id]`                                                                                                      | Agent-driven triage proposal flow.                                                                                                                                                          |
| `archloop tasks pull`                                                                                                                  | Pull open GitHub Issues into Beads.                                                                                                                                                         |
| `archloop tasks push`                                                                                                                  | Push local task state to GitHub.                                                                                                                                                            |
| `archloop tasks sync`                                                                                                                  | Preview/confirm bidirectional sync.                                                                                                                                                         |
| `archloop tasks from-prd <ref>`                                                                                                        | Agent-driven PRD proposal flow.                                                                                                                                                             |
| `archloop tasks comment <selector>`                                                                                                    | Append a Beads comment.                                                                                                                                                                     |
| `archloop tasks recover <selector>`                                                                                                    | Repair failed/stale task state, keep recoverable branch work intact for retry, and clean safe Hub-managed empty branches only when cleanup is safe.                                         |
| `archloop tasks doctor`                                                                                                                | Read-only audit for Hub task-state drift.                                                                                                                                                   |
| `archloop tasks repair-state <selector>`                                                                                               | Preview/confirm local Beads task-state repair.                                                                                                                                              |
| `archloop tasks cleanup`                                                                                                               | Preview/confirm Hub-managed branch cleanup.                                                                                                                                                 |
| `archloop tasks delete <selector> [more...]`                                                                                           | Delete local Beads tasks.                                                                                                                                                                   |
| `archloop docker build-image`                                                                                                          | Build image from Dockerfile.                                                                                                                                                                |
| `archloop docker remove-image`                                                                                                         | Remove image.                                                                                                                                                                               |
| `archloop --help`                                                                                                                      | Help.                                                                                                                                                                                       |

## Troubleshooting (known failure modes)

- **Missing Hub agent role config / non-interactive flow failure**: Hub flows need provider/model settings for roles such as planning, triage, implementation, review, merge, and recovery. Run `archloop agent-config init` (or `configure`) in a TTY for first-time setup (provider picker, recommended models, optional effort/mode/variant), `archloop agent-config show` to inspect roles, or `archloop agent-config set-role <role> --provider <provider> --model <model> [--options effort=medium]` in scripts/CI.
- **`archloop check --hub` missing roles or credentials**: The Hub readiness slice validates role completeness, shared credentials/auth, provider references, provider CLI availability, and grouped provider/model smoke checks. It prints exact follow-up commands for missing roles or credentials and lists the roles covered or skipped by each provider/model check. Use `archloop agent-config show`, `archloop env show`, and `archloop auth show` to inspect current Hub state.
- **Cursor auth / `CURSOR_API_KEY` required in Hub flows**: Hub proposal and task flows run `agent --print` headlessly. `agent login` is not enough for automation. Run `archloop env init` to store shared credentials in the archLoop user data directory (`archloop env path`), or `archloop env set CURSOR_API_KEY <value>`. `process.env` overrides file values at runtime.
- **Codex auth model confusion**: `OPENAI_KEY` in the Hub env file uses OpenAI API billing. To use a Codex/ChatGPT CLI login session for Hub flows, run `archloop auth login codex`; inspect the Hub-owned `CODEX_HOME` path with `archloop auth path codex`.
- **`gh ... 401 Bad credentials` / `PromptError` during planner prompt expansion**: The sandbox `gh` uses Hub auth (`archloop auth login github`) or `GH_TOKEN`, independent of the host keyring. Host `gh auth status` succeeding does NOT mean the sandbox is authed. Fix: run `archloop auth login github`, or set a valid `GH_TOKEN` with `archloop env set GH_TOKEN <value>`. Inspect current source/status with `archloop auth show`.
- **`bash .archloop/bootstrap.sh: No such file or directory` (exit 127)**: The hook script referenced by `onSandboxReady` is missing from the worktree. Restore it (`archloop init` for the profile, or recover from a stash). Often caused by a merge agent running `git stash push -u`, which sweeps untracked `.archloop/` files — recover with `git stash pop`.
- **Long-lived loop keeps using stale config**: `main.ts` hooks are read once at process start. After editing `.archloop/main.ts`, restart the `main.ts` process; it does not hot-reload.
- **Worktree lease conflicts and retry**: Non-`head` branch strategies acquire an internal worktree lease per run, interactive session, or handle lifetime. Duplicate starts on the same branch fail fast with an already-in-use diagnostic (process id for direct callers; task/flow/batch context for Hub flows). There is no standalone unlock command — use wait, `archloop tasks recover`, or normal handle `close()` instead of editing `.archloop/locks/` manually. Failed runs release the lease but may preserve a dirty worktree; Hub retry continues from that preserved branch/worktree when no active lease remains and implementer prompts note that code may already exist. `archloop project status` prints a worktree lease diagnostics section and managed branch cleanup diagnostics; `archloop tasks doctor` cross-checks Hub claim vs lease occupancy and reports mismatches with next actions.
- **Hub task state doctor/repair**: `archloop tasks doctor` is read-only and audits local Beads task-board state against Hub run events plus git branch/worktree state. It reports multiple archLoop status labels, stale `metadata.hubStatus`, missing execution claim fields, failed tasks with branch work, reviewed tasks that are not selectable for merge, terminal tasks with stale execution metadata, dirty source worktree gates, worktree lease claim/occupancy mismatches with wait/rerun/repair/recover guidance, managed branch cleanup diagnostics, and task state that needs `archloop tasks push`. `archloop tasks repair-state <selector>` previews local Beads mutations and requires TTY confirmation or `--yes`; it preserves user labels, rewrites only archLoop-managed status labels/metadata, restores merge-ready event claims when safe, and never mutates remote GitHub Issues.
- **Hub flow merge selection/preflight**: `archloop run . --flow ...` warns early when the source repo is dirty, prints selected/skipped/blocked reasons for merge candidates, and includes the flow-level completion summary with completed batches, completed tasks, and stop reason. `state_inconsistent` means Hub run events and branch work indicate the task reached merge-ready state, but the Beads projection or claim metadata is stale; run `archloop tasks doctor`, then `archloop tasks repair-state <selector>` if doctor marks it repairable, before retrying. If the task is failed or has stale execution state, `archloop tasks recover <selector>` may also apply. When a resumable merge-ready batch exists, Hub runs overlap checks before claiming fresh ready tasks. Non-overlapping dirty source files do not block: merges are verified in a clean integration worktree/branch and land back only after another overlap check. If dirty files would be overwritten or conflict with the merge result, Hub stops with `batch_failed`, keeps tasks in `waiting_for_merge`, lists the blocking files, and tells the user to commit, stash, or discard those files before rerunning the same flow. Dirty `.beads/` runtime/export files are reported separately and do not block by themselves, but a task branch that changes `.beads/` files is blocked. Keep Beads local state out of code branches and use `archloop tasks pull` / `push` / `sync` for remote task exchange.
- **Hub flow merge failure / `failed(merge_failed)` / `failed(merge_conflict)`**: `archloop run . --flow ...` includes the first useful Git diagnostic in the merge summary and Hub events. Clean merges use Git directly; merge conflicts require a configured `merge` role and are rechecked for unresolved files and unfinished `MERGE_HEAD` before verification continues. Use the diagnostics to decide whether to configure the merge role, clean the host worktree, inspect the branch state, or rerun `archloop tasks recover <selector>` before retrying the flow. Recovery preserves recoverable branch work and only deletes safe managed empty branches when cleanup is safe.
- **Hub task-board batch selection**: `ready_for_agent` is the candidate pool; the selected flow batch is the subset chosen before claim. Task-board flows (`no-review`, `with-review`) default to `--batch-strategy planned --max-tasks 3`; selected batch tasks run concurrently through implementation and any per-branch review, then merge serially. After each successful batch, Hub reloads the ready queue and starts the next batch until the queue is empty or `--max-batches` is reached. `limited` selects ready-queue order up to the max; `conservative` selects one eligible task. `planned` uses a flow-owned planner when wired; until then Hub falls back to conservative and records `planner_unavailable` in batch events/CLI output. Unfinished same-flow merge-ready batches resume before new planning when no ready tasks are selected (**resume-first**). Proposal flows reject `--batch-strategy` and `--max-tasks`.
- **Merge phase loses local files**: Instruct the merge agent to avoid `git stash push -u`; if stashing tracked app changes, omit `-u` and `git stash pop` afterward. Never stash/delete/`git add` `.archloop/`.
- **`empty HEAD` / no commits**: The repo needs at least one commit before archLoop can create worktrees.

## Verify a run

- `git log` / `git status` show the expected branch and commits.
- `.archloop/logs/` has the run log.
- Sandbox can run the project's key commands (test/build/start); if not, edit the Dockerfile and `bootstrap.sh`.
- All env vars from the init prompt are filled in `.archloop/.env`.
