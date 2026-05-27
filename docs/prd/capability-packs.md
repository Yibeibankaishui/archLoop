# PRD: Capability Packs For Specialized Agent Environments

## Problem Statement

Sandcastle users can choose templates, project profiles, preset agents, sandbox providers, and installed agent runtimes during init, but those choices are still low-level. A user who wants Sandcastle to specialize in a class of development work, such as WeChat Mini Program development, must know which template, project profile, preset agents, skills, prompts, verification commands, and optional host tools belong together.

The existing preset agent and bundled skill mechanism is useful but not strong enough for professional specialization. A preset prompt can tell the agent to read a skill file, but Sandcastle does not yet provide a higher-level scaffold that reliably assembles role guidance, domain skills, capability context, verification rules, and add-on guidance into a coherent prompt template and development loop.

The first motivating case is WeChat Mini Program development. The useful loop is not just "write code"; it is code, run a CLI validation command, read structured debug logs, fix failures, and optionally use host-dependent runtime debugging or cloud tooling when the sandbox mode supports it.

## Solution

Add capability packs to `sandcastle init`. A capability pack is an explicit init-time choice that specializes the generated config directory for a class of development work. It composes existing init concepts into a professional agent environment:

- A default template.
- A default project profile.
- Preset agents and bundled skills.
- Capability-specific context files.
- A verification entrypoint.
- A capability manifest.
- Optional capability add-ons.

The first version ships two capability packs:

- `generic`, the default pack that preserves the current low-assumption init path.
- `miniprogram`, the first specialized pack for WeChat Mini Program development.

The `miniprogram` core pack scaffolds a CLI-first feedback loop centered on `.sandcastle/verify.sh`, `npm run wx:check`, `miniprogram-ci`, and `debug/wx-check.log`. It supports sandboxed and no-sandbox init paths.

The first version also models WeChat DevTools MCP and CloudBase MCP as no-sandbox-only capability add-ons. These add-ons scaffold context and prompt guidance, but init does not install external tools, start authentication, bind cloud environments, or require MCP availability for the core loop.

Capability packs provide defaults for other init choices, but explicit init flags override those defaults. For example, the Mini Program pack may default to a Mini Program loop template, Node project profile, and Mini Program preset agent, while still allowing a user to pass explicit `--template`, `--project-profile`, or `--preset-agents` flags.

The first version uses init-time prompt assembly. Init writes prompt templates that include the selected preset agent role, required skills, capability context, verification guidance, and selected add-on guidance. Sandcastle does not add a public runtime `run({ agentProfile })` API in the first version.

## User Stories

