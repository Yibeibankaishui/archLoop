# Capability packs compose specialized init scaffolds

`sandcastle init` will support explicit capability pack selection for specialized development work. A capability pack composes existing init concepts -- template, project profile, preset agents, skills, context files, verification entrypoints, and optional capability add-ons -- into a coherent scaffold for a class of development tasks. The first non-generic capability pack is WeChat Mini Program development.

## Decision

Capability packs are init-time scaffolding choices. Sandcastle will not silently infer a capability pack from repository files in the first version. A selected capability pack provides defaults for other init choices, such as template, project profile, and preset agents, but explicit init flags override those defaults.

The first version uses init-time prompt assembly: init writes prompt templates that include the relevant preset agent role, skills, capability context, verification guidance, and selected add-on guidance. Sandcastle will not add a public `run({ agentProfile })` runtime API in this version.

Init writes a capability manifest in the config directory to record the selected capability pack, selected add-ons, and verification entrypoint. The manifest is scaffold metadata; generated workflows do not need to read it to run in the first version.

Capability packs own scaffold artifacts in the config directory by default. They do not modify host repo application files such as `package.json` in the first version.

## WeChat Mini Program pack

The WeChat Mini Program core pack centers on a CLI validation loop:

```text
agent changes code
-> .sandcastle/verify.sh
-> npm run wx:check
-> miniprogram-ci
-> debug/wx-check.log
-> agent reads the log and fixes failures
```

The core pack supports sandboxed and no-sandbox init paths. It scaffolds a verification entrypoint, context, skills, and prompt templates, but it does not automatically add `wx:check` scripts or `miniprogram-ci` dependencies to the host repo's `package.json`.

WeChat DevTools MCP and CloudBase MCP are modeled as capability add-ons in the first version. These add-ons are only accepted with the no-sandbox provider because they depend on host state such as local GUI tools, MCP configuration, login state, cloud environment binding, and credentials. Enabling an add-on scaffolds context and prompt guidance; init does not install external tools, start authentication, or bind cloud environments.

## Considered options

1. **Extend project profiles instead** -- rejected. A project profile describes language and build-tool shape, while a capability pack specializes a development loop and composes prompts, skills, context, verification, and add-ons.
2. **Use templates alone** -- rejected. A template defines workflow shape, but specialized development also needs tool context, agent roles, verification contracts, and optional add-ons.
3. **Use preset agents alone** -- rejected. A preset agent describes an agent role, but it cannot by itself prepare the environment or define a repository verification loop.
4. **Automatically infer capability packs** -- rejected for the first version. Specialized scaffolds have wider effects than project profiles, and repository signals such as `project.config.json` or `app.json` are ambiguous across native mini programs, Taro, uni-app, monorepos, and partial repos.
5. **Add runtime `agentProfile` support immediately** -- rejected for the first version. It would expand `run()`, `interactive()`, `createSandbox()`, and worktree APIs before the scaffolded shape is proven. Init-time prompt assembly solves the first reliability problem without growing the runtime API.
6. **Automatically install MCP tools or complete cloud authentication** -- rejected. WeChat DevTools MCP and CloudBase MCP depend on host state and user-controlled credentials; init should not make them hard requirements for the core mini program loop.
7. **Automatically modify `package.json`** -- rejected for the first version. Mini program repos vary across package managers, frameworks, and monorepo layouts. The first version keeps capability-owned artifacts inside the config directory.

## Consequences

- Capability packs become a new init registry alongside templates, project profiles, preset agents, and sandbox providers.
- Init ordering must resolve capability defaults before applying explicit template, project profile, and preset-agent selections.
- The WeChat Mini Program pack can ship a useful core loop for Docker and no-sandbox users while preserving no-sandbox-only add-ons for host-dependent MCP workflows.
- Future web and game capability packs can reuse the same abstraction without being implemented in the first version.
- A later runtime agent-profile API remains possible, but it should be justified by repeated scaffold use rather than introduced up front.
