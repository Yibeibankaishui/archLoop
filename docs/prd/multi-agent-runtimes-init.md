# PRD: Multi-Agent Runtimes During Init

## Problem Statement

archLoop's current `init` flow asks the user to select a single **agent**. That choice currently does more than select a default provider for the generated workflow: it also determines which agent CLI is installed in the sandbox image, which auth-related environment variables are suggested in `.env.example`, and which provider call is scaffolded into `main.mts`.

From the user's perspective, this creates the impression that a project is bound to one agent, even though the real need is often a multi-agent workflow inside one **sandbox**. Users want to compose planners, implementers, reviewers, and mergers across different agent providers and different LLM models, such as Codex for planning and review, Cursor for implementation, and Claude Code for another role. Today, that requires hand-editing Dockerfiles, auth mounts, `.env` files, and generated orchestration, which adds unnecessary friction and makes archLoop feel more single-agent than it actually is.

## Solution

Change `init` so it distinguishes between:

- A **default agent** used only for the initial scaffolded example and developer guidance.
- A set of **installed agent runtimes** that determines which agent CLIs, auth/config mounts, and environment variable hints are prepared for the project.

In this model, `init` no longer implies "this project uses one agent". Instead, it scaffolds a **config directory** that can support multiple agent providers inside the same sandbox image, while still giving the user a sensible default in `main.mts`.

The user experience should become:

1. Select a default agent for the initial example.
2. Select one or more agent runtimes to install in the sandbox.
3. Generate a sandbox image, auth/config guidance, and scaffold output that can support multi-agent orchestration.

This preserves archLoop's current strengths:

- Templates remain workflow-oriented.
- `main.mts` remains the orchestration surface.
- Agent providers remain runtime inputs to `run()`.

But it removes the misleading coupling between "the default scaffold example" and "the only agent runtime the sandbox can actually execute".

## User Stories

1. As a archLoop user, I want `init` to distinguish between the default agent and installed runtimes, so that choosing one scaffold example does not restrict the whole project.
2. As a archLoop user, I want to install multiple agent runtimes in the same sandbox, so that one project can use Codex, Cursor, Claude Code, and others together.
3. As a archLoop user, I want to select Cursor as the default implementer while also installing Codex for planning and review, so that the scaffold matches my intended workflow.
4. As a archLoop user, I want to install only the runtimes I plan to use, so that the sandbox image stays smaller and easier to understand.
5. As a archLoop user, I want the generated Dockerfile or Containerfile to install every selected runtime, so that the sandbox can execute every referenced agent provider.
6. As a archLoop user, I want `.env.example` to include the relevant auth hints for all installed runtimes, so that setup is complete on first run.
7. As a archLoop user, I want auth/config mounts to be generated for all selected runtimes, so that the container can authenticate each provider consistently.
8. As a archLoop user, I want `main.mts` to still show one simple default path, so that the scaffold remains approachable even when multi-agent support is enabled.
9. As a archLoop user, I want to hand-edit `main.mts` to orchestrate multiple providers after init, so that I can express planner/implementer/reviewer/merger workflows freely.
10. As a archLoop user, I want the init UI to make it obvious that selecting a default agent does not disable other runtimes, so that the mental model is clear.
11. As a archLoop user, I want non-interactive init flags to support multiple runtimes, so that CI, scripts, and reproducible project bootstrap flows work.
12. As a archLoop user, I want preset agent roles to remain compatible with multi-runtime projects, so that a role can recommend a provider without forcing sandbox changes by hand.
13. As a archLoop user, I want the generated scaffold to support role-level provider mixing, so that a reviewer role can use one provider while an implementer role uses another.
14. As a archLoop user, I want projects to remain valid when only one runtime is selected, so that the new model stays backward compatible with simpler setups.
15. As a archLoop user, I want sandbox provider behavior to stay predictable across Docker and Podman, so that multi-runtime support does not depend on one provider only.
16. As a archLoop user, I want the README and init next steps to explain the difference between default agent and installed runtimes, so that I know how to customize the scaffold.
17. As a archLoop user, I want runtime selection to affect only sandbox/image/auth setup, so that changing my orchestration later does not require a redesign of init concepts.
18. As a archLoop user, I want one project to support multiple LLM models across providers, so that role-specific model choice is natural.
19. As a archLoop user, I want init to fail early if I request an unknown runtime, so that scripting mistakes are caught immediately.
20. As a archLoop user, I want generated files to reflect only the runtimes I selected, so that the config directory stays legible.
21. As a maintainer, I want runtime installation concerns separated from scaffold default-agent concerns, so that future agent providers can be added without entangling unrelated logic.
22. As a maintainer, I want the runtime installation logic to be expressed as a registry, so that each provider's install snippet, env hints, and auth mount metadata are defined once.
23. As a maintainer, I want the default-agent scaffold logic to remain small and template-focused, so that templates do not become coupled to runtime installation rules.
24. As a maintainer, I want multi-runtime Dockerfile generation to be additive, so that enabling a second runtime does not require a forked template architecture.
25. As a maintainer, I want runtime-related tests to verify external scaffold output rather than internal string assembly details, so that implementation can evolve safely.
26. As a maintainer, I want the data model to support preset roles recommending different providers than the scaffold default, so that the role system and runtime system fit together.
27. As a maintainer, I want build-image and auth guidance to remain correct when multiple runtimes are present, so that users can run successfully after one init.
28. As a maintainer, I want existing single-agent projects to continue working without migration, so that the feature is introduced safely.
29. As a maintainer, I want runtime metadata to remain filesystem-safe and package-distributable, so that published tarballs contain everything needed at runtime.
30. As a maintainer, I want future role orchestration helpers to build on this model, so that "default agent" does not become another long-term conceptual dead end.

