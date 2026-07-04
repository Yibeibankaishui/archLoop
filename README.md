<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-archloop-ondark_2x.png">
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-archloop-onlight_2x.png">
    <img alt="archLoop" src="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-archloop-onlight_2x.png" height="200" style="margin-bottom: 20px;">
  </picture>
</div>

## What Is archLoop?

A TypeScript library for orchestrating AI coding agents in isolated sandboxes:

1. You invoke agents with a single `archloop.run()`.
2. archLoop handles sandboxing the agent with a configurable branch strategy.
3. The commits made on the branches get merged back.

archLoop is provider-agnostic — it ships with built-in providers for Docker, Podman, and Vercel, and you can create your own. Great for parallelizing multiple AFK agents, creating review pipelines, or even just orchestrating your own agents.

## Prerequisites

- [Git](https://git-scm.com/) with at least one commit on the current branch (an initialized repo with no commits yet is not enough — run an initial `git commit` before using archLoop)
- A sandbox provider — archLoop needs an isolated environment to run agents in. Built-in options:
  - [Docker Desktop](https://www.docker.com/) — most common for local development
  - [Podman](https://podman.io/) — rootless alternative to Docker
  - [Vercel](https://vercel.com/) — cloud-based Firecracker microVMs via `@vercel/sandbox`
  - Or [create your own](#custom-sandbox-providers) using `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`

## Quick start

1. Install the package:

```bash
npm install --save-dev @yibeibankaishui/archloop
```

archLoop bundles a pinned Beads runtime via `@beads/bd@1.0.4`, so Hub and
Beads-backed commands can use the packaged `bd` binary without a separate
system install. Set `ARCHLOOP_BD_PATH` to override the binary path if needed.

If you are onboarding Hub projects, start with `archloop initialize`, then use
`archloop project add`, `archloop project select`, `archloop check`, and
selected-project `archloop run --flow ...`. The steps below describe the
legacy repo-local scaffold path for `.archloop/`.

2. Run `archloop init`. This scaffolds a `.archloop` directory with all the files needed.

```bash
npx archloop init
```

3. Edit `.archloop/.env` and fill in the token values generated for your selected installed agent runtimes and backlog manager.

```bash
cp .archloop/.env.example .archloop/.env
```

4. Install dependencies and run the scaffolded workflow (uses project-local `tsx` from `devDependencies`):

```bash
npm install
npm run archloop
```

```typescript
// 3. Run the agent via the JS API
import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(), // or podman(), vercel(), or your own provider
  promptFile: ".archloop/prompt.md",
});
```

## Sandbox Providers

archLoop uses a `SandboxProvider` to create isolated environments. The `sandbox` option on `run()`, `interactive()`, and `createSandbox()` accepts any provider, including `noSandbox()` — opt in to running the agent directly on the host when container isolation is undesired. Built-in providers:

| Provider   | Import path                                      | Type       | Accepted by                                 |
| ---------- | ------------------------------------------------ | ---------- | ------------------------------------------- |
| Docker     | `@yibeibankaishui/archloop/sandboxes/docker`     | Bind-mount | `run()`, `createSandbox()`, `interactive()` |
| Podman     | `@yibeibankaishui/archloop/sandboxes/podman`     | Bind-mount | `run()`, `createSandbox()`, `interactive()` |
| Vercel     | `@yibeibankaishui/archloop/sandboxes/vercel`     | Isolated   | `run()`, `createSandbox()`, `interactive()` |
| No-sandbox | `@yibeibankaishui/archloop/sandboxes/no-sandbox` | None       | `run()`, `createSandbox()`, `interactive()` |

Worktree methods (`wt.run()`, `wt.interactive()`, `wt.createSandbox()`) accept the same providers as their top-level counterparts. `wt.interactive()` defaults to `noSandbox()` when no sandbox is specified.

```typescript
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";
import { podman } from "@yibeibankaishui/archloop/sandboxes/podman";
import { vercel } from "@yibeibankaishui/archloop/sandboxes/vercel";
import { noSandbox } from "@yibeibankaishui/archloop/sandboxes/no-sandbox";

// Docker, Podman, and Vercel are interchangeable in run() and createSandbox():
await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  prompt: "...",
});

// No-sandbox runs the agent directly on the host — accepted by run(),
// createSandbox(), and interactive(). Skips container isolation entirely:
await interactive({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: noSandbox(),
  prompt: "...", // optional — omit to launch the TUI with no initial prompt
  cwd: "/path/to/other-repo", // optional — defaults to process.cwd()
});
```

You can also [create your own provider](#custom-sandbox-providers) using `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`.

## API

archLoop exports a programmatic `run()` function for use in scripts, CI pipelines, or custom tooling. The examples below use `docker()`, but any `SandboxProvider` works in its place.

```typescript
import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  promptFile: ".archloop/prompt.md",
});

console.log(result.iterations.length); // number of iterations executed
console.log(result.iterations); // per-iteration results with optional sessionId
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

### All options

```typescript
import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

const result = await run({
  // Agent provider — required. Pass a model string to claudeCode().
  // Optional second arg for provider-specific options like effort level.
  agent: claudeCode("claude-opus-4-6", { effort: "high" }),

  // Sandbox provider — required. Any SandboxProvider works (docker, podman, vercel, or custom).
  // Provider-specific config (like imageName, mounts) lives inside the provider factory call.
  sandbox: docker({
    imageName: "archloop:local",
    // Optional: override the UID/GID used for --user flag (defaults to host UID/GID).
    // Must match the UID baked into the image. Pre-flight check catches mismatches.
    // containerUid: 1000,
    // containerGid: 1000,
    // Optional: mount host directories into the sandbox (e.g. package manager caches)
    // hostPath supports absolute, tilde-expanded (~), and relative paths (resolved from cwd).
    // sandboxPath supports absolute and relative paths (resolved from the sandbox repo directory).
    mounts: [
      { hostPath: "~/.npm", sandboxPath: "/home/agent/.npm", readonly: true },
      { hostPath: "data", sandboxPath: "data" }, // mounts <cwd>/data → <sandbox-repo>/data
    ],
    // Optional: SELinux volume label — "z" (default, shared), "Z" (private), or false (none).
    // No-op on non-SELinux systems (Docker Desktop on macOS/Windows, Linux without SELinux).
    selinuxLabel: "z",
    // Optional: provider-level env vars merged at launch time
    env: { DOCKER_SPECIFIC: "value" },
    // Optional: attach container to Docker network(s) — string or string[]
    network: "my-network",
  }),

  // Host repo directory — replaces process.cwd() as the anchor for
  // .archloop/ artifacts (worktrees, logs, env, patches) and git operations.
  // Relative paths resolve against process.cwd(). Defaults to process.cwd().
  cwd: "../other-repo",

  // Branch strategy — controls how the agent's changes relate to branches.
  // Defaults to { type: "head" } for bind-mount and { type: "merge-to-head" } for isolated providers.
  branchStrategy: { type: "branch", branch: "agent/fix-42" },

  // Prompt source — provide one of these, not both.
  // Note: promptFile resolves against process.cwd(), NOT cwd.
  promptFile: ".archloop/prompt.md", // path to a prompt file
  // prompt: "Fix issue #42 in this repo", // OR an inline prompt string

  // Values substituted for {{KEY}} placeholders in the prompt.
  promptArgs: {
    ISSUE_NUMBER: "42",
  },

  // Maximum number of agent iterations to run before stopping. Default: 1
  maxIterations: 5,

  // Display name for this run, shown as a prefix in log output.
  name: "fix-issue-42",

  // Lifecycle hooks grouped by where they run: host or sandbox.
  hooks: {
    host: {
      onWorktreeReady: [{ command: "cp .env.example .env" }],
      onSandboxReady: [{ command: "echo setup done" }],
    },
    sandbox: {
      onSandboxReady: [{ command: "npm install" }],
    },
  },

  // Host-relative file paths to copy into the sandbox before the container starts.
  // Not supported with branchStrategy: { type: "head" }.
  copyToWorktree: [".env"],

  // Override default timeouts for built-in lifecycle steps.
  // Unset keys keep their defaults.
  timeouts: {
    copyToWorktreeMs: 120_000, // default: 60_000
  },

  // How to record progress. Default: write to a file under .archloop/logs/
  logging: {
    type: "file",
    path: ".archloop/logs/my-run.log",
    // Optional: forward the agent's output stream to your own observability system.
    // Fires for each text chunk and tool call the agent produces. Errors thrown
    // by the callback are swallowed so a broken forwarder cannot kill the run.
    onAgentStreamEvent: (event) => {
      // event is { type: "text" | "toolCall", iteration, timestamp, ... }
      myLogger.info(event);
    },
  },
  // logging: { type: "stdout" }, // OR render an interactive UI in the terminal

  // String (or array of strings) the agent emits to end the iteration loop early.
  // Default: "<promise>COMPLETE</promise>"
  completionSignal: "<promise>COMPLETE</promise>",

  // Idle timeout in seconds — resets whenever the agent produces output. Default: 600 (10 minutes)
  idleTimeoutSeconds: 600,

  // Structured output — extract a typed payload from the agent's stdout.
  // Requires maxIterations === 1 and the tag must appear in the prompt.
  // output: Output.object({ tag: "result", schema: z.object({ answer: z.number() }) }),
  // output: Output.string({ tag: "summary" }),
});

console.log(result.iterations.length); // number of iterations executed
console.log(result.completionSignal); // matched signal string, or undefined if none fired
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

### `createSandbox()` — reusable sandbox

Use `createSandbox()` when you need to run multiple agents (or multiple rounds of the same agent) inside a single sandbox. It creates the sandbox once, and you call `sandbox.run()` as many times as you need. This avoids repeated container startup costs and keeps all runs on the same branch.

Use `run()` instead when you only need a single one-shot invocation — it handles sandbox lifecycle automatically.

You can also pass `noSandbox()` to `createSandbox()` when archLoop is already running inside an isolated environment and you want to avoid a nested container. This runs the agent directly on the host worktree, so isolation is entirely your responsibility.

#### Basic single-run usage

```typescript
import { createSandbox, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});

const result = await sandbox.run({
  agent: claudeCode("claude-opus-4-6"),
  prompt: "Fix issue #42 in this repo.",
});

console.log(result.commits); // [{ sha: "abc123" }]
```

#### Multi-run implement-then-review

```typescript
import { createSandbox, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// Step 1: implement
const implResult = await sandbox.run({
  agent: claudeCode("claude-opus-4-6"),
  promptFile: ".archloop/implement.md",
  maxIterations: 5,
});

// Step 2: review on the same branch, same container
const reviewResult = await sandbox.run({
  agent: claudeCode("claude-sonnet-4-6"),
  prompt: "Review the changes and fix any issues.",
});
```

Commits from all `run()` calls accumulate on the same branch. The sandbox container stays alive between runs, so installed dependencies and build artifacts persist.

#### Automatic cleanup with `await using`

`await using` calls `sandbox.close()` automatically when the block exits. If the sandbox has uncommitted changes, the worktree is preserved on disk; if clean, both container and worktree are removed.

#### Manual `close()` with `CloseResult`

```typescript
const sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});
// ... run agents ...
const closeResult = await sandbox.close();
if (closeResult.preservedWorktreePath) {
  console.log(`Worktree preserved at ${closeResult.preservedWorktreePath}`);
}
```

#### `CreateSandboxOptions`

| Option           | Type            | Default         | Description                                                          |
| ---------------- | --------------- | --------------- | -------------------------------------------------------------------- |
| `branch`         | string          | —               | **Required.** Explicit branch for the sandbox                        |
| `sandbox`        | SandboxProvider | —               | **Required.** Sandbox provider (e.g. `docker()`, `podman()`)         |
| `cwd`            | string          | `process.cwd()` | Host repo directory — relative paths resolve against `process.cwd()` |
| `hooks`          | SandboxHooks    | —               | Lifecycle hooks (`host.*`, `sandbox.*`) — run once at creation time  |
| `copyToWorktree` | string[]        | —               | Host-relative file paths to copy into the sandbox at creation time   |
| `timeouts`       | Timeouts        | —               | Override default timeouts (e.g. `{ copyToWorktreeMs: 120_000 }`)     |

#### `Sandbox`

| Property / Method       | Type                                                               | Description                                  |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| `branch`                | string                                                             | The branch the sandbox is on                 |
| `worktreePath`          | string                                                             | Host path to the worktree                    |
| `run(options)`          | `(SandboxRunOptions) => Promise<SandboxRunResult>`                 | Invoke an agent inside the existing sandbox  |
| `interactive(options)`  | `(SandboxInteractiveOptions) => Promise<SandboxInteractiveResult>` | Launch an interactive session in the sandbox |
| `close()`               | `() => Promise<CloseResult>`                                       | Tear down the container and sandbox          |
| `[Symbol.asyncDispose]` | `() => Promise<void>`                                              | Auto teardown via `await using`              |

#### `SandboxRunOptions`

| Option               | Type               | Default                       | Description                                                         |
| -------------------- | ------------------ | ----------------------------- | ------------------------------------------------------------------- |
| `agent`              | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-6")`) |
| `prompt`             | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                |
| `promptFile`         | string             | —                             | Path to prompt file (mutually exclusive with `prompt`)              |
| `promptArgs`         | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                |
| `maxIterations`      | number             | `1`                           | Maximum iterations to run                                           |
| `completionSignal`   | string \| string[] | `<promise>COMPLETE</promise>` | String(s) the agent emits to stop the iteration loop early          |
| `idleTimeoutSeconds` | number             | `600`                         | Idle timeout in seconds — resets on each agent output event         |
| `name`               | string             | —                             | Display name for the run                                            |
| `logging`            | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                    |
| `signal`             | AbortSignal        | —                             | Cancels the run when aborted; handle stays usable afterward         |

#### `SandboxRunResult`

| Field              | Type                | Description                                                        |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `iterations`       | `IterationResult[]` | Per-iteration results (use `.length` for the count)                |
| `completionSignal` | string?             | The matched completion signal string, or `undefined` if none fired |
| `stdout`           | string              | Combined agent output from all iterations                          |
| `commits`          | `{ sha }[]`         | Commits created during the run                                     |
| `logFilePath`      | string?             | Path to the log file (only when logging to a file)                 |

#### `CloseResult`

| Field                   | Type    | Description                                                              |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `preservedWorktreePath` | string? | Host path to the preserved worktree, set when it had uncommitted changes |

### `createWorktree()` — independent worktree lifecycle

Use `createWorktree()` when you need a worktree (git worktree) as an independent, first-class concept — separate from any sandbox. This is useful when you want to run an interactive session first and then hand the same worktree to a sandboxed AFK agent.

Only `branch` and `merge-to-head` strategies are accepted; `head` is a compile-time type error since it means no worktree.

Pass `cwd` to target a repo other than `process.cwd()`. Relative paths resolve against `process.cwd()`; absolute paths pass through. A `CwdError` is thrown if the path does not exist or is not a directory.

```typescript
import { createWorktree } from "@yibeibankaishui/archloop";

await using wt = await createWorktree({
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  copyToWorktree: ["node_modules"],
  cwd: "/path/to/other-repo", // optional — defaults to process.cwd()
});

console.log(wt.worktreePath); // host path to the worktree
console.log(wt.branch); // "agent/fix-42"

// Run an interactive session in the worktree (defaults to noSandbox)
await wt.interactive({
  agent: claudeCode("claude-opus-4-6"),
  prompt: "Explore the codebase and understand the bug.",
});

// Run an AFK agent in the worktree (sandbox is required)
const result = await wt.run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker({ imageName: "archloop:myrepo" }),
  prompt: "Fix issue #42.",
  maxIterations: 3,
});
console.log(result.commits); // commits made during the run

// Create a long-lived sandbox from the worktree
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

await using sandbox = await wt.createSandbox({
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// sandbox.close() tears down the container only — the worktree stays
await sandbox.close();

// wt.close() cleans up the worktree
```

`wt.close()` checks for uncommitted changes: if the worktree is dirty, it's preserved on disk; if clean, it's removed. `await using` calls `close()` automatically. The worktree persists after `run()`, `interactive()`, and `createSandbox()` complete, so you can hand it to another agent or inspect it.

**Split ownership**: When a sandbox is created via `wt.createSandbox()`, `sandbox.close()` tears down the container only — the worktree remains. `wt.close()` is responsible for worktree cleanup. This differs from the top-level `createSandbox()`, where `sandbox.close()` owns both container and worktree.

#### `CreateWorktreeOptions`

| Option           | Type                   | Default | Description                                                               |
| ---------------- | ---------------------- | ------- | ------------------------------------------------------------------------- |
| `branchStrategy` | WorktreeBranchStrategy | —       | **Required.** `{ type: "branch", branch }` or `{ type: "merge-to-head" }` |
| `copyToWorktree` | string[]               | —       | Host-relative file paths to copy into the worktree at creation time       |
| `timeouts`       | Timeouts               | —       | Override default timeouts (e.g. `{ copyToWorktreeMs: 120_000 }`)          |

#### `Worktree`

| Property / Method        | Type                                                                  | Description                                         |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| `branch`                 | string                                                                | The branch the worktree is on                       |
| `worktreePath`           | string                                                                | Host path to the worktree                           |
| `run(options)`           | `(options: WorktreeRunOptions) => Promise<WorktreeRunResult>`         | Run an AFK agent in the worktree (sandbox required) |
| `interactive(options)`   | `(options: WorktreeInteractiveOptions) => Promise<InteractiveResult>` | Run an interactive agent session in the worktree    |
| `createSandbox(options)` | `(options: WorktreeCreateSandboxOptions) => Promise<Sandbox>`         | Create a long-lived sandbox backed by this worktree |
| `close()`                | `() => Promise<CloseResult>`                                          | Clean up the worktree (preserves if dirty)          |
| `[Symbol.asyncDispose]`  | `() => Promise<void>`                                                 | Auto cleanup via `await using`                      |

#### `WorktreeInteractiveOptions`

| Option       | Type                   | Default       | Description                                                                                       |
| ------------ | ---------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `agent`      | AgentProvider          | —             | **Required.** Agent provider                                                                      |
| `sandbox`    | AnySandboxProvider     | `noSandbox()` | Sandbox provider (defaults to no sandbox)                                                         |
| `prompt`     | string                 | —             | Inline prompt (mutually exclusive with `promptFile`)                                              |
| `promptFile` | string                 | —             | Path to prompt file                                                                               |
| `name`       | string                 | —             | Optional session name                                                                             |
| `hooks`      | SandboxHooks           | —             | Lifecycle hooks (`host.*`, `sandbox.*`)                                                           |
| `promptArgs` | PromptArgs             | —             | Key-value map for `{{KEY}}` placeholder substitution                                              |
| `env`        | Record<string, string> | —             | Environment variables to inject into the sandbox                                                  |
| `signal`     | AbortSignal            | —             | Cancel the session when aborted. The worktree is preserved on disk. Rejects with `signal.reason`. |

#### `WorktreeRunOptions`

| Option               | Type                   | Default | Description                                                                                                                         |
| -------------------- | ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agent`              | AgentProvider          | —       | **Required.** Agent provider                                                                                                        |
| `sandbox`            | SandboxProvider        | —       | **Required.** Sandbox provider (AFK agents must be sandboxed)                                                                       |
| `prompt`             | string                 | —       | Inline prompt (mutually exclusive with `promptFile`)                                                                                |
| `promptFile`         | string                 | —       | Path to prompt file                                                                                                                 |
| `maxIterations`      | number                 | 1       | Maximum iterations to run                                                                                                           |
| `completionSignal`   | string \| string[]     | —       | Substring(s) to stop the iteration loop early                                                                                       |
| `idleTimeoutSeconds` | number                 | 600     | Idle timeout in seconds                                                                                                             |
| `name`               | string                 | —       | Optional run name                                                                                                                   |
| `logging`            | LoggingOption          | file    | Logging mode                                                                                                                        |
| `hooks`              | SandboxHooks           | —       | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                                             |
| `promptArgs`         | PromptArgs             | —       | Key-value map for `{{KEY}}` placeholder substitution                                                                                |
| `env`                | Record<string, string> | —       | Environment variables to inject into the sandbox                                                                                    |
| `resumeSession`      | string                 | —       | Resume a prior Claude Code session by ID. Incompatible with `maxIterations > 1`. Session file must exist on host.                   |
| `signal`             | AbortSignal            | —       | Cancel the run when aborted. Kills the in-flight agent subprocess; the worktree is preserved on disk. Rejects with `signal.reason`. |

#### `WorktreeRunResult`

| Property           | Type                | Description                                            |
| ------------------ | ------------------- | ------------------------------------------------------ |
| `iterations`       | `IterationResult[]` | Per-iteration results (use `.length` for the count)    |
| `completionSignal` | string              | The matched completion signal, or undefined            |
| `stdout`           | string              | Combined stdout output from all agent iterations       |
| `commits`          | { sha: string }[]   | List of commits made by the agent during the run       |
| `branch`           | string              | The branch name the agent worked on                    |
| `logFilePath`      | string              | Path to the log file, if logging was drained to a file |

#### `WorktreeCreateSandboxOptions`

| Option           | Type            | Default | Description                                                         |
| ---------------- | --------------- | ------- | ------------------------------------------------------------------- |
| `sandbox`        | SandboxProvider | —       | **Required.** Sandbox provider (e.g. `docker()`)                    |
| `hooks`          | SandboxHooks    | —       | Lifecycle hooks (`host.*`, `sandbox.*`)                             |
| `copyToWorktree` | string[]        | —       | Host-relative file paths to copy into the worktree at creation time |
| `timeouts`       | Timeouts        | —       | Override default timeouts (e.g. `{ copyToWorktreeMs: 120_000 }`)    |

## How it works

archLoop uses a **branch strategy** configured on the sandbox provider to control how the agent's changes relate to branches. There are three strategies:

- **Head** (`{ type: "head" }`) — The agent writes directly to the host working directory. No worktree, no branch indirection. This is the default for bind-mount providers like `docker()`.
- **Merge-to-head** (`{ type: "merge-to-head" }`) — archLoop creates a temporary branch in a git worktree. The agent works on the temp branch, and changes are merged back to HEAD when done. The temp branch is cleaned up after merge.
- **Branch** (`{ type: "branch", branch: "foo" }`) — Commits land on an explicitly named branch in a git worktree.

For bind-mount providers (like Docker), the worktree directory is bind-mounted into the container — the agent writes directly to the host filesystem through the mount, so no sync is needed.

From your point of view, you just configure `branchStrategy: { type: 'branch', branch: 'foo' }` on `run()`, and get a commit on branch `foo` once it's complete. All 100% local.

### Worktree leases (internal resource lifecycle)

Non-**head** branch strategies (`branch` and `merge-to-head`) acquire an internal **worktree lease** before an agent can use the managed worktree. A worktree lease is archLoop's time-bounded claim that one run, interactive session, sandbox handle, or Hub flow owns that worktree. Leases are implemented with lock files under `.archloop/locks/`, but there is no standalone lease management command — interact through normal run, retry, status, doctor, and recovery workflows instead.

**Duplicate starts fail fast.** If another archLoop caller already holds an active lease for the same branch/worktree, the second `run()`, `interactive()`, `createWorktree()`, `createSandbox()`, or Hub flow attempt fails immediately with an already-running diagnostic. archLoop does not wait, retry acquisition, or pick a different worktree.

- Direct callers without Hub context see the owning process id, branch, and acquisition time.
- Hub flows record task-first owner context in the lease (task id, flow id, flow batch). A Hub retry that sees an active lease reports **active execution**, not retry failure.

**Preserved worktrees and retry.** When a run fails or aborts, archLoop releases the lease but preserves a dirty worktree on disk (ADR 0003). A later Hub retry with no active lease continues from the preserved task branch and worktree instead of discarding partial code. Implementer prompts include retry context when preserved work may already exist.

**Stale recovery without deleting work.** If the owning process crashes, the lease becomes stale. archLoop can clear the stale lease file during retry preparation or `WorktreeManager.pruneStale()` without deleting or resetting the worktree. Use `archloop tasks recover` when Hub claim metadata is stale but preserved branch work should be retried.

**Handle lifetime.** `createWorktree()` and `createSandbox()` hold a lease for the returned handle's lifetime and release it on `close()` or scope finalization, so a long-lived handle cannot be raced by another process targeting the same branch.

**Hub claim vs lease.** Hub task claim metadata (run id, batch id, branch) and worktree lease state are separate concepts. `archloop project status` and `archloop tasks doctor` cross-check them and report mismatches such as active claim without lease, active lease with failed/stale claim, or active lease without Hub claim — each with a concrete next action (wait, rerun, recover, repair).

See [ADR 0007](./docs/adr/0007-worktree-locking.md) and [PRD: Worktree lease](./docs/prd/worktree-lease.md) for the full design.

## Prompts

archLoop uses a flexible prompt system. You write the prompt, and the engine executes it — no opinions about workflow, task management, or context sources are imposed.

### Prompt resolution

You must provide exactly one of:

1. `prompt: "inline string"` — pass an inline prompt directly via `RunOptions`
2. `promptFile: "./path/to/prompt.md"` — point to a specific file via `RunOptions`

`prompt` and `promptFile` are mutually exclusive — providing both is an error. If neither is provided, `run()` throws an error asking you to supply one.

**Inline prompts (`prompt: "..."`) are passed to the agent literally.** No `{{KEY}}` substitution, no `` !`command` `` expansion, no built-in `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` injection. If you need values interpolated into an inline prompt, build the string in JavaScript (`` `Work on ${branch}…` ``). Passing `promptArgs` alongside an inline prompt is an error — switch to `promptFile` to use substitution.

The substitution and expansion features below apply **only** to prompts sourced from `promptFile`.

> **Convention**: `archloop init` scaffolds `.archloop/prompt.md` and all templates explicitly reference it via `promptFile: ".archloop/prompt.md"`. This is a convention, not an automatic fallback — archLoop does not read `.archloop/prompt.md` unless you pass it as `promptFile`.

### Dynamic context with `` !`command` ``

Use `` !`command` `` expressions in your prompt to pull in dynamic context. Each expression is replaced with the command's stdout before the prompt is sent to the agent. All expressions in a prompt run **in parallel** for faster expansion.

Commands run **inside the sandbox** after `sandbox.onSandboxReady` hooks complete, so they see the same repo state the agent sees (including installed dependencies).

```markdown
# Open issues

!`gh issue list --state open --label archLoop --json number,title,body,comments,labels --limit 20`

# Recent commits

!`git log --oneline -10`
```

If any command exits with a non-zero code, the run fails immediately with an error.

### Prompt arguments with `{{KEY}}`

Use `{{KEY}}` placeholders in your prompt to inject values from the `promptArgs` option. This is useful for reusing the same prompt file across multiple runs with different parameters.

```typescript
import { run } from "@yibeibankaishui/archloop";

await run({
  promptFile: "./my-prompt.md",
  promptArgs: { ISSUE_NUMBER: 42, PRIORITY: "high" },
});
```

In the prompt file:

```markdown
Work on issue #{{ISSUE_NUMBER}} (priority: {{PRIORITY}}).
```

Prompt argument substitution runs on the host before shell expression expansion, so `{{KEY}}` placeholders inside `` !`command` `` expressions are replaced first:

```markdown
!`gh issue view {{ISSUE_NUMBER}} --json body -q .body`
```

A `{{KEY}}` placeholder with no matching prompt argument is an error. Unused prompt arguments produce a warning.

`` !`command` `` expansion only runs on shell blocks written in the prompt file itself. Any `` !`…` `` pattern that appears inside an argument value is treated as inert text — it won't be executed against the host shell. This makes it safe to pass user-authored content (issue titles, PR descriptions, docs excerpts) through `promptArgs`.

### Built-in prompt arguments

archLoop automatically injects two built-in prompt arguments into every prompt:

| Placeholder         | Value                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `{{SOURCE_BRANCH}}` | The branch the agent works on (determined by the branch strategy) |
| `{{TARGET_BRANCH}}` | The host's active branch at `run()` time                          |

Use them in your prompt without passing them via `promptArgs`:

```markdown
You are working on {{SOURCE_BRANCH}}. When diffing, compare against {{TARGET_BRANCH}}.
```

Passing `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs` is an error — built-in prompt arguments cannot be overridden.

### Early termination with `<promise>COMPLETE</promise>`

When the agent outputs `<promise>COMPLETE</promise>`, the orchestrator stops the iteration loop early. This is a convention you document in your prompt for the agent to follow — the engine never injects it.

This is useful for task-based workflows where the agent should stop once it has finished, rather than running all remaining iterations.

You can override the default signal by passing `completionSignal` to `run()`. It accepts a single string or an array of strings:

```ts
await run({
  // ...
  completionSignal: "DONE",
});

// Or pass multiple signals — the loop stops on the first match:
await run({
  // ...
  completionSignal: ["TASK_COMPLETE", "TASK_ABORTED"],
});
```

Tell the agent to output your chosen string(s) in the prompt, and the orchestrator will stop when it detects any of them. The matched signal is returned as `result.completionSignal`.

### Structured output

Use `Output.object()` to extract a typed, schema-validated JSON payload from the agent's stdout. The agent emits its answer inside an XML tag you specify, and archLoop parses, validates, and returns it on `result.output`. See [ADR 0010](docs/adr/0010-structured-output.md) for design rationale.

```ts
import { run, Output, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";
import { z } from "zod";

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  prompt: `Analyze the code, and output the result as JSON inside <result> tags.
    The result must match this schema:
    { summary: string; score: string }
  `,
  output: Output.object({
    tag: "result",
    schema: z.object({ summary: z.string(), score: z.number() }),
  }),
});

console.log(result.output.summary); // typed as string
console.log(result.output.score); // typed as number
```

`Output.string({ tag })` extracts the tag contents as a plain string (trimmed, no JSON parsing). Both helpers require `maxIterations` to be `1` (the default). The resolved prompt must contain the configured opening tag literal.

### Templates

`archloop init` prompts you to choose a sandbox provider (`docker` or `no-sandbox`), a backlog manager (GitHub Issues or Beads), a workflow template, and a **Project profile** (your repo's language or build-system shape). It scaffolds a ready-to-use prompt and `main.mts` suited to the workflow. If your project's `package.json` has `"type": "module"`, the file will be named `main.ts` instead. The scaffolded entrypoint reflects the sandbox choice you made during init: `docker` generates `docker(...)`, while `no-sandbox` generates `noSandbox()`. Five templates are available:

| Template                       | Description                                                               |
| ------------------------------ | ------------------------------------------------------------------------- |
| `blank`                        | Bare scaffold — write your own prompt and orchestration                   |
| `simple-loop`                  | Picks issues one by one and closes them                                   |
| `sequential-reviewer`          | Implements issues one by one, with a code review step after each          |
| `parallel-planner`             | Plans parallelizable issues, executes on separate branches, then merges   |
| `parallel-planner-with-review` | Plans parallelizable issues, executes with per-branch review, then merges |

`parallel-planner-with-review` runs review and merge when an issue branch already has commits ahead of your current branch, even if the latest implementer run made no new commits (for example after a prior review failure). Prompts document the implement → review → merge → close lifecycle (only the merge phase closes issues), and the template stops repeated empty implement loops with actionable recovery steps. Re-run `archloop init` in an existing project to pick up template updates.

For GitHub Issues backlogs, scaffolded planner templates list only issues in the current `ready-for-agent` queue (plus the `archLoop` label when label creation is enabled) and fail fast if the planner returns an issue outside that allowed queue.

Select a template during `archloop init` when prompted, or re-run init in a fresh repo to try a different one.

For all templates except `blank`, `.archloop/bootstrap.sh` is the repository bootstrap contract. `archloop init` scaffolds this user-editable script from your Project profile; non-blank templates run it from `sandbox.onSandboxReady` after the worktree is mounted and before the agent runs. Templates do not generate or repair bootstrap at run time. See [Project profiles](#project-profiles) under `archloop init` for the full model.

### Preset agent roles (optional)

After you choose a template, init can optionally add **preset agent roles**. In this mental model, the **template** is the default **workflow**, while a **preset** is an extra **reusable role** (for example reviewer, planner, merger, or WeChat Mini Program–oriented work) with bundled Markdown skills. Selected roles are copied to `.archloop/agents/` and `.archloop/skills/`, and `.archloop/agent-profiles.json` records suggested agent provider, model, and effort. Compose those prompts from `main.mts` with `run()` when you want to involve a role; nothing is auto-wired into the template loop in v1. Provider recommendations are metadata only and may require choosing matching installed runtimes during init.

### Capability packs

A **capability pack** is an explicit **init** choice that specializes archLoop for a class of development work. It composes existing init concepts — **template**, **Project profile**, **preset agents**, **skills**, context files, a verification entrypoint, and optional **capability add-ons** — into one coherent agent environment. archLoop does **not** auto-detect or infer a capability pack from repository files in the first version.

| Concept               | What it controls                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Project profile**   | Language or build-system shape → Dockerfile/Containerfile tools and `.archloop/bootstrap.sh`                             |
| **Template**          | Orchestration workflow (issue loop, parallel planner, reviewer steps, etc.)                                              |
| **Preset agent**      | Reusable role with bundled Markdown **skills** (copied to `.archloop/agents/` and `.archloop/skills/`)                   |
| **Skill**             | Domain guidance file a preset or capability pack references                                                              |
| **Capability pack**   | Domain specialization: defaults for template/profile/presets, context files, `.archloop/verify.sh`, and optional add-ons |
| **Capability add-on** | Narrower optional extension (often sandbox-specific); e.g. WeChat DevTools MCP runtime debugging                         |

First-version packs:

| Pack          | Purpose                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `generic`     | Default low-assumption init (same as omitting `--capability`)                                 |
| `miniprogram` | WeChat Mini Program (native variant): verification loop, setup checklist, Mini Program preset |

Capability packs provide defaults; explicit init flags override them. For example, `--capability miniprogram` defaults to `parallel-planner-with-review`, `node` project profile, and the `miniprogram` preset, but you can still pass `--template`, `--project-profile`, or `--preset-agents` to customize.

When you pass `--capability` explicitly (or choose a non-generic pack interactively), init writes `.archloop/capability.json` as scaffold metadata. Generated verification workflows do **not** require reading the manifest at run time.

#### WeChat Mini Program (`miniprogram`)

Select `miniprogram` during init (`--capability miniprogram`) for native WeChat Mini Programs. Taro, uni-app, mpvue, and other cross-framework outputs are **unsupported** in the first version — the native fallback verifier reports an unsupported variant in `debug/wx-check.log`.

**Init setup**

- Interactive init asks for a capability pack before template selection. Scripted init uses `--capability miniprogram`.
- Init detects project-local `miniprogram-ci` and can offer to install it as a dev dependency (`--install-miniprogram-ci true` in scripted mode). Global CLI and `npx` do not satisfy archLoop's managed loop — the package must live in the project.
- Init writes `.archloop/context/miniprogram-setup.md` with a snapshot of detected AppID, upload key, `wx:check`, and `miniprogram-ci` state plus next-step guidance (not updated by later verification runs).

**AppID and upload key**

- **AppID:** `WX_APPID` overrides `project.config.json`; placeholder or missing AppID keeps platform validation in `not_configured`.
- **Upload key:** prefer `WX_UPLOAD_KEY_PATH` pointing **outside** the repo. Repository-local drop zone: `.archloop/auth/wx-upload/private.{appid}.key` (gitignored). Never commit `private.*.key` files.
- On the [WeChat public platform](https://mp.weixin.qq.com/), configure the code upload private key and **IP allowlist** for CI preview/upload when using `miniprogram-ci`.

**Verification loop**

After Mini Program code changes, run `.archloop/verify.sh` from the repository root:

1. If `npm run wx:check` exists, the wrapper runs it and preserves JSONL diagnostics when the script writes them.
2. Otherwise `.archloop/wx-check-native.mjs` runs native structure checks and optional `miniprogram-ci` preview when platform validation is configured.

Artifacts:

| Path                   | Role                                                 |
| ---------------------- | ---------------------------------------------------- |
| `debug/wx-check.log`   | JSONL diagnostic log (read on failure)               |
| `debug/wx-preview.jpg` | Preview image when `miniprogram-ci` preview succeeds |

`platform_validation_status` in the log is one of: `not_configured`, `configured_missing_tool`, `configured_invalid`, or `passed`. Unconfigured credentials still allow local checks to pass; present but broken configuration fails loudly.

**Final verification summary**

Capability-pack prompts require agents to end work with a structured summary:

- `local`: `passed` or `failed`
- `platform`: `passed`, `not_configured`, or `failed`
- `artifacts`: paths such as `debug/wx-check.log` and `debug/wx-preview.jpg` when they exist

Do not claim full platform validation passed when `platform` is `not_configured`.

**Runtime-debug add-on (`runtime-debug`)**

Optional **no-sandbox only** add-on for WeChat Developer Tools / MCP runtime debugging (simulator, console, screenshots). Interactive init offers it after you choose the `miniprogram` capability and sandbox provider; scripted init uses `--capability-addons runtime-debug`. With Docker sandbox, the add-on appears disabled with an explanation. Init scaffolds context and prompt guidance but does **not** install MCP servers, configure DevTools, or start login flows. Runtime debugging supplements — it does not replace — `.archloop/verify.sh` unless the task explicitly requires runtime evidence.

**Out of scope (first version)**

- **CloudBase** capability add-on (cloud functions, database, storage) is out of scope for the first Mini Program capability version.
- Automatic capability pack inference from repo files.
- `runtime-debug` with Docker sandbox (rejected at init).

## CLI commands

### `archloop init`

Scaffolds the `.archloop/` config directory and optionally builds the sandbox image. This is the legacy repo-local scaffold command, not the Hub-wide onboarding entry point. Interactive init asks for a capability pack (first), default scaffold agent, installed runtimes, sandbox provider, backlog manager, optional capability add-ons (when the pack exposes them), workflow template, and Project profile. Init now offers `docker` and `no-sandbox`: choosing `docker` follows the normal image-build flow, while choosing `no-sandbox` skips image build during init and rewrites the scaffolded `main.mts` or `main.ts` to call `noSandbox()`. After scaffold (and before optional image build), init also points selected tools such as GitHub Issues, Codex, and Cursor toward env keys or Hub-owned auth sessions under the archLoop user data directory. When you select the `miniprogram` capability pack, init may also offer project-local `miniprogram-ci` installation and writes Mini Program verification scaffold files.

Think of the init agent choices as two layers:

- The default scaffold agent (`--agent`) chooses the agent provider and model used in the generated `main.mts` or `main.ts` example.
- The installed runtimes (`--runtimes`) choose which agent CLIs are installed in the sandbox image, which auth directories are mounted, and which token placeholders appear in `.env.example`.

`main.mts`/`main.ts` remains the orchestration surface after init. If you install multiple runtimes, edit that file to import and call the providers you want for each `run()` or `createSandbox()` flow. For scripted init, omit `--runtimes` to install the selected `--agent` runtime, or pass a comma-separated list.

When you pair `--sandbox no-sandbox` with `--backlog beads`, init validates that
`bd` is available from the bundled `@beads/bd` dependency, `ARCHLOOP_BD_PATH`,
or your host `PATH`. In no-sandbox mode, prompt shell expressions run on the
host instead of inside a container, so Beads still needs to be reachable from
the host environment before the generated workflow can run.

With `--sandbox no-sandbox` and `--project-profile python`, bootstrap runs on the host rather than in the Python profile image. Install `python3-venv` and/or `uv` on the host (Debian/Ubuntu: `apt install python3-venv`) so `.archloop/bootstrap.sh` can create a working virtualenv, or use the `docker` sandbox provider so the generated image supplies those tools.

#### Project profiles

**Project profile** is the project type you select during init (`--project-profile` in scripted mode; interactive init asks after workflow template selection). It is independent of workflow **template**, default scaffold **agent**, installed **runtimes**, and **backlog manager**.

Supported first-version profiles:

| Profile   | Purpose                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `generic` | Default. Language-agnostic scaffold with a no-op bootstrap you can edit |
| `node`    | Lockfile-aware Node dependency setup in bootstrap                       |
| `python`  | Python, pip, venv, and uv in the image; setup-only Python bootstrap     |
| `cpp`     | C++ toolchain in the image; setup-only CMake or Makefile bootstrap      |

`generic` is the default. archLoop does **not** auto-detect project type in the first version — pick the closest profile or stay on `generic`. AI-generated bootstrap and automatic detection are out of scope for v1.

What Project profile affects:

- **Dockerfile or Containerfile** — language-specific tool layers composed with agent runtime and backlog manager layers.
- **`.archloop/bootstrap.sh`** — a deterministic, user-editable scaffold script generated at init.
- **Workflow prompts** — stack-specific verification guidance substituted into scaffolded prompt templates (for example npm checks for `node`, pytest-oriented checks for `python`, CMake/Make checks for `cpp`; `generic` stays user-editable).

What Project profile does **not** affect:

- Public runtime APIs (`run()`, `createSandbox()`, sandbox providers, and CLI commands other than `init`).
- **`.env.example`** beyond agent and backlog credentials.
- Cache mounts or `copyToWorktree` defaults.

Bootstrap behavior:

- Generated during init as an editable scaffold; init does **not** run or validate bootstrap.
- Bootstrap is **not** part of image build — it is repository setup that runs at sandbox start.
- Non-blank templates invoke bootstrap from `sandbox.onSandboxReady` after the worktree is mounted and before the agent runs.
- Scaffolded `main.mts` hooks use `timeoutMs: 300_000` (5 minutes) for bootstrap so typical dependency installs are not cut off by the generic 60 s hook default. Edit `timeoutMs` in `.archloop/main.mts` if your setup needs longer.

```bash
# Mini Program capability pack (Docker — core verification loop)
npx archloop init \
  --agent claude-code \
  --runtimes claude-code \
  --sandbox docker \
  --backlog github-issues \
  --capability miniprogram \
  --template parallel-planner-with-review \
  --project-profile node \
  --preset-agents miniprogram \
  --install-miniprogram-ci true \
  --create-archloop-label false \
  --build-image false
```

Omit `--capability` for implicit `generic` without writing `.archloop/capability.json`. Add `--capability-addons runtime-debug` only with `--sandbox no-sandbox` when you want WeChat DevTools MCP guidance on the host.

Existing single-runtime projects remain valid. `archloop init` does not automatically migrate an existing `.archloop/` config directory; it errors instead of overwriting your customizations.

| Option                     | Required | Default                                           | Description                                                                                               |
| -------------------------- | -------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--image-name`             | No       | `archloop:<repo-dir-name>`                        | Docker image name                                                                                         |
| `--agent`                  | No       | Interactive prompt                                | Default scaffold agent (`claude-code`, `pi`, `codex`, `cursor`, `opencode`)                               |
| `--runtimes`               | No       | Selected `--agent` runtime, or interactive prompt | Comma-separated runtimes to install (`claude-code,codex`); `--installed-runtimes` is accepted as an alias |
| `--model`                  | No       | Agent's default model                             | Model to use (e.g. `claude-sonnet-4-6`). Defaults to agent's default                                      |
| `--template`               | No       | Interactive prompt                                | Template to scaffold (e.g. `blank`, `simple-loop`)                                                        |
| `--project-profile`        | No       | `generic`                                         | Project type for containerfile tools and bootstrap (`generic`, `node`, `python`, `cpp`)                   |
| `--sandbox`                | No       | Interactive prompt                                | Sandbox provider (`docker` or `no-sandbox`)                                                               |
| `--backlog`                | No       | Interactive prompt                                | Backlog manager (`github-issues` or `beads`)                                                              |
| `--preset-agents`          | No       | Interactive prompt                                | Comma-separated preset ids (e.g. `reviewer,planner`) or `none`                                            |
| `--capability`             | No       | Implicit `generic`                                | Capability pack (`generic`, `miniprogram`). Explicit non-generic values write `.archloop/capability.json` |
| `--capability-addons`      | No       | None                                              | Comma-separated add-on ids for the selected pack (e.g. `runtime-debug` for `miniprogram` + no-sandbox)    |
| `--install-miniprogram-ci` | No       | Interactive prompt when applicable                | `true`/`false` to install project-local `miniprogram-ci` during `miniprogram` init                        |
| `--create-archloop-label`  | No       | Interactive prompt                                | `true`/`false` for creating the `archLoop` GitHub label                                                   |
| `--build-image`            | No       | Interactive prompt                                | `true`/`false` to build sandbox image after scaffold                                                      |

### `archloop project status`

Reports the selected Hub project by default, or an explicit `--project <name>` target when provided. In a TTY, if no project is selected yet, archLoop opens the Hub project picker; in non-interactive mode it requires a selected project or an explicit target.

The summary includes the canonical git repo root, the archLoop user data directory, the Hub project directory, the selected Hub project profile, the Hub project development contract path, whether `bd` is available, a CLI-first Hub task board summary, and managed branch cleanup diagnostics so you can see safe candidates, blocked reasons, and historical unowned preservation rules without opening run logs. It still works from any directory once a Hub project has been selected or explicitly targeted, even if you have not run `archloop init` in the target repo.

The summary includes task counts by Hub status, active runs and batch statuses, failed tasks with failure reason and suggested next action, sync state counts such as `push_pending` or `conflict`, recent Hub events, paths to Hub run directories for full logs and artifacts, and managed branch cleanup diagnostics with next actions for safe candidates and blocked branches. Output remains useful when Beads is unavailable, there are no tasks, no active runs, or GitHub sync is not configured.

archLoop resolves the user data directory from `XDG_DATA_HOME` when it is set and falls back to `~/.local/share/archloop`.

### `archloop check [--hub] [--project <name>] [--all-projects]`

Runs Hub readiness from any directory. By default, `archloop check` runs the Hub-wide slice plus the CLI selected Hub project when one exists. `--hub` limits the command to Hub-wide checks only, `--project <name>` checks one explicit Hub project, and `--all-projects` checks every registered project.

The Hub-wide slice validates agent role completeness, Hub env/auth presence, configured provider references, provider CLI availability, and grouped provider/model smoke checks through the same provider path used by Hub flow execution. The project slice validates repo path existence, git repository validity, initial commit presence, development contract state, local task store state, ready/failed task summary, active run presence, and flow readiness signals.

It renders visible progress while it runs, deduplicates smoke checks by provider, model, and options, and lists the roles covered by each smoke check. Missing selected projects are warnings with exact `archloop project add` and `archloop project select` guidance; blocking project failures such as a missing repo path return a non-zero exit code when that project is the requested target.

### `archloop initialize [--skip-check]`

Runs the Hub-wide first-run and repair setup. It configures shared Hub agent roles, shared env values, and auth guidance without touching any Hub project. Existing valid settings are preserved; reruns only repair missing Hub-wide readiness. By default it explains that the quick Hub check may make a small provider/model call, runs that check, and then ends by telling you to run `archloop project add`. Pass `--skip-check` to skip the quick check when you intentionally do not want the provider smoke call.

### `archloop project configure`

Creates or updates the Hub project development contract for the selected Hub project. Pass `--project <name>` to target a specific project explicitly, and `--project-profile <profile>` to choose the profile explicitly; supported profiles reuse the init registry (`generic`, `node`, `python`, `cpp`). In an interactive terminal, omitting `--project` opens the Hub project picker when no project is selected, and omitting `--project-profile` picks a profile from a prompt. The contract is written as pretty-printed JSON to the Hub project assets directory under `development-contract.json`.

`project configure` refreshes advisory project facts such as manifests, lockfiles, build files, and configured scripts on every run. Re-running with the same profile preserves any user-edited `setup`, `verify`, and `context` sections while updating the fact snapshot and timestamps. Changing the profile writes a timestamped backup of the previous contract before replacing it.

`project configure` reports the Hub project directory, the selected project profile, the refreshed fact summary, whether user-edited sections were preserved, and any backup path after writing. `project status` shows the same path and profile when the contract already exists, and the generic profile is the fallback when no profile-specific contract has been created yet.

If `archloop run --flow` reaches a repository without a development contract, Hub creates the generic contract first, reports that fallback in the run output, and keeps going. Use `project configure` afterward to write the project-specific contract you actually want Hub flows to consume.

### `archloop project add`

Registers an existing git repo as a Hub project from any directory. Pass `--name <name>` and `--path <repo-path>` in scripts; in a TTY, archLoop prompts for a repo path and Hub project name when they are missing, suggests a repo-derived project name, recommends a project profile from repo signals, and defaults the local task-store prompt to yes.

Successful registration writes the Hub project registry entry, creates the project Hub assets directory, refreshes the Hub project development contract, reports its path, and records the new project as the CLI selected Hub project. If task-store initialization is accepted, archLoop runs `archloop tasks init` for that repo after registration; declining it still leaves the project registered and selected.

### `archloop project list`

Lists registered Hub projects from the shared registry, marks the selected project, and shows each project's repo path, project profile, path validity, local task-store readiness labels, ready/failed/total counts when available, and active run count. The command works from any directory because it reads the shared registry rather than inferring a project from `cwd`.

### `archloop project select [<name>]`

Sets the CLI selected Hub project by name. If no name is provided in a TTY, archLoop opens an interactive picker; in non-interactive mode the name is required. Selection is stored outside the target repo, so it remains available from any directory and does not depend on the current working directory.

### `archloop project rename <project> <new-name>`

Renames an existing Hub project without changing its stable Hub project id. Pass the existing Hub project name or id as the first argument and the new user-facing name as the second argument. Duplicate names are rejected with guidance to inspect `archloop project list` and choose a different name.

### `archloop project relink <project> --path <repo-path>`

Updates an existing Hub project to point at a new host repo path without changing its stable Hub project id. The new path must be an existing git repository with at least one commit, and paths already registered to another Hub project are rejected with guidance to inspect `archloop project list` and choose a different path.

### `archloop agent-config path`

Prints the Hub-wide agent role config file path under the archLoop user data directory. Hub agent roles configure reusable stage providers and models for planning, triage, implementation, review, merge, and recovery. Credentials and login state stay in Hub env files and auth directories, not in role config.

### `archloop agent-config show`

Displays configured Hub agent roles and clearly reports missing roles. Use this before running agent-driven Hub flows to confirm provider/model settings are present.

### `archloop agent-config init`

Runs an interactive wizard to configure all Hub agent roles. After you choose a provider, archLoop offers a provider-specific model picker (default model marked) with a custom-model escape hatch, then prompts for supported provider options such as Codex/Claude effort or Cursor mode. You can apply one provider/model/options set to every role, or configure each role individually. Use this for first-time Hub agent setup.

### `archloop agent-config configure`

Alias for `archloop agent-config init`.

### `archloop agent-config set-role <role> [--provider <provider>] [--model <model>]`

Persists provider, model, and optional provider options for a supported Hub agent role. In an interactive terminal, omit `--provider` and `--model` to configure the role via prompts. In non-interactive mode, both flags are required. Pass `--options` with comma-separated `key=value` pairs for provider-specific settings such as `effort=medium` or `mode=plan`. Role config stores provider/model/options only and rejects credential-like fields.

### `archloop env path`

Prints the Hub-wide env file path under the archLoop user data directory. Hub flows load credentials from this file so you do not need `archloop init` in every target repository.

### `archloop env show`

Displays configured Hub env keys with masked values. `process.env` overrides file values at runtime. Empty known keys include a short acquisition hint and a pointer to `archloop env init`.

### `archloop env init`

Runs an interactive wizard to configure shared Hub env keys such as `CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_KEY`, `OPENCODE_API_KEY`, and `GH_TOKEN`. Before each prompt, the wizard shows provider-specific guidance (including stable documentation URLs) for where to obtain the credential. Leaving a prompt blank keeps the existing value and does not clear it. The wizard prioritizes env keys required by your configured Hub agent roles. For Codex, `OPENAI_KEY` uses OpenAI API billing; use `archloop auth login codex` for a Codex/ChatGPT CLI login session.

### `archloop env configure`

Alias for `archloop env init`.

### `archloop env set <key> [value]`

Persists one Hub env value. In an interactive terminal, omit `value` to enter it securely at a prompt. In non-interactive mode, `value` is required.

### `archloop auth show`

Summarizes provider auth for Hub flows. Each provider reports whether auth is satisfied by `process.env`, the Hub env file, a Hub-owned auth directory/session, or is missing. Providers without first-pass login support, such as Cursor and OpenCode, show `archloop env set ...` guidance.

### `archloop auth path <provider>`

Prints the Hub-owned auth directory for login-capable providers. `archloop auth path codex` prints the `CODEX_HOME` directory; `archloop auth path github` prints the `GH_CONFIG_DIR` directory. Both live under the archLoop user data directory and are reusable across Hub projects.

### `archloop auth login codex`

Runs `codex login` with `CODEX_HOME` set to archLoop's Hub-owned Codex auth directory. This configures a Codex/ChatGPT CLI login session. It is distinct from `OPENAI_KEY`, which remains available through `archloop env set OPENAI_KEY <value>` and uses OpenAI API billing.

### `archloop auth login github`

Runs `gh auth login --insecure-storage` with `GH_CONFIG_DIR` set to archLoop's Hub-owned GitHub auth directory for GitHub Issues task sync. In non-interactive mode, both auth login commands fail with the exact command to run from an interactive shell instead of waiting for browser auth.

### `archloop tasks list`

Shows the Hub task board grouped by canonical Hub task status from Beads data in the current git repository. Use it to inspect inbox, ready, blocked, implementation, review, merge, done, failure, and sync-conflict buckets. Each displayed task includes a 1-based list number that can be used as a task selector in follow-up commands.
Task commands target the selected Hub project by default and accept `--project <name>` for an explicit override.

### `archloop tasks show <task-selector>`

Shows a single Beads task with its Hub status, Beads lifecycle state, claim metadata/state, labels, metadata, comments, remote refs, and run refs when present.

Task selectors resolve in this order: exact Beads id, exact task title, then the 1-based number shown by `archloop tasks list`. Ambiguous title matches fail with candidate ids instead of guessing.

### `archloop tasks create <title>`

Creates a local Beads task in the Hub `inbox` bucket with a `needs-triage` label and `origin` metadata. The `origin` flag defaults to `manual`; pass `--origin user-feedback` for feedback-driven tasks. Use `--description` for the task body and `--kind` for optional extra classification metadata when you need it. `--category` is accepted as an alias for `--kind`.

### `archloop tasks triage [task-id]`

Runs an agent-driven triage proposal flow for `inbox` and `needs_info` Hub tasks. The flow runs no-sandbox, prepares task and project context, invokes the configured **triage** role, lets you refine the recommendation in a proposal session, validates the final structured proposal, checks for unexpected repo or Beads mutations, and applies approved changes to local Beads only after confirmation. Applied comments start with `> *This was generated by AI during triage.*`.

With no arguments in a TTY, archLoop opens a multi-select picker for inbox and needs_info tasks, including an **All inbox and needs_info tasks** option. Pass a Beads task id (for example `bd-42`) to triage one task, or `--query inbox,needs_info` to filter by Hub status. Pass `--yes` or `--approve` for one-shot mode: archLoop still invokes the agent and validates structured output, but only high-confidence, non-closing, non-dependency-changing decisions apply automatically. Wontfix, dependency changes, and medium/low confidence decisions require per-decision confirmation in interactive mode or are skipped as `unconfirmed` in non-interactive mode.

Configure the Hub **triage** agent role before first use (`archloop agent-config init` or `set-role triage`).

### `archloop tasks pull` / `push` / `sync`

Use explicit direction commands for GitHub issue exchange:

- `archloop tasks pull` imports GitHub Issues labeled `archLoop` into Beads. It defaults to open issues only; pass `--include-closed` when you intentionally want closed historical issues.
- `archloop tasks push` sends linked local Hub collaboration state to GitHub. Local `ready_for_agent`, `ready_for_human`, `needs_info`, and `blocked` update GitHub labels; local `done` / `wontfix` closes the linked GitHub issue. It does not pull remote issues or create local tasks.
- `archloop tasks sync --dry-run` previews the combined pull/push plan. `archloop tasks sync` asks for confirmation in a TTY, and non-interactive sync requires `--yes`.

Beads remains the local task store. Execution statuses such as `implementing`, `reviewing`, `waiting_for_merge`, `merging`, and `failed` stay local. Tasks imported from GitHub remain linked through metadata such as `remote_refs` and `github_issue`. If an unlinked GitHub issue has the same normalized title as a local task, archLoop reports a duplicate link candidate instead of silently creating another local task.

### `archloop tasks from-prd <prd-ref>`

Runs the `prd-decomposition` proposal flow for a local PRD file. The flow runs no-sandbox, prepares PRD and project context, invokes the configured **planning** role, opens an interactive proposal session for tracer-bullet vertical slices, asks the agent for a final schema-validated task proposal, checks for unexpected repo or Beads mutations, and writes approved Beads tasks and dependency edges locally.

Interactive sessions let you ask the agent to split, merge, reorder, reclassify, or clarify slices before approval. PRD-derived tasks default to `inbox` (`needs-triage`) unless you explicitly confirm direct `ready_for_agent` / `ready_for_human` creation after reviewing slice granularity, dependency suggestions, AFK/HITL classification, acceptance criteria, and warnings. Pass `--yes` for one-shot mode: archLoop still invokes the agent and validates structured output, creates inbox tasks by default, and does not silently create ready-state tasks.

Configure the Hub **planning** agent role before first use (`archloop agent-config init` or `set-role planning`).

Proposal flows never update GitHub Issues directly. They write local Beads tasks, comments, metadata, and dependency edges only; use `archloop tasks push` when you want collaboration labels or closures pushed to a remote issue tracker.

### `archloop tasks comment <task-selector>`

Appends a readable Beads comment to the task without changing its status. Pass the comment text with `--body`, or omit it to enter the body interactively.

### `archloop tasks recover <task-selector>`

Repairs failed or stale Hub execution state for a single Beads task. Recovery is the explicit command allowed to release stale claim metadata, reset abandoned execution statuses such as `implementing` or `reviewing`, and move recoverable `failed` tasks back to an appropriate collaboration state (`ready_for_agent`, `ready_for_human`, `blocked`, or `wontfix`). If a failed task still has unmerged work on its claimed task branch, recovery moves it back to `waiting_for_merge` instead of rerunning implementation and keeps that branch intact for retry. When a failed task has no remaining branch work and still owns a safe Hub-managed branch, recovery performs best-effort non-force cleanup with `git branch -d`; active worktree leases, checked-out worktrees, dirty preserved worktrees, and preexisting branch ownership block deletion with diagnostics that are included in the recovery comment. For `failed(close_failed)`, recovery checks whether the task branch is already merged into `HEAD`, reruns verification, retries local Beads close, and marks the task `done` without repeating merge. When a failed task has a stale worktree lease but preserved branch work, recovery clears the stale lease metadata path and prepares retry from the preserved worktree without deleting uncommitted changes. Each recovery appends a concise Beads comment starting with `> *This was generated by archLoop during task recovery.*`.

### `archloop tasks doctor`

Audits local Beads task-board state against Hub run events and git branch/worktree state without mutating Beads, git, or remote GitHub Issues. It reports multiple archLoop status labels, stale `metadata.hubStatus`, missing execution claim fields, failed tasks that still have branch work, merge-ready run history that is not selectable for merge, terminal tasks that still carry execution claim metadata, dirty source worktree gates, worktree lease claim/occupancy mismatches (active execution, stale lease with failed claim, active lease without claim), task state that still needs `archloop tasks push`, and managed branch cleanup diagnostics for safe candidates, blocked branches, and historical unowned preservation rules.

Doctor output includes the next action for each finding: rerun the flow, recover a failed task, repair local state, push task sync, or clean up managed branches with `archloop tasks cleanup --yes` or `--include-unowned` when appropriate. Dirty source files are a Git safety warning, not repairable Beads task-state pollution. If a later `run --flow` needs to land merge-ready branch work that overlaps those dirty files, commit, stash, or discard the listed blocking files, then rerun the same flow so the batch resumes.

### `archloop tasks repair-state <task-selector>`

Previews local Beads mutations that would repair task-state pollution for one task. In a TTY it asks for confirmation; in non-interactive mode, pass `--yes` after reviewing the preview. The command does not mutate remote GitHub Issues.

Repair uses the same canonical task transition path as normal Hub lifecycle changes, preserving user custom labels while rewriting only archLoop-managed status labels and metadata. It can restore the QA incident shape where Hub events show `task_review_succeeded`, branch work is still unmerged, but Beads labels/metadata or claim fields are stale, moving the task back to `waiting_for_merge` with the correct claim. Failed agent attempts with `commitCount=0` and no branch work are not promoted by repair-state; use normal recovery policy for failed tasks.

### `archloop tasks cleanup`

Previews and confirms cleanup of Hub-managed task branches. By default, archLoop only deletes safe managed branches that are already merged and proven to be Hub-owned. Historical unowned `archloop/...` branches remain listed as candidates but are preserved unless you pass `--include-unowned`. Use `--dry-run` to preview without deleting any git refs.

### `archloop tasks delete <task-selector> [task-selector...]`

Permanently deletes one or more local Beads tasks. This is destructive removal, not lifecycle close: Hub merge/triage/recovery use close to mark work done locally while keeping the Beads record. Delete removes the task from Beads and does not delete remote GitHub issues.

Task selectors match `tasks show` and `tasks comment` (Beads id, exact title, or `tasks list` number). Pass multiple selectors in one command to batch-delete. In a TTY, archLoop previews with Beads dry-run output and asks for confirmation. In non-interactive mode, pass `--yes` to confirm or `--dry-run` to preview only. `--cascade` passes through to Beads to recursively delete dependent tasks when a blocker would otherwise fail deletion.

### `archloop run [<project> | --project <name>] --flow <id>`

Runs a Hub-owned flow against the selected Hub project by default. In a TTY, archLoop opens the Hub project picker when no project is selected and opens a flow picker when `--flow` is omitted. Hub flows use bundled prompts from archLoop itself, not repo-local `.archloop/` prompt files. Legacy path calls like `archloop run . --flow with-review` still work temporarily and print migration guidance toward `archloop project add` / `archloop project select`.

The first available task-board flows are `no-review` and `with-review`. Proposal flows `prd-decomposition` and `triage` run through the shared proposal session runtime: `archloop run --flow prd-decomposition --input <prd-ref>` and `archloop run --flow triage --input <task-id|statuses>` execute end-to-end. Task-board flow implementers now read the Hub project development contract before prompting the agent; if no contract exists, `run --flow` creates a generic fallback contract, reports how to specialize it with `archloop project configure [--project <name>] --project-profile <profile>`, and then continues. The matching `archloop tasks` shortcuts remain the recommended entry points.

When `--flow` targets `prd-decomposition` or `triage`, archLoop runs the same agent-driven proposal path as the task shortcut: no-sandbox execution, Hub-wide role config, structured output validation, proposal artifacts in the Hub run directory, mutation detection before apply, and local-only Beads writes. Remote issue updates remain outside proposal flows and happen through explicit `archloop tasks pull`, `tasks push`, or confirmed `tasks sync`.

The `no-review` flow reads the Beads ready queue, selects a batch of eligible `ready_for_agent` tasks, claims the selected tasks, starts their implementers concurrently with task id/title/branch supplied by TypeScript orchestration, and advances successful work to `waiting_for_merge`. After a successful batch completes, Hub reloads the ready queue and continues with the next batch until the queue is empty or `--max-batches` is reached. Agent or sandbox failures move tasks to `failed` with a failure reason.

The `with-review` flow adds a reviewer stage after implementation: successful work moves to `reviewing`, the reviewer receives the task branch and diff/commit context from orchestration, and completed review advances the task to `waiting_for_merge`. Selected task pipelines run in parallel within each batch; each task's reviewer starts after that task's implementation succeeds. After each successful batch, Hub reloads the ready queue and continues with the next batch until the queue is empty or `--max-batches` is reached. Review failures move tasks to `failed` with a failure reason.

Hub flow runs now also write a run-level completion event and the CLI summary reports aggregate completed batches, completed tasks, and the stop reason for the execution slice. The stop reason is one of `no_ready_tasks`, `max_batches_reached`, or `batch_failed`: the first two are successful exits, and `batch_failed` means the flow stopped for recovery.

Task-board flows treat `ready_for_agent` as the **candidate pool**, not the automatic execution set. The **selected flow batch** is the subset chosen by the configured batch strategy before claim. Selected batch tasks run concurrently through implementation and any per-branch review; the merge phase waits for them and remains serialized. After each successful batch, Hub refreshes the ready queue and can start another batch until the flow exhausts the queue or hits `--max-batches`. If the planned batch planner returns a valid empty selection, Hub treats that as no safe batch for the current base and stops without claiming a conservative fallback task. By default, `no-review` and `with-review` use the `planned` strategy with a maximum of **3** tasks per batch. Override with `--batch-strategy`, `--max-tasks`, and `--max-batches`:

| Strategy            | Behavior                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned` (default) | Uses a flow-owned batch planner to choose a safe parallel subset when available. Valid empty selections stop without claims; planner failures or invalid output fall back to `conservative` selection and record a fallback reason in Hub batch events and CLI output. |
| `limited`           | Selects the first eligible candidates in Beads ready-queue order, up to `--max-tasks`.                                                                                                                                                                                 |
| `conservative`      | Selects at most one eligible ready task.                                                                                                                                                                                                                               |

Hub batch planner candidates expose only structured blocker state to the planner. `openBlockers=[]` and `unknownBlockers=[]` mean the candidate is unblocked, even if the task body still contains stale `## Blocked by` prose. The planner does not infer blockers from raw description text.
If the planner returns an `explicit_blocker` deferral for a candidate with no live `openBlockers`, no `unknownBlockers`, and no dependency on a selected task, Hub rejects that deferral, recovers the safe candidate up to `maxTasks`, and records `invalid_explicit_blocker_deferral` in the batch event/CLI diagnostics.

At `archloop run --flow <id>` startup, Hub warns early when the source worktree has dirty source files. If the same flow has an unfinished previous batch with tasks still in `waiting_for_merge`, the run creates a fresh Hub run directory for the retry and resumes that old batch's merge selection by its original batch id before planning or claiming new `ready_for_agent` tasks. Ready tasks that exist at the same time stay unclaimed until the resumed merge batch completes. When the host worktree is dirty, Hub checks whether the pending merge-ready branches would touch the same paths and lists exact blocking files before any fresh tasks are claimed. If that resumed merge selection is blocked by stale state, inconsistent state, or dirty-file overlap, Hub stops the flow with `batch_failed` instead of falling through to a fresh queue scan. Failed, stale, or inconsistent task states are reported with explicit recovery or repair guidance instead of being automatically modified.

After implementation and review complete, Hub evaluates all merge candidates and records selected/skipped/blocked reasons in batch events and CLI output. It selects tasks only when they are `waiting_for_merge`, belong to the current batch, have claim branch metadata, and the branch still has unmerged work. Status mismatches, batch mismatches, missing claims, missing branches, and branches with no unmerged work are explained before merge starts. If Hub run events show a task reached merge-ready state but the Beads projection is stale or missing claim fields while branch work still exists, merge selection reports `state_inconsistent` with the projected status, claim drift, branch, and an explicit `archloop tasks repair-state <selector>` repair hint instead of silently skipping it.

Before merging, Hub preflights the source worktree. Dirty source files that do not overlap the files a selected branch would land do not block the batch: Hub verifies the merge in a clean integration worktree/branch, then lands it back only if the host dirty paths still do not overlap. If dirty files would be overwritten or conflict with the merge result, the task remains `waiting_for_merge` and CLI output lists the blocking files with the remediation: commit, stash, or discard those files, then rerun the same `archloop run --flow <id>` command. archLoop will resume the waiting merge batch before claiming new work. Dirty Beads runtime/export files such as `.beads/issues.jsonl` and `.beads/interactions.jsonl` are classified separately and do not block by themselves, because Hub task-board state is local task-store state. If a task branch changes `.beads/` runtime/export files, that branch is blocked before merge; use `archloop tasks pull` / `push` / `sync` for remote task exchange instead of carrying Beads local state through code branches.

Hub moves selected tasks to `merging`, merges each branch with per-task events, runs verification after each merge, and closes the local Beads task only when merge, verification, and close all succeed. After a successful close, Hub attempts best-effort cleanup of the safe managed task branch with non-force `git branch -d`; cleanup failures emit cleanup events and warnings but do not change the task out of `done`. Clean merges use Git directly. When Git reports a merge conflict, Hub invokes the configured `merge` agent role to resolve the conflicted worktree, then checks that no unmerged files or unfinished merge state remain before continuing to verification and task close. Generic merge failures, unresolved merge conflicts, verification failures, close failures, or dirty-overlap landing failures stop the selected batch: the current task becomes `failed` only for true merge/verification/close failures, while dirty-overlap blocks keep affected tasks in `waiting_for_merge`. Unprocessed selected tasks return to `waiting_for_merge`, and the batch becomes `partial_failed` or stops as `batch_failed` depending on where the failure happened. Merge and dirty-overlap failures preserve a concise Git diagnostic summary in task/batch events and in CLI output so you can decide whether to configure the merge role, clean the blocking files, resolve a conflict, or retry.

| Option             | Required | Description                                                                                                                     |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--flow`           | Yes      | Hub flow id (`no-review`, `with-review`, `prd-decomposition`, `triage`)                                                         |
| `--input`          | No       | Flow-specific input (`<prd-ref>` for `prd-decomposition`; Beads task id or task query for `triage`, default `inbox,needs_info`) |
| `--batch-strategy` | No       | Task-board batch selection strategy (`planned`, `limited`, `conservative`; default `planned`)                                   |
| `--max-tasks`      | No       | Maximum tasks to select for a task-board batch (1–10; default `3`)                                                              |
| `--max-batches`    | No       | Maximum task-board batches to complete in one run (positive integer; unlimited by default)                                      |

Hub flow runs write run, batch, task, and run-completion event records into the Hub run directory under the archLoop user data directory. The task board uses that run history to keep claims and execution progress separate from normal Beads task status.

Creates the following files (plus optional `agents/`, `skills/`, `agent-profiles.json`, and Mini Program capability files when applicable):

```
.archloop/
├── Dockerfile      # Sandbox environment (customize as needed)
├── bootstrap.sh    # Repo setup hook (from Project profile; customize as needed)
├── main.mts        # Orchestration entry (or main.ts)
├── prompt.md       # Agent instructions
├── .env.example    # Token placeholders
└── .gitignore      # Ignores .env, logs/

# When --capability miniprogram (or explicit non-generic pack):
├── capability.json           # Init-time metadata (optional record)
├── verify.sh                   # Mini Program verification entrypoint
├── wx-check-native.mjs         # Native fallback verifier
├── context/
│   ├── miniprogram.md
│   └── miniprogram-setup.md    # Init-time setup checklist snapshot
└── auth/wx-upload/             # Gitignored upload-key drop zone
```

Errors if `.archloop/` already exists to prevent overwriting customizations.

### `archloop docker build-image`

Rebuilds the Docker image from an existing `.archloop/` directory. Use this after modifying the Dockerfile. On Linux/macOS, the build automatically passes `--build-arg AGENT_UID=$(id -u)` and `AGENT_GID=$(id -g)` so the image's `agent` user matches the host UID — this prevents permission errors on image-built files without runtime chown.

**WSL2 / root (UID 0):** archLoop cannot bake UID 0 into the image (`usermod` would conflict with root). When the host process is root, `build-image` uses `AGENT_UID=1000` and `AGENT_GID=1000` instead and prints guidance. Pass `containerUid: 1000` and `containerGid: 1000` to `docker()` in `.archloop/main.mts` so the runtime `--user` matches the image (see the Docker provider pre-flight check if they diverge).

| Option         | Required | Default                    | Description                                                                       |
| -------------- | -------- | -------------------------- | --------------------------------------------------------------------------------- |
| `--image-name` | No       | `archloop:<repo-dir-name>` | Docker image name                                                                 |
| `--dockerfile` | No       | —                          | Path to a custom Dockerfile (build context will be the current working directory) |

### `archloop docker remove-image`

Removes the Docker image.

| Option         | Required | Default                    | Description       |
| -------------- | -------- | -------------------------- | ----------------- |
| `--image-name` | No       | `archloop:<repo-dir-name>` | Docker image name |

### `archloop podman build-image`

Builds the Podman image from an existing `.archloop/` directory. Use this after modifying the Containerfile.

| Option            | Required | Default                    | Description                                                                          |
| ----------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `--image-name`    | No       | `archloop:<repo-dir-name>` | Podman image name                                                                    |
| `--containerfile` | No       | —                          | Path to a custom Containerfile (build context will be the current working directory) |

### `archloop podman remove-image`

Removes the Podman image.

| Option         | Required | Default                    | Description       |
| -------------- | -------- | -------------------------- | ----------------- |
| `--image-name` | No       | `archloop:<repo-dir-name>` | Podman image name |

### `RunOptions`

| Option               | Type               | Default                       | Description                                                                                                                                                                  |
| -------------------- | ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`              | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-6")`, `pi("claude-sonnet-4-6")`, `codex("gpt-5.4-mini")`, `cursor("auto")`, `opencode("opencode/big-pickle")`) |
| `sandbox`            | SandboxProvider    | —                             | **Required.** Sandbox provider (e.g. `docker()`, `podman()`, `docker({ imageName: "archloop:local" })`)                                                                      |
| `cwd`                | string             | `process.cwd()`               | Host repo directory — anchor for `.archloop/` artifacts and git operations. Relative paths resolve against `process.cwd()`.                                                  |
| `prompt`             | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                                                                                                                         |
| `promptFile`         | string             | —                             | Path to prompt file (mutually exclusive with `prompt`). Resolves against `process.cwd()`, **not** `cwd`.                                                                     |
| `maxIterations`      | number             | `1`                           | Maximum iterations to run                                                                                                                                                    |
| `hooks`              | SandboxHooks       | —                             | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                                                                                      |
| `name`               | string             | —                             | Display name for the run, shown as a prefix in log output                                                                                                                    |
| `promptArgs`         | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                                                                                                                         |
| `branchStrategy`     | BranchStrategy     | per-provider default          | Branch strategy: `{ type: 'head' }`, `{ type: 'merge-to-head' }`, or `{ type: 'branch', branch: '…' }`                                                                       |
| `copyToWorktree`     | string[]           | —                             | Host-relative file paths to copy into the sandbox before start (not supported with `branchStrategy: { type: 'head' }`)                                                       |
| `logging`            | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                                                                                                                             |
| `completionSignal`   | string \| string[] | `<promise>COMPLETE</promise>` | String or array of strings the agent emits to stop the iteration loop early                                                                                                  |
| `idleTimeoutSeconds` | number             | `600`                         | Idle timeout in seconds — resets on each agent output event                                                                                                                  |
| `resumeSession`      | string             | —                             | Resume a prior Claude Code session by ID. Incompatible with `maxIterations > 1`. Session file must exist on host.                                                            |
| `signal`             | AbortSignal        | —                             | Cancel the run when aborted. Kills the in-flight agent subprocess and cancels lifecycle hooks; the worktree is preserved on disk. Rejects with `signal.reason`.              |
| `timeouts`           | Timeouts           | —                             | Override default timeouts for built-in lifecycle steps. Currently supports `{ copyToWorktreeMs?: number }` (default: 60 000).                                                |
| `output`             | OutputDefinition   | —                             | Structured output definition (`Output.object(…)` or `Output.string(…)`). Requires `maxIterations === 1`. See [Structured output](#structured-output).                        |

### `RunResult`

| Field              | Type                | Description                                                        |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `iterations`       | `IterationResult[]` | Per-iteration results (use `.length` for the count)                |
| `completionSignal` | string?             | The matched completion signal string, or `undefined` if none fired |
| `stdout`           | string              | Agent output                                                       |
| `commits`          | `{ sha }[]`         | Commits created during the run                                     |
| `branch`           | string              | Target branch name                                                 |
| `logFilePath`      | string?             | Path to the log file (only when logging to a file)                 |
| `output`           | T?                  | Typed structured output (only present when `output` option is set) |

### `IterationResult`

| Field             | Type              | Description                                                                                                                         |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`       | string?           | Claude Code session ID from the init line, or `undefined` for non-Claude agents                                                     |
| `sessionFilePath` | string?           | Absolute host path to the captured session JSONL, or `undefined` when capture is off                                                |
| `usage`           | `IterationUsage`? | Token usage snapshot from the last assistant message, or `undefined` when capture is off or provider does not support usage parsing |

### `IterationUsage`

| Field                      | Type   | Description                                |
| -------------------------- | ------ | ------------------------------------------ |
| `inputTokens`              | number | Input tokens consumed                      |
| `cacheCreationInputTokens` | number | Tokens used to create prompt cache entries |
| `cacheReadInputTokens`     | number | Tokens read from prompt cache              |
| `outputTokens`             | number | Output tokens generated                    |

### Session capture

After each Claude Code iteration, archLoop automatically captures the agent's session JSONL from the sandbox to the host at `~/.claude/projects/<encoded-path>/sessions/<session-id>.jsonl`. The `cwd` fields inside each JSONL entry are rewritten to match the host repo root, so `claude --resume` works natively.

Session capture is enabled by default for `claudeCode()` and can be opted out via `captureSessions: false`. Non-Claude agent providers never attempt capture. Capture failure fails the run.

### Session resume

Pass `resumeSession` to `run()` to continue a prior Claude Code conversation inside a new sandbox:

```typescript
const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  prompt: "Continue where you left off",
  resumeSession: "abc-123-def",
});
```

Before the sandbox starts, archLoop validates that the session file exists on the host and transfers it into the sandbox with `cwd` fields rewritten to match the sandbox-side path. The Claude Code agent receives `--resume <id>` on its print command for iteration 1.

Constraints:

- `resumeSession` is incompatible with `maxIterations > 1` (throws before sandbox creation).
- The session file must exist at `~/.claude/projects/<encoded-path>/sessions/<id>.jsonl` (throws before sandbox creation).
- Only iteration 1 receives the resume flag; subsequent iterations (if any) start fresh.
- Non-Claude agent providers ignore `resumeSession`.

### `ClaudeCodeOptions`

The `claudeCode()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: claudeCode("claude-opus-4-6", { effort: "high" });
```

| Option            | Type                                         | Default | Description                                               |
| ----------------- | -------------------------------------------- | ------- | --------------------------------------------------------- |
| `effort`          | `"low"` \| `"medium"` \| `"high"` \| `"max"` | —       | Claude Code reasoning effort level (`max` is Opus only)   |
| `env`             | `Record<string, string>`                     | `{}`    | Environment variables injected by this agent provider     |
| `captureSessions` | `boolean`                                    | `true`  | Capture agent session JSONL to host for `claude --resume` |

### `CodexOptions`

The `codex()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: codex("gpt-5.4", { effort: "high" });
```

| Option   | Type                                           | Default | Description                                               |
| -------- | ---------------------------------------------- | ------- | --------------------------------------------------------- |
| `effort` | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | —       | Codex reasoning effort level via `model_reasoning_effort` |
| `env`    | `Record<string, string>`                       | `{}`    | Environment variables injected by this agent provider     |

### `CursorOptions`

The `cursor()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: cursor("auto", { mode: "plan" });
```

| Option | Type                     | Default | Description                                           |
| ------ | ------------------------ | ------- | ----------------------------------------------------- |
| `mode` | `"plan"` \| `"ask"`      | —       | Cursor Agent mode. Omit for full coding mode          |
| `env`  | `Record<string, string>` | `{}`    | Environment variables injected by this agent provider |

### Provider `env`

Both **agent providers** and **sandbox providers** accept an optional `env: Record<string, string>` in their options. These environment variables are merged with the `.archloop/.env` resolver output at launch time:

```typescript
await run({
  agent: claudeCode("claude-opus-4-6", {
    env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  }),
  sandbox: docker({
    env: { DOCKER_SPECIFIC_VAR: "value" },
  }),
  prompt: "Fix issue #42",
});
```

**Merge rules:**

- Provider env (agent + sandbox) overrides `.archloop/.env` resolver output for shared keys
- Agent provider env and sandbox provider env **must not overlap** — if they share any key, `run()` throws an error
- When `env` is not provided, it defaults to `{}`

Environment variables are also resolved automatically from `.archloop/.env` and `process.env` — no need to pass them to the API. The required variables depend on the **agent provider** (see `archloop init` output for details).

## Custom Sandbox Providers

archLoop ships with built-in providers for Docker, Podman, and Vercel, but you can create your own. A sandbox provider tells archLoop how to execute commands in an isolated environment. There are two kinds:

- **Bind-mount** — the sandbox can mount a host directory. archLoop creates a worktree on the host and the provider mounts it in. No file sync needed. Use this for Docker, Podman, or any local container runtime.
- **Isolated** — the sandbox has its own filesystem (e.g. a cloud VM). The provider handles syncing code in and out via `copyIn` and `copyFileOut`. Use this when the sandbox cannot access the host filesystem.

### The sandbox handle contract

Both provider types return a **sandbox handle** from their `create()` function. The handle exposes:

| Method         | Required   | Description                                                                  |
| -------------- | ---------- | ---------------------------------------------------------------------------- |
| `exec`         | Both       | Run a command, optionally streaming stdout line-by-line via `options.onLine` |
| `close`        | Both       | Tear down the sandbox                                                        |
| `copyFileIn`   | Bind-mount | Copy a single file from the host into the sandbox                            |
| `copyFileOut`  | Both       | Copy a single file from the sandbox to the host                              |
| `copyIn`       | Isolated   | Copy a file or directory from the host into the sandbox                      |
| `worktreePath` | Both       | Absolute path to the repo directory inside the sandbox                       |

### `ExecResult`

Every `exec` call returns an `ExecResult`:

```typescript
interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
```

### Bind-mount provider example

A minimal bind-mount provider that shells out to local processes (no container):

```typescript
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "@yibeibankaishui/archloop";
import { execFile, spawn } from "node:child_process";
import { copyFile as fsCopyFile, mkdir as fsMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const localProcess = () =>
  createBindMountSandboxProvider({
    name: "local-process",
    create: async (
      options: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const worktreePath = options.worktreePath;

      return {
        worktreePath,

        exec: (
          command: string,
          opts?: { onLine?: (line: string) => void; cwd?: string },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line); // forward each line to archLoop
              });

              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });

              proc.on("error", (err) => reject(err));
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        copyFileIn: async (hostPath: string, sandboxPath: string) => {
          await fsMkdir(dirname(sandboxPath), { recursive: true });
          await fsCopyFile(hostPath, sandboxPath);
        },

        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          await fsMkdir(dirname(hostPath), { recursive: true });
          await fsCopyFile(sandboxPath, hostPath);
        },

        close: async () => {
          // nothing to tear down for a local process
        },
      };
    },
  });
