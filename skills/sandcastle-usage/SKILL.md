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
   If you want to inspect the repo before init, `npx sandcastle project status` shows the canonical repo root, Sandcastle user data dir, `bd` availability, and task-board counts.
   If the repo already has Beads data, `npx sandcastle tasks list` groups tasks by Hub status and `npx sandcastle tasks show <id>` shows a task's Beads details, Hub status, labels, metadata, comments, remote refs, and run refs. Use `npx sandcastle tasks create <title>` to create a local `inbox` task with `origin` metadata, `npx sandcastle tasks triage` to classify `inbox` and `needs_info` tasks into collaboration states, and `npx sandcastle tasks comment <id>` to append a readable Beads comment without changing task status. `--category` is accepted as an alias for `--kind`.
2. **Init once**: `npx sandcastle init`. Interactive prompts: sandbox provider, backlog manager, workflow template, project profile, default agent, installed runtimes.
   - Non-interactive example:
     ```bash
     npx sandcastle init --agent claude-code --sandbox docker \
       --backlog github-issues --template simple-loop \
       --project-profile node --build-image true
     ```
   - `init` **refuses to overwrite** an existing `.sandcastle/`. Back up and delete manually to redo.
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

## Project profiles

`--project-profile` only affects the Dockerfile tool layers and `bootstrap.sh`; it does not change runtime APIs. Choices: `generic` (default), `node`, `python`, `cpp`. v1 does not auto-detect — pick the closest. Non-blank templates run `.sandcastle/bootstrap.sh` from `sandbox.onSandboxReady`.

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

| Command                           | Purpose                       |
| --------------------------------- | ----------------------------- |
| `sandcastle init`                 | Generate `.sandcastle/`       |
| `sandcastle project status`       | Show Hub status for the repo  |
| `sandcastle tasks list`           | Group Beads tasks by status   |
| `sandcastle tasks show <id>`      | Show one Beads task           |
| `sandcastle tasks create <title>` | Create a local Hub task       |
| `sandcastle tasks triage`         | Triage inbox/needs_info tasks |
| `sandcastle tasks comment <id>`   | Append a Beads comment        |
| `sandcastle docker build-image`   | Build image from Dockerfile   |
| `sandcastle docker remove-image`  | Remove image                  |
| `sandcastle --help`               | Help                          |

## Troubleshooting (known failure modes)

- **`gh ... 401 Bad credentials` / `PromptError` during planner prompt expansion**: The sandbox `gh` uses mounted `.sandcastle/auth/gh` (or `GH_TOKEN`), independent of the host keyring. Host `gh auth status` succeeding does NOT mean the sandbox is authed. Fix: `GH_CONFIG_DIR=.sandcastle/auth/gh gh auth login --insecure-storage`, or set a valid `GH_TOKEN` in `.sandcastle/.env`. Verify with `GH_CONFIG_DIR=.sandcastle/auth/gh gh issue list -l <label> --limit 1`.
- **`bash .sandcastle/bootstrap.sh: No such file or directory` (exit 127)**: The hook script referenced by `onSandboxReady` is missing from the worktree. Restore it (`sandcastle init` for the profile, or recover from a stash). Often caused by a merge agent running `git stash push -u`, which sweeps untracked `.sandcastle/` files — recover with `git stash pop`.
- **Long-lived loop keeps using stale config**: `main.ts` hooks are read once at process start. After editing `.sandcastle/main.ts`, restart the `main.ts` process; it does not hot-reload.
- **Merge phase loses local files**: Instruct the merge agent to avoid `git stash push -u`; if stashing tracked app changes, omit `-u` and `git stash pop` afterward. Never stash/delete/`git add` `.sandcastle/`.
- **`empty HEAD` / no commits**: The repo needs at least one commit before Sandcastle can create worktrees.

## Verify a run

- `git log` / `git status` show the expected branch and commits.
- `.sandcastle/logs/` has the run log.
- Sandbox can run the project's key commands (test/build/start); if not, edit the Dockerfile and `bootstrap.sh`.
- All env vars from the init prompt are filled in `.sandcastle/.env`.