## Implementation Decisions

- Split the current single init agent concept into two concerns: a default scaffold agent and installed agent runtimes.
- Keep the default scaffold agent responsible only for initial `main.mts`/prompt example generation and developer-facing defaults.
- Introduce an installed runtime registry that defines, for each runtime, its install snippet, environment variable hints, auth/config mounts, and any runtime-specific setup metadata.
- Preserve the existing agent-provider registry for runtime orchestration defaults, but narrow its responsibilities so it no longer owns sandbox image installation behavior by itself.
- Extend init prompts to collect both a default agent and a multi-select list of installed runtimes.
- Extend non-interactive init flags so scripts can specify installed runtimes explicitly.
- Generate sandbox image templates by combining install snippets for every selected runtime instead of selecting one monolithic agent Dockerfile template.
- Generate environment-variable guidance by combining the relevant auth hints for each selected runtime.
- Generate auth/config mounts by combining the relevant mount definitions for each selected runtime.
- Keep `main.mts` simple: scaffold one default provider call while leaving room for users to add more agent providers manually.
- Ensure preset agent roles can reference recommended providers without assuming those runtimes are the only ones installed.
- Keep template directories self-contained; multi-runtime logic should live in scaffold-time assembly rather than cross-template imports.
- Favor additive configuration over runtime autodetection. The generated project should explicitly show which runtimes are installed.
- Preserve backward compatibility by treating a single selected runtime as a valid, simple case.
- Update documentation and next steps to teach the new model clearly: default agent chooses the example, installed runtimes choose what the sandbox can execute.

## Testing Decisions

- Good tests should assert observable scaffold behavior: generated Dockerfiles, `.env.example`, mounts, and `main.mts` output should reflect the selected default agent and installed runtimes. Tests should avoid overfitting to internal helper structure.
- Test the init scaffold for a single runtime to verify backward-compatible behavior.
- Test the init scaffold for multiple runtimes to verify combined install snippets, combined environment-variable hints, and combined auth/config mounts.
- Test that the default scaffold agent can differ from the installed runtime list while still producing coherent output.
- Test non-interactive CLI parsing for multiple runtimes, including invalid runtime ids.
- Test that generated next steps and documentation hints reflect the distinction between default agent and installed runtimes.
- Test integration with preset roles so role recommendations and installed runtimes can coexist without conflicting scaffold output.
- Use the existing `InitService` scaffold tests as prior art for validating generated Dockerfiles, `.env` files, prompt templates, and `main.mts` rewrites.
- Use the existing CLI tests as prior art for validating non-interactive init flags and init error handling.
- Run typecheck, focused init tests, and focused CLI tests as the primary verification path for the feature.

## Out of Scope

- Automatically rewriting every template into a fully multi-agent orchestration example.
- Building a runtime marketplace or remote runtime registry.
- Provider-native auth flows beyond the current config-directory and mount-based setup model.
- Automatic inference of which runtimes are needed from selected preset roles.
- Automatic migration of existing single-agent projects.
- Replacing `main.mts` with a higher-level workflow DSL in this feature.
- Solving agent-to-agent scheduling semantics beyond enabling multiple providers inside one project scaffold.
- Supporting arbitrary external CLIs that are not archLoop agent providers.

## Further Notes

This feature should be framed as a clarification of archLoop's architecture, not just a convenience tweak. archLoop already supports different **agent providers** at runtime; the problem is that `init` currently communicates and scaffolds the project as if one selected agent defines the whole project.

The clean product model is:

- Template = workflow shape.
- Default agent = initial example provider in the scaffold.
- Installed runtimes = what the sandbox can execute.
- Preset roles = reusable responsibilities that may recommend particular providers.
- `main.mts` = the place where multi-agent orchestration is expressed.

This design also sets up a better foundation for future role-aware orchestration helpers, because the sandbox becomes explicitly multi-runtime-capable before higher-level orchestration abstractions are introduced.
