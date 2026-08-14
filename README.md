<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-archloop-ondark_2x.png">
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-archloop-onlight_2x.png">
    <img alt="archLoop" src="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-archloop-onlight_2x.png" height="200">
  </picture>
</div>

archLoop orchestrates AI coding agents across Git projects, tasks, isolated
sandboxes, reviews, and merges. Use the CLI for a complete task workflow or the
TypeScript API to build your own orchestration.

## Choose your path

| I want to…                                 | Start here                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Set up archLoop and run project tasks      | [Hub quick start](#hub-quick-start-recommended)                                   |
| Integrate archLoop in TypeScript           | [TypeScript API](#typescript-api)                                                 |
| Maintain an existing `.archloop/` scaffold | [Legacy repo-local setup](./docs/content/docs/guides/legacy-repo-local-setup.mdx) |
| Fix a failed run or configuration problem  | [Troubleshooting](./docs/content/docs/reference/troubleshooting.mdx)              |

## What archLoop handles

- A shared Hub registry for multiple Git projects
- Agent roles for planning, implementation, review, merge, triage, and recovery
- Local Beads-backed tasks stored in the Hub project directory, with automatic
  migration from a repository-local Beads store (deferred while a writer is
  active; split brain after redirect stops automatic writes) and optional
  GitHub Issues synchronization. Hub flow agents receive an immutable task
  snapshot; Hub applies structured notes after each attempt.
- Docker, Podman, Vercel, Daytona, and explicit no-sandbox execution
- Git branches and worktrees for isolated changes
- Review and merge flows with recovery after interrupted runs
- Local-first landing onto a Hub publish target: a verified candidate ships
  without a remote and without mutating the user's checkout. Publication stays
  off until `archloop project configure --publish-policy` sets it. Interrupted
  landings resume from durable evidence on the next run. Independent siblings
  keep landing when one task is blocked; repair is bounded.
- Plain terminal and JSONL output for automation
- Reusable TypeScript primitives such as `run()`, `createSandbox()`, and
  `createWorktree()`

## Prerequisites

- Node.js and npm
- Git, with at least one commit in every project archLoop will manage
- Credentials or a CLI login for the selected agent provider
- Docker or Podman when the selected workflow uses a local container sandbox

## Hub quick start (recommended)

Install archLoop in the project from which you want to invoke the CLI:

```bash
npm install --save-dev @yibeibankaishui/archloop
```

Configure shared agent roles and credentials:

```bash
npx archloop initialize
```

Register an existing Git repository. In an interactive terminal, archLoop asks
for its path, name, project profile, and whether to initialize the local task
store.

```bash
npx archloop project add
```

Check Hub and project readiness:

```bash
npx archloop check
```

Run the selected project's implementation and review flow:

```bash
npx archloop run --flow with-review
```

Use `npx archloop project list` and `npx archloop project select <name>` to move
between registered projects from any directory.

## Common workflows

### Manage projects

```bash
npx archloop project list
npx archloop project status
npx archloop project select <name>
npx archloop project configure --project-profile node
npx archloop project configure --project-profile node --publish-policy off
```

### Manage tasks

```bash
npx archloop tasks list
npx archloop tasks create "Improve the empty state"
npx archloop tasks show <task-id>
npx archloop tasks triage <task-id>
```

### Synchronize GitHub Issues

```bash
npx archloop tasks pull
npx archloop tasks sync --dry-run
npx archloop tasks sync
```

### Run flows

```bash
npx archloop run --flow no-review
npx archloop run --flow with-review
npx archloop run --flow with-review --dry-run
npx archloop run --flow with-review --output json
```

The task-board flows resume unfinished merge-ready work before claiming new
tasks. Eligible tasks land through a durable fenced transaction onto a
Hub-managed local Git ref; the checkout, index, and WIP stay untouched.
Publication remains off unless configured. Use `archloop project status`,
`archloop tasks doctor`, and `archloop tasks recover <task-id>` when a run
needs attention.

## TypeScript API

Use `run()` for a one-shot agent invocation:

```typescript
import { claudeCode, run } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  prompt: "Implement the requested change and verify it.",
});

console.log(result.commits);
```

The public API also includes:

| API                                   | Use it when…                                         |
| ------------------------------------- | ---------------------------------------------------- |
| `interactive()`                       | A person should work in an interactive agent session |
| `createSandbox()`                     | Several agents or rounds should share one sandbox    |
| `createWorktree()`                    | A worktree needs an independent lifecycle            |
| `Output.object()` / `Output.string()` | One invocation must return structured output         |

Built-in agent providers are `claudeCode()`, `codex()`, `cursor()`,
`opencode()`, and `pi()`. Built-in sandbox packages include Docker, Podman,
Vercel, Daytona, and no-sandbox providers.

See the [API guide](./docs/content/docs/api/index.mdx) for lifecycle rules,
branch strategies, prompts, hooks, and result types.

## Documentation

| Topic                                     | Documentation                                                    |
| ----------------------------------------- | ---------------------------------------------------------------- |
| First project and first flow              | [Getting started](./docs/content/docs/getting-started/index.mdx) |
| Hub, projects, tasks, and flows           | [Core concepts](./docs/content/docs/concepts/index.mdx)          |
| Project, task, sync, and recovery recipes | [Guides](./docs/content/docs/guides/index.mdx)                   |
| Command lookup                            | [CLI reference](./docs/content/docs/cli/index.mdx)               |
| TypeScript integration                    | [API reference](./docs/content/docs/api/index.mdx)               |
| Configuration and diagnostics             | [Reference](./docs/content/docs/reference/index.mdx)             |
| Chinese overview                          | [中文说明](./readme_cn.md)                                       |
| Chinese task-oriented guide               | [用户指南](./user_guide.md)                                      |

Design decisions and project history live under `docs/adr/`, `docs/prd/`, and
`docs/research/`. They are contributor references, not the recommended user
learning path.

## Legacy repo-local setup

`archloop init` scaffolds a `.archloop/` directory containing an orchestration
entry point, prompts, environment examples, and a container definition. This
path remains supported for existing custom workflows, but new users should
start with the Hub workflow above.

```bash
npx archloop init
```

See the [legacy setup guide](./docs/content/docs/guides/legacy-repo-local-setup.mdx)
before creating or changing a repo-local scaffold.

## Agent skill

The repository includes a portable agent skill at
[`skills/archloop-usage/SKILL.md`](./skills/archloop-usage/SKILL.md). Copy its
directory into the skills directory used by your coding agent. It is not
installed automatically.

## Development

```bash
npm install
npm run typecheck
npm test
npm run docs:check
```

See the [contributor documentation](./docs/content/docs/contributing/index.mdx)
for documentation maintenance and validation rules.

## License

MIT