```

### Isolated provider example

A minimal isolated provider using a temp directory:

```typescript
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
  type ExecResult,
} from "@yibeibankaishui/archloop";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const tempDir = () =>
  createIsolatedSandboxProvider({
    name: "temp-dir",
    create: async (): Promise<IsolatedSandboxHandle> => {
      const root = await mkdtemp(join(tmpdir(), "sandbox-"));
      const worktreePath = join(root, "workspace");
      await mkdir(worktreePath, { recursive: true });

      return {
        worktreePath,

        exec: (
          command: string,
          opts?: { onLine?: (line: string) => void; cwd?: string },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line);
              });

              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });

              proc.on("error", (err) => reject(err));
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        copyIn: async (hostPath: string, sandboxPath: string) => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            await cp(hostPath, sandboxPath, { recursive: true });
          } else {
            await mkdir(dirname(sandboxPath), { recursive: true });
            await copyFile(hostPath, sandboxPath);
          }
        },

        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },

        close: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
```

### Branch strategies

A branch strategy controls where the agent's commits land. Configure it when constructing the provider:

| Strategy        | Behavior                                                                 | Bind-mount | Isolated  |
| --------------- | ------------------------------------------------------------------------ | ---------- | --------- |
| `head`          | Agent writes directly to the host working directory. No worktree created | Default    | N/A       |
| `merge-to-head` | archLoop creates a temp branch, merges back to HEAD when done            | Supported  | Default   |
| `branch`        | Commits land on an explicit named branch you provide                     | Supported  | Supported |

**When to use each:**

- **`head`** — fast iteration during development. No branch indirection, no merge step. Only works with bind-mount providers since the agent needs direct host filesystem access.
- **`merge-to-head`** — safe default for automation. The agent works on a throwaway branch; if something goes wrong, HEAD is untouched. Use this for CI or unattended runs.
- **`branch`** — when you want commits on a specific branch (e.g. for a PR). Pass `{ type: "branch", branch: "agent/fix-42" }`.

Branch strategy is now configured on `run()`, not on the provider:

```typescript
import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

