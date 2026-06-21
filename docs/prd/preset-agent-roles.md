# PRD: Preset Agent Roles With Bundled Skills

## Problem Statement

archLoop users can select an init template, but templates only scaffold a workflow and its default prompt templates. Users who want richer role-based workflows, such as a Mini Program developer agent, reviewer, planner, merger, docs writer, or test engineer, must hand-author prompt templates, decide which skills or guidance each agent needs, and wire those files into `main.mts` themselves.

This creates friction for users who know the agent roles they want but do not yet know archLoop's prompt, sandbox, and config directory conventions. A lower-level "migrate local skills into Docker" feature would expose too much implementation detail: host skill paths, Docker mounts, copied directories, and provider-specific skill support. The user-facing need is better expressed as reusable agent roles that come with the relevant skills and prompt guidance already bundled.

## Solution

Add preset agent roles to `archloop init`. After selecting an init template, users can optionally add one or more preset agents to the project's config directory. A preset agent is a reusable role definition made of:

- A role prompt template.
- Metadata describing the recommended agent provider, model, and optional effort setting.
- A list of bundled skills required by that role.
- Optional usage notes that show how to call the role from `main.mts`.

Init copies the selected role prompt templates into `.archloop/agents/`, copies their bundled skills into `.archloop/skills/`, and writes a role manifest such as `.archloop/agent-profiles.json`. Users can then customize `main.mts` to compose the template's default workflow with any additional preset agent roles.

In product terms:

- Template = workflow.
- Preset agent = reusable role.
- Skill = role dependency.
- `main.mts` = orchestration.

The first version should make the files visible and editable instead of hiding behavior behind a large new API. Future versions can add helpers like `profile()` or `runAgent()` once the file format and user workflow settle.

## User Stories

1. As a archLoop user, I want `init` to ask whether I want to add preset agent roles, so that I can start with more than the template's default prompt.
2. As a archLoop user, I want to skip preset agent roles, so that the current init flow remains simple.
3. As a archLoop user, I want to select multiple preset agent roles during init, so that I can compose a project-specific agent team.
4. As a archLoop user, I want to add a Mini Program developer preset agent, so that WeChat Mini Program projects get relevant prompt guidance immediately.
5. As a archLoop user, I want to add a reviewer preset agent, so that review behavior is reusable across templates.
6. As a archLoop user, I want to add a planner preset agent, so that planning behavior can be reused outside the default planner templates.
7. As a archLoop user, I want to add a merger preset agent, so that merge and conflict handling can be expressed as a role.
8. As a archLoop user, I want each preset agent role to come with bundled skills, so that I do not need to manually discover or copy supporting skill documents.
9. As a archLoop user, I want preset agent files to live under `.archloop/agents/`, so that I can inspect and edit role prompts directly.
10. As a archLoop user, I want bundled skill files to live under `.archloop/skills/`, so that the role's dependencies are visible and project-scoped.
11. As a archLoop user, I want a manifest that records selected preset agent roles, so that `main.mts` and future tooling can discover them consistently.
12. As a archLoop user, I want role prompts to reference their bundled skills using project-relative paths, so that agents can read the skills from the sandbox worktree.
13. As a archLoop user, I want preset agent roles to work with Docker and Podman sandbox providers, so that the feature fits the existing sandbox provider model.
14. As a archLoop user, I want preset agent roles to work without depending on a specific agent provider's native skill system, so that Codex, Cursor, Claude Code, and other agents can all benefit.
15. As a archLoop user, I want provider and model recommendations for each preset agent role, so that I can quickly choose sensible defaults.
16. As a archLoop user, I want to override the recommended provider and model in `main.mts`, so that preset roles do not lock me into one agent.
17. As a archLoop user, I want the template's existing prompt templates to remain unchanged unless I select additional roles, so that init remains backward compatible.
18. As a archLoop user, I want generated files to be ordinary Markdown and JSON, so that I can edit them without learning a new configuration language.
19. As a archLoop user, I want selected roles to be copied into the config directory, so that the project remains understandable when shared with teammates.
20. As a archLoop user, I want private host skills to remain out of scope for the first version, so that init does not accidentally expose personal auth, cache, or home-directory data.
21. As a archLoop user, I want bundled preset skills to be safe to commit by default, so that project teammates can reproduce the same role behavior.
22. As a archLoop user, I want the init summary and next steps to explain how to use selected roles from `main.mts`, so that I know what to edit next.
23. As a archLoop user, I want preset agent roles to be optional per project, so that different projects can have different role sets.
24. As a archLoop user, I want role prompts to include concrete responsibilities, constraints, and completion expectations, so that the agent role is more than a name.
25. As a archLoop user, I want bundled skills to be de-duplicated when multiple roles need the same skill, so that `.archloop/skills/` stays tidy.
26. As a archLoop user, I want init to show short descriptions for preset agents, so that I can choose roles without opening source files.
27. As a archLoop user, I want invalid or missing preset metadata to fail tests before release, so that broken presets do not ship.
28. As a maintainer, I want preset agent definitions to live in a registry, so that adding a new role is explicit and testable.
29. As a maintainer, I want preset skill definitions to live in a registry, so that role dependencies can be validated.
30. As a maintainer, I want template directories to remain self-contained, so that this feature does not violate the template architecture decision.
31. As a maintainer, I want preset role scaffolding to happen during init, so that runtime `run()` behavior stays focused on orchestration.
32. As a maintainer, I want the first version to avoid adding public runtime APIs unless necessary, so that the package surface does not grow prematurely.
33. As a maintainer, I want tests around scaffold output, so that selected roles reliably create the expected files.
34. As a maintainer, I want tests around prompt references to skills, so that agents can find their role dependencies in the sandbox.
35. As a maintainer, I want docs to explain the distinction between templates and preset agents, so that users develop the right mental model.
36. As a maintainer, I want future host skill migration to remain possible, so that private skill import can be added later without reshaping preset roles.