1. As a Sandcastle user, I want to select a capability pack during init, so that Sandcastle can scaffold an environment for the type of development work I want to automate.
2. As a Sandcastle user, I want `generic` to remain available, so that I can keep using Sandcastle without domain-specific assumptions.
3. As a Sandcastle user, I want to select `miniprogram`, so that my generated config directory is tailored to WeChat Mini Program development.
4. As a Sandcastle user, I want capability pack selection to be explicit, so that Sandcastle does not silently infer a specialized workflow from ambiguous repository files.
5. As a Sandcastle user, I want capability packs to provide sensible defaults for template, project profile, and preset agents, so that I do not need to manually assemble common combinations.
6. As a Sandcastle user, I want explicit init flags to override capability pack defaults, so that I can customize a pack without losing its context and verification scaffold.
7. As a Sandcastle user, I want init to write a capability manifest, so that the selected pack and add-ons are visible after init.
8. As a Sandcastle user, I want capability-owned files to live in the config directory, so that I can inspect and edit them without Sandcastle rewriting my application files.
9. As a Sandcastle user, I want the first version not to modify `package.json`, so that Sandcastle does not accidentally damage a project with custom package manager, framework, or monorepo conventions.
10. As a Sandcastle user, I want a verification entrypoint, so that agents have one stable command to run after changing code.
11. As a Mini Program developer, I want `.sandcastle/verify.sh` to call `npm run wx:check` when available, so that the agent follows the project's Mini Program validation loop.
12. As a Mini Program developer, I want failed verification to point the agent at `debug/wx-check.log`, so that the agent fixes based on concrete logs instead of guessing.
13. As a Mini Program developer, I want the generated skill to mention `project.config.json`, `app.json`, page JSON, component JSON, and routing rules, so that agents inspect the right files before changing Mini Program code.
14. As a Mini Program developer, I want the generated skill to warn against committing private upload keys such as `private.*.key`, so that agent work does not leak credentials.
15. As a Mini Program developer, I want the generated context to explain the expected `wx:check` loop, so that I can adapt my project scripts intentionally.
16. As a Mini Program developer, I want the generated context to include a WeChat DevTools error report template, so that runtime debugging feedback is structured for agents.
17. As a Mini Program developer using Docker, I want the core Mini Program loop to remain available, so that I can use CLI validation without host GUI tooling.
18. As a Mini Program developer using no-sandbox, I want to enable a runtime debugging add-on, so that agent prompts include WeChat DevTools MCP guidance when host tooling is available.
19. As a Mini Program developer using no-sandbox, I want to enable a CloudBase add-on, so that agent prompts include cloud function, database, deployment, and cloud log guidance when host authentication is available.
20. As a Mini Program developer, I want MCP add-ons not to be required for the core Mini Program pack, so that missing GUI tools or cloud auth do not block init.
21. As a Mini Program developer, I want MCP add-ons to be rejected for Docker in the first version, so that Sandcastle does not imply host-dependent tools are available inside a sandbox.
22. As a Mini Program developer, I want the runtime-debug add-on to be framed as a supplement after CLI validation passes, so that agents do not replace `miniprogram-ci` with GUI automation.
23. As a Mini Program developer, I want the CloudBase add-on to be framed around cloud resources, so that agents use it for `wx.cloud`, `cloudfunctions`, database, storage, deployment, and logs.
24. As a Sandcastle user, I want the generated Mini Program prompt template to include the relevant skill and context, so that skill loading does not rely only on the agent deciding to open another file.
25. As a Sandcastle user, I want selected add-on guidance to be assembled into the prompt template, so that the agent sees only the add-ons I enabled.
26. As a Sandcastle user, I want generated prompts to remain ordinary Markdown files, so that I can edit the assembled guidance after init.
27. As a Sandcastle user, I want capability packs to work with existing agent providers, so that the first version does not depend on provider-native skill support.
28. As a Sandcastle user, I want the generated workflow to keep using the current `run()` API, so that capability packs do not require a new runtime API.
29. As a Sandcastle user, I want a future web capability pack to be possible, so that the abstraction is not Mini Program-specific.
30. As a Sandcastle user, I want a future game capability pack to be possible, so that the abstraction can support other specialized development loops.
31. As a maintainer, I want capability pack definitions in a registry, so that supported packs and add-ons are explicit and testable.
32. As a maintainer, I want capability pack ids and add-on ids to be stable and filesystem-safe, so that generated files and manifests are predictable.
33. As a maintainer, I want invalid capability pack definitions to fail tests, so that broken defaults or missing files do not ship.
34. As a maintainer, I want capability default resolution to happen before explicit init flags are applied, so that user overrides remain clear.
35. As a maintainer, I want capability add-on compatibility rules to be validated during init, so that unsupported sandbox/add-on combinations fail early.
36. As a maintainer, I want capability packs to reuse existing project profile and preset agent concepts, so that Sandcastle does not duplicate registries unnecessarily.
37. As a maintainer, I want prompt assembly to be testable without running a real agent, so that generated prompts reliably include required skill and context sections.
38. As a maintainer, I want template directories to remain self-contained, so that capability packs do not violate the template architecture decision.
39. As a maintainer, I want capability manifests to be scaffold metadata rather than required runtime config, so that generated workflows keep running even if future tooling changes.
40. As a maintainer, I want roadmap and documentation to distinguish project profiles, templates, preset agents, skills, capability packs, and capability add-ons, so that users have a clear mental model.

## Implementation Decisions

