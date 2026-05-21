# PRD: Project profiles for init-time bootstrap generation

## Problem Statement

Sandcastle initialization currently leaves repository setup too implicit. Non-blank templates can generate a bootstrap script at run time if one is missing, which makes the first real run less predictable and pushes an important repo environment contract out of `sandcastle init`. Users need initialization to clearly ask what kind of project they are working in and then generate a deterministic sandbox environment and bootstrap script for that project type.

## Solution

Add a **Project profile** choice to `sandcastle init`. The first supported profiles are `generic`, `node`, `python`, and `cpp`, with `generic` as the default. The selected Project profile drives generation of the Dockerfile or Containerfile and the generated bootstrap script. Templates run the generated bootstrap script through a sandbox hook, but they no longer ask an agent to generate or repair bootstrap at run time.

## User Stories

1. As a Sandcastle user, I want `sandcastle init` to ask for my Project profile, so that the generated sandbox environment matches my repository.
2. As a Sandcastle user, I want `generic` to be the default Project profile, so that Sandcastle does not guess my language stack.
3. As a Sandcastle user, I want a generic project to receive a no-op bootstrap script, so that the scaffolded workflow has a stable hook target.
4. As a Sandcastle user, I want a Node project profile, so that Node dependency setup is scaffolded without hand-writing the first bootstrap script.
5. As a Sandcastle user, I want Node bootstrap to choose commands from lockfiles at run time, so that npm, pnpm, and yarn projects can use one generated script.
6. As a Sandcastle user, I want Node bootstrap to skip dependency install when no package manifest exists, so that the script does not fail in non-package subtrees.
7. As a Sandcastle user, I want a Python project profile, so that Python, pip, venv, and uv are available in the sandbox image.
8. As a Python user, I want Poetry not to be installed by default, so that the generated image stays lean and predictable.
9. As a Python user, I want Poetry projects to receive a clear bootstrap message, so that I know when to customize the Dockerfile or bootstrap script.
10. As a Sandcastle user, I want a C++ project profile, so that common C++ toolchain dependencies are available in the sandbox image.
11. As a C++ user, I want CMake projects to be configured but not fully built by default, so that bootstrap prepares the repo without turning every sandbox start into a full build.
12. As a C++ user, I want Makefile projects to be recognized without automatically running `make`, so that bootstrap does not perform expensive or destructive work by default.
13. As a Sandcastle user, I want Project profile and workflow template to be independent choices, so that I can combine any workflow with any supported project type.
14. As a Sandcastle user, I want Project profile and agent runtime to be independent choices, so that my repo language does not constrain which coding agent runs.
15. As a Sandcastle user, I want Project profile and backlog manager to be independent choices, so that GitHub Issues or Beads can work across project types.
16. As a Sandcastle user, I want generated bootstrap scripts to be user-editable, so that I can adapt them to my repository after init.
17. As a Sandcastle user, I want init not to execute bootstrap immediately, so that initialization does not unexpectedly install dependencies or build my project.
18. As a Sandcastle user, I want bootstrap to run only after the worktree is mounted in the sandbox, so that it operates on the actual repository checkout.
19. As a Sandcastle user, I want bootstrap not to participate in image build, so that the image remains a reusable environment layer and repo setup remains a runtime hook.
20. As a Sandcastle user, I want bootstrap to prepare setup rather than run full verification by default, so that sandbox startup stays reasonably fast.
21. As a Sandcastle user, I want templates to stop generating bootstrap scripts at run time, so that first-run behavior is deterministic.
22. As a Sandcastle maintainer, I want Project profiles to be implemented as a small registry, so that adding future profiles is localized and testable.
23. As a Sandcastle maintainer, I want bootstrap generation to be a deep module, so that generated scripts can be tested independently of interactive CLI flows.
24. As a Sandcastle maintainer, I want containerfile additions to be composed with existing agent runtime and backlog manager layers, so that choices remain orthogonal.
25. As a Sandcastle maintainer, I want Project profile to remain an init-time concept, so that runtime sandbox provider APIs do not grow misleading language-stack options.
26. As a scripted-init user, I want a `--project-profile` flag, so that CI and examples can initialize Sandcastle deterministically.
27. As an interactive-init user, I want the Project profile question to appear after workflow template selection, so that I first pick how agents work and then what kind of repo they work in.
28. As a Sandcastle user, I want Project profile not to add project-specific env vars by default, so that `.env.example` remains focused on agent and backlog credentials.
29. As a Sandcastle user, I want Project profile not to add cache mounts by default, so that generated mounts stay explainable and cross-platform.
30. As a Sandcastle user, I want Project profile not to alter copy-to-worktree behavior, so that dependency directories and build outputs are not copied implicitly.

## Implementation Decisions

- Build or modify a Project profile registry with entries for `generic`, `node`, `python`, and `cpp`.
- Build a bootstrap rendering module with a simple interface that accepts a Project profile and returns a deterministic bootstrap script.
- Extend containerfile composition so Project profiles can contribute language and build-tool requirements alongside agent runtime and backlog manager contributions.
- Extend scripted init with `--project-profile`.
- Extend interactive init so Project profile is selected after workflow template selection.
- Keep `generic` as the default and do not implement automatic project detection in the first version.
- Do not implement AI-generated bootstrap in the first version.
- Generate bootstrap during init and treat it as a user-editable scaffold artifact.
- Keep Project profile out of public runtime APIs.
- Remove runtime bootstrap generation from scaffolded workflow templates.
- Stop scaffolding bootstrap-generation prompts.
- Keep bootstrap execution as a sandbox hook in non-blank workflow templates.
- Do not execute or validate bootstrap during init.
- Do not include bootstrap in image build.
- Do not let Project profiles modify `.env.example`, mounts, or copy-to-worktree defaults in the first version.

## Testing Decisions

- Good tests should assert observable scaffold behavior rather than internal helper structure.
- Test the Project profile registry through valid and invalid profile selection.
- Test bootstrap rendering for `generic`, `node`, `python`, and `cpp`.
- Test Dockerfile and Containerfile output for each Project profile while preserving existing agent runtime and backlog manager composition.
- Test scripted init with `--project-profile`.
- Test interactive init prompt flow to ensure Project profile is collected after template selection.
- Test that non-blank templates include only the bootstrap hook and no runtime bootstrap-generation flow.
- Test that bootstrap-generation prompts are no longer scaffolded.
- Use existing scaffold tests as prior art for generated Dockerfile, Containerfile, prompt, environment, and main file assertions.
- Use existing CLI tests as prior art for init flags, invalid option errors, and help output.
- Use typechecking as the broad integration check.

## Out of Scope

- Automatic project detection.
- AI-generated bootstrap.
- Project profile options in public runtime APIs.
- Init-time execution or validation of bootstrap.
- Full test/build verification in generated bootstrap scripts.
- Project-specific `.env.example` additions such as package registry tokens.
- Automatic cache mounts for npm, uv, pip, ccache, or similar tools.
- Automatic copy-to-worktree behavior for dependency directories, virtual environments, or build outputs.
- Docker Compose or existing-container orchestration.
- Migration of existing `.sandcastle` directories.

## Further Notes

This PRD follows ADR-0015: Project profiles generate bootstrap at init time. The design intentionally favors predictable, editable scaffolding over automatic inference or AI-generated setup. Future work may add automatic detection or AI assistance after the deterministic profile path is proven.