// head — direct write, bind-mount only (default for bind-mount providers)
await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  prompt: "…",
});
// merge-to-head — temp branch, merge back (default for isolated providers)
await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: tempDir(),
  prompt: "…",
});
// branch — explicit named branch
await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  prompt: "…",
});
```

### Passing to `run()`

Pass your custom provider via the `sandbox` option — it works the same as the built-in `docker()` provider:

```typescript
import { run, claudeCode } from "@yibeibankaishui/archloop";

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: localProcess(), // your custom provider
  prompt: "Fix issue #42 in this repo.",
});
```

### Reference implementations

For real-world examples, see:

- [`src/sandboxes/docker.ts`](src/sandboxes/docker.ts) — bind-mount provider using Docker containers (with SELinux label support)
- [`src/sandboxes/vercel.ts`](src/sandboxes/vercel.ts) — isolated provider using Vercel Firecracker microVMs via `@vercel/sandbox`
- [`src/sandboxes/podman.ts`](src/sandboxes/podman.ts) — bind-mount provider using Podman containers (with SELinux label support)
- [`src/sandboxes/test-isolated.ts`](src/sandboxes/test-isolated.ts) — isolated provider using temp directories (used in tests)

## Configuration

### Config directory (`.archloop/`)

All per-repo sandbox configuration lives in `.archloop/`. Run `archloop init` to create it.

### Custom Dockerfile

The `.archloop/Dockerfile` controls the sandbox environment. The default template installs:

- **Node.js 22** (base image)
- **git**, **curl**, **jq** (system dependencies)
- **GitHub CLI** (`gh`)
- **Claude Code CLI**
- A non-root `agent` user (required — Claude runs as this user)

When customizing the Dockerfile, ensure you keep:

- A non-root user (the default `agent` user) for Claude to run as
- `git` (required for commits and branch operations)
- `gh` (required for issue fetching)
- Claude Code CLI installed and on PATH

Add your project-specific dependencies (e.g., language runtimes, build tools) to the Dockerfile as needed.

### Hooks

Hooks are grouped by **where** they run — `host` (on the developer's machine) or `sandbox` (inside the container):

```ts
hooks: {
  host: {
    onWorktreeReady: [{ command: "cp .env.example .env" }],
    onSandboxReady:  [{ command: "echo sandbox is up" }],
  },
  sandbox: {
    onSandboxReady: [
      { command: "npm install", timeoutMs: 300_000 },
      { command: "apt-get install -y ffmpeg", sudo: true },
    ],
  },
}
```

| Hook                     | Runs on | When                                         | Working directory                           |
| ------------------------ | ------- | -------------------------------------------- | ------------------------------------------- |
| `host.onWorktreeReady`   | Host    | After `copyToWorktree`, before sandbox start | Worktree path (host repo root under `head`) |
| `host.onSandboxReady`    | Host    | After sandbox is up                          | Worktree path (host repo root under `head`) |
| `sandbox.onSandboxReady` | Sandbox | After sandbox is up                          | Sandbox repo directory                      |

**Ordering:** `copyToWorktree` -> `host.onWorktreeReady` (sequential) -> sandbox created -> `host.onSandboxReady` + `sandbox.onSandboxReady` (parallel).

- **Host hooks** accept `{ command: string; timeoutMs?: number }` — no `sudo`, no `cwd`. Use `cd` or inline env in the command string.
- **Sandbox hooks** accept `{ command: string; sudo?: boolean; timeoutMs?: number }` — set `sudo: true` for elevated privileges.
- **`timeoutMs`** overrides the default 60 s per-hook timeout. Useful for long-running setup commands like dependency installs (e.g. `timeoutMs: 300_000` for 5 minutes).
- Within each hook point, sandbox hooks run in parallel; host hooks within `onSandboxReady` also run in parallel with sandbox hooks. `host.onWorktreeReady` hooks run sequentially in declared order.
- If any hook exits non-zero, setup fails fast.
- When a `signal` is passed to `run()`, it is threaded to all hooks — aborting the signal cancels any in-flight hook commands.

## Agent skill

This repo ships a portable agent skill at [`skills/archloop-usage/SKILL.md`](./skills/archloop-usage/SKILL.md) that teaches AI coding agents (Cursor, Claude, Codex, and others) how to set up and run archLoop in a target project.

It is **not auto-installed**. To make it available to your agent, copy the skill directory into one of your agent's skills directories:

```bash
# Pick the directory matching your agent (create it if missing):
cp -R skills/archloop-usage ~/.agents/skills/archloop-usage    # portable / shared
cp -R skills/archloop-usage ~/.cursor/skills/archloop-usage    # Cursor
cp -R skills/archloop-usage ~/.claude/skills/archloop-usage    # Claude
cp -R skills/archloop-usage ~/.codex/skills/archloop-usage     # Codex
```

After a archLoop release that changes CLI, init flow, templates, or APIs, re-copy the updated skill to pick up the changes.

## Development

```bash
npm install
npm run build    # Build with tsgo
npm test         # Run tests with vitest
npm run typecheck # Type-check
```

## License

MIT