- Add a capability pack registry with at least `generic` and `miniprogram` definitions.
- Add capability add-on definitions for Mini Program runtime debugging and CloudBase workflows.
- Treat capability pack selection as an explicit init choice and as an optional scripted init flag.
- Do not automatically infer a capability pack from repository files in the first version.
- Resolve capability pack defaults before applying explicit template, project profile, and preset-agent init selections.
- Let explicit init flags override capability pack defaults.
- Keep capability packs as init-time scaffolding choices rather than runtime options on `run()`, `interactive()`, `createSandbox()`, or sandbox providers.
- Use init-time prompt assembly for the first version.
- Generate assembled prompt templates that include preset role guidance, required skills, capability context, verification guidance, and selected add-on guidance.
- Do not add a public `run({ agentProfile })` API in the first version.
- Write a capability manifest in the config directory when a capability pack is selected.
- Keep the capability manifest as scaffold metadata, not required runtime configuration.
- Add a verification entrypoint scaffold for capability packs that define a development validation loop.
- Use `.sandcastle/verify.sh` as the first-version verification entrypoint path.
- Keep bootstrap and verification separate: bootstrap prepares the repo before agent work, while verification checks the result after agent changes.
- Keep capability-owned generated files inside the config directory by default.
- Do not modify host repo application files such as `package.json` in the first version.
- Do not automatically install `miniprogram-ci`, add `wx:check`, or add Mini Program automation scripts to the host repo in the first version.
- Generate Mini Program context that explains how users can wire `npm run wx:check`, `miniprogram-ci`, and debug logs into their project.
- Expand the Mini Program preset skill with CLI validation, routing, page/component JSON, private key, runtime debugging, and CloudBase guidance.
- Strengthen the Mini Program preset prompt so it follows the verification entrypoint and reports verification outcomes.
- Add or update a Mini Program loop template that uses the assembled Mini Program prompt template and the verification entrypoint.
- Allow the Mini Program core pack with sandboxed and no-sandbox init paths.
- Allow Mini Program runtime-debug and CloudBase add-ons only with the no-sandbox provider in the first version.
- Reject unsupported add-on and sandbox provider combinations during init.
- Generate add-on context files only when the add-ons are selected.
- Do not automatically install `wechat-devtools-mcp`, start WeChat Developer Tools, log into CloudBase, bind CloudBase environments, or assume MCP servers are available.
- Update init summary and next steps to explain selected capability pack, add-ons, verification entrypoint, and follow-up setup.
- Update user documentation to explain the distinction between project profiles, templates, preset agents, skills, capability packs, and capability add-ons.
- Update the roadmap to track capability packs as their own phase.
- Record the architectural decision in an ADR, including explicit selection, init-time prompt assembly, no-sandbox-only MCP add-ons, and no application-file modification in the first version.

## Testing Decisions

- Tests should focus on scaffolded external behavior: given init options, Sandcastle writes the expected config directory files, manifest, prompts, context, and verification entrypoint.
- Add registry validation tests for capability pack ids, add-on ids, default references, required files, and compatibility declarations.
- Add tests that `generic` preserves the existing init behavior when no specialized capability is selected.
- Add tests that `miniprogram` applies default template, project profile, and preset agent selections when no explicit override is provided.
- Add tests that explicit template, project profile, and preset-agent selections override Mini Program defaults.
- Add tests that `.sandcastle/capability.json` is written with the selected capability, add-ons, verification entrypoint, and log paths.
- Add tests that `.sandcastle/verify.sh` is written for the Mini Program pack and is executable when the platform supports mode assertions.
- Add tests that the Mini Program assembled prompt includes required skill content or required skill sections.
- Add tests that selected add-on guidance appears in assembled prompts and unselected add-on guidance does not.
- Add tests that runtime-debug and CloudBase add-ons are accepted with no-sandbox.
- Add tests that runtime-debug and CloudBase add-ons are rejected with Docker init in the first version.
- Add tests that Mini Program core pack does not require add-ons.
- Add tests that init does not modify host repo application files such as `package.json`.
- Add tests that Mini Program context files and DevTools error template are copied into the config directory.
- Reuse existing `InitService` scaffold test patterns for filesystem output, manifest contents, and generated prompt files.
- Reuse existing preset agent registry validation tests as prior art for capability pack registry validation.
- Run `npm run typecheck` as the required type verification.
- Run focused init, preset registry, and capability registry tests as the primary implementation verification path.
- Run broader test suites before merge when feasible, while accounting for existing provider-specific environment constraints.

## Out of Scope

- Implementing web or game capability packs beyond reserving the abstraction for them.
- Automatically detecting repository type and silently selecting a capability pack.
- Adding a public runtime `agentProfile` API to `run()`, `interactive()`, `createSandbox()`, or worktree APIs.
- Modifying host repo application files such as `package.json`, `app.json`, `project.config.json`, or Mini Program scripts during init.
- Installing `miniprogram-ci` or authoring project-specific Mini Program automation scripts in the first version.
- Installing or configuring `wechat-devtools-mcp`.
- Launching WeChat Developer Tools or managing its service port.
- Authenticating to CloudBase or binding a CloudBase environment.
- Making MCP add-ons work inside Docker, Podman, or isolated sandbox providers in the first version.
- Building a remote marketplace or third-party capability pack install flow.
- Implementing capability pack upgrade or migration commands.
- Adding GUI support for capability packs.

## Further Notes

The Mini Program core loop follows the research in `docs/research/wx-miniprogram-loop.md`: first make the CLI validation loop reliable, then use runtime debugging and cloud tooling as optional enhancements.

The design follows ADR-0016. Capability packs are a new composition layer rather than a replacement for project profiles, templates, preset agents, or skills.

The first implementation should prefer boring, inspectable scaffold files over hidden runtime behavior. That keeps Sandcastle explainable while giving future web and game capability packs a clear path.
