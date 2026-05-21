# Project profiles generate bootstrap at init time

`sandcastle init` will use a selected project profile to generate both the containerfile and `.sandcastle/bootstrap.sh`. The first profiles are generic, Node, Python, and C++; generic is the default and Sandcastle does not auto-detect the project type in the first version. This keeps initialization predictable: templates run the generated bootstrap script through a sandbox hook, but they do not ask an agent to generate or repair it at run time.

## Decision

Project profiles are init-time scaffolding choices, not runtime options on `run()`, `createSandbox()`, or sandbox providers. A profile contributes project language and build-tool requirements to the Dockerfile or Containerfile and writes a user-editable bootstrap script owned by the host repo after init.

The bootstrap script is not part of image build. It runs inside the sandbox after the worktree is mounted and before the agent runs, and it prepares the repo for agent work without running full project verification by default.

## Considered options

- **AI-generated bootstrap during init or first run** -- rejected for the first version because the goal is controllable initialization, and AI generation makes agent choice, image availability, commits, failure recovery, and repeatability harder to explain.
- **Automatic project detection** -- rejected for the first version because ambiguous repos and mixed-language projects would require extra conflict handling before the core profiles are proven.
- **Bootstrap generation inside templates** -- rejected because bootstrap is a repo environment contract, while templates define workflow shape.