## Implementation Decisions

- Add a preset agent registry that describes each preset role's id, label, description, recommended agent provider, recommended model, optional effort setting, prompt template, and required skills.
- Add a preset skill registry that describes bundled skills by id and source directory.
- Add preset agent prompt templates and bundled skill directories to the package source.
- Extend init with an optional prompt after template selection: whether to add preset agent roles.
- If the user opts in, present a multi-select list of preset agent roles with descriptions.
- Copy selected role prompt templates into the config directory under an `agents` subdirectory.
- Copy required bundled skills into the config directory under a `skills` subdirectory.
- Generate an agent profiles manifest in the config directory mapping role ids to prompt template paths, recommended provider settings, and skill ids.
- Keep the template's existing prompt templates and workflow files as the primary workflow output.
- Make `main.mts` customization the first version's orchestration surface. Users can call `run()` with selected role prompt templates directly.
- Include skill references inside generated role prompts using project-relative paths so the prompt can instruct the agent to read the bundled skills.
- Treat bundled preset skills as project files that may be committed. Do not include host-private skills or auth directories in this feature.
- Preserve the existing template architecture: init copies template directories as self-contained units, and preset role copying is an additional scaffold step rather than a shared import inside templates.
- Do not add a new public `profile()` or `runAgent()` API in the first version unless implementation proves it is necessary.
- Do not rely on native skill support in Codex, Cursor, Claude Code, or other agent providers. The baseline mechanism is prompt-level file references.
- Ensure role and skill ids are stable, lowercase, and filesystem-safe.
- Ensure multiple selected roles that depend on the same bundled skill produce one copied skill directory.
- Update init next steps so users know selected roles are available under the config directory and can be used from `main.mts`.
- Document the product model: templates define workflows, preset agents define reusable roles, skills define role dependencies, and `main.mts` performs orchestration.

## Testing Decisions

- Tests should focus on external behavior: given init options, the expected config directory files are created with expected content and references. Tests should not assert internal registry implementation details unless validating the registry itself.
- Add scaffold tests for selecting no preset agents to verify existing output remains backward compatible.
- Add scaffold tests for selecting one preset agent to verify the role prompt, required skills, and manifest are written.
- Add scaffold tests for selecting multiple preset agents to verify skill de-duplication.
- Add scaffold tests to verify generated role prompts reference their required skills using the expected config-directory paths.
- Add validation tests that every preset agent references existing prompt templates and existing bundled skills.
- Add validation tests that preset ids are filesystem-safe and unique.
- Add manifest tests to verify provider, model, prompt template, and skill metadata are represented in the generated project files.
- Reuse the existing init scaffold test style as prior art, since `InitService` already validates generated Dockerfiles, prompt templates, `.env` files, and template rewrites.
- Run typecheck and focused init tests as the primary verification path for the first implementation.
- Broader test runs should be used before merge, while allowing for known environment-specific Podman and path-normalization failures if they already exist outside this feature.

## Out of Scope

- Migrating private host skills from directories such as a user's home directory.
- Mounting host skill directories directly into the sandbox.
- Copying auth, cache, sessions, or provider config files as part of preset agent setup.
- Adding a public runtime API such as `profile()` or `runAgent()` in the first version.
- Automatically rewriting every template's workflow to invoke selected preset agents.
- Building a marketplace, remote registry, or network install flow for third-party preset agents.
- Supporting provider-native skill formats beyond prompt-level file references.
- Adding UI beyond init prompts and generated files.
- Solving agent authentication or sandbox image setup beyond the existing init and sandbox provider flows.

## Further Notes

This feature should be framed as role composition, not skill migration. The key product improvement is that users can add project-scoped, editable agent roles during init and then compose those roles in `main.mts`.

The Mini Program developer preset is a good initial role because it demonstrates the value of bundled domain skills. Reviewer, planner, and merger presets are also natural candidates because they map directly to existing archLoop template concepts.

Future versions can add private skill import, host skill mounting, `archloop agents add`, `archloop agents list`, and runtime helpers after the preset role file format proves stable.
