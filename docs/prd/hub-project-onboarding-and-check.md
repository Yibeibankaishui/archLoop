# PRD: Hub Project Onboarding And Check

Published issue: [#186](https://github.com/Yibeibankaishui/archLoop/issues/186)

## Problem Statement

archLoop Hub has grown beyond the legacy repo-local `archloop init` workflow, but the current CLI still makes users think in repo-local terms. Hub project state is lazily created from the current working directory, `archloop run <project>` currently treats the target as a path, and task commands still assume the user is operating from the target repo. This makes archLoop harder to use as a unified multi-project control plane and makes the future GUI harder to align with the CLI.

Users need a first-run and daily-use experience where archLoop can be launched from any directory, show registered Hub projects, let users select a project interactively, run Hub flows against the selected project, and verify agent/provider/model/auth readiness before real project work fails.

## Solution

Introduce a first-class Hub project registry, Hub-wide initialization, project onboarding commands, active project context, and a user-visible `archloop check` command.

`archloop initialize` becomes the Hub-wide setup entry point. It configures shared agent roles, provider/model preferences, env values, and provider auth sessions. It is idempotent and can be rerun to repair Hub-wide readiness. It does not register, create, or select a Hub project; after setup it prints the next command: `archloop project add`. By default it runs a quick Hub check after setup and clearly explains how to skip that step with `archloop initialize --skip-check`.

`archloop project add` registers an existing git repo as a Hub project. It asks for the repo path, user-facing Hub project name, detected-but-confirmed project profile, development contract setup, and whether to initialize the local task store. Successful CLI registration sets that project as the CLI selected Hub project.

Hub commands become project-centric rather than cwd-centric. `archloop run`, `archloop tasks ...`, and project commands target an explicit project when provided, otherwise the CLI selected Hub project, otherwise an interactive picker in TTYs. They do not silently infer a project from the current working directory. Existing explicit path usage such as `archloop run . --flow with-review` remains as a compatibility path with migration guidance.

`archloop check` is the main readiness command. By default it checks Hub-wide configuration and the CLI selected Hub project if one exists. It supports `--hub`, `--project <name>`, and `--all-projects`. It renders visible progress while running, performs lightweight provider/model smoke checks through the real provider path, summarizes warnings and errors, and returns a non-zero exit code only for blocking errors.

The future GUI should use the same Hub project registry, stable Hub project ids, project status projection, and Hub flow execution model. GUI project switching is a GUI active Hub project context and must not implicitly mutate the CLI selected Hub project.

## User Stories

1. As a new archLoop user, I want to run `archloop initialize`, so that I can configure shared Hub settings without entering a target repo.
2. As a new archLoop user, I want initialization to configure provider, model, env, and auth settings, so that I do not discover missing setup during my first real flow run.
3. As a new archLoop user, I want initialization to end with the exact next command, so that I do not need to infer how to register my first project.
4. As a CLI user, I want initialization to be idempotent, so that I can rerun it later to repair Hub-wide configuration.
5. As a CLI user, I want initialization to run a quick check by default, so that saved provider/model/auth settings are proven usable.
6. As a CLI user, I want initialization to explain `archloop initialize --skip-check`, so that I can skip the provider smoke call when I intentionally need to.
7. As a CLI user, I want `archloop check` to show visible progress, so that the terminal does not look stuck while provider calls run.
8. As a CLI user, I want `archloop check` to print exact repair commands, so that I can fix problems without searching docs.
9. As a CLI user, I want provider smoke checks to use the real provider path, so that the check validates the same chain used by Hub flow execution.
10. As a CLI user, I want provider/model smoke checks to be deduplicated by provider, model, and options, so that one shared role configuration does not waste API quota.
11. As a CLI user, I want blocking check failures to return a non-zero exit code, so that scripts can use `archloop check` as a gate.
12. As a CLI user, I want warnings to return success while still being visible, so that non-blocking conditions do not prevent normal use.
13. As a user with many repos, I want `archloop project add`, so that I can register an existing git repo as a Hub project.
14. As a user adding a project, I want archLoop to ask for the repo path, so that I can register projects from any directory.
15. As a user adding a project, I want archLoop to suggest a project name from the repo, so that I have a useful default.
16. As a user adding a project, I want to choose or edit the Hub project name, so that the project is recognizable in lists and GUI navigation.
17. As a user adding a project, I want archLoop to reject duplicate project names, so that command arguments and pickers remain unambiguous.
18. As a user adding a project, I want archLoop to detect an already-registered repo path, so that I do not create duplicate Hub projects for the same repo.
19. As a user adding a project, I want archLoop to require an existing git repo with at least one commit, so that flow execution has a valid branch and history base.
20. As a user adding a project, I want archLoop to suggest a project profile from repo signals and ask me to confirm it, so that setup is convenient but not hidden.
21. As a user adding a project, I want archLoop to create or refresh the Hub project development contract, so that flow prompts have project-specific setup, verification, and context guidance.
22. As a user adding a project, I want archLoop to recommend local task store initialization, so that tasks and flows are ready after onboarding.
23. As a user adding a project, I want to decline task store initialization, so that registration can still complete when I am not ready to use tasks.
24. As a CLI user, I want a newly added project to become the CLI selected Hub project, so that the next command targets the project I just registered.
25. As a CLI user, I want `archloop project select` with no argument to show an interactive picker, so that I do not need to remember project names.
26. As a CLI user, I want `archloop project select <name>`, so that scripts and experienced users can select a project directly.
27. As a CLI user, I want project selection to be explicit and not inferred from cwd, so that starting archLoop from another directory does not silently change targets.
28. As a CLI user, I want `archloop project list` to show lightweight project status, so that I can quickly see which projects are ready or blocked.
29. As a GUI user, I want the GUI project list to use the same registry and status projection as the CLI, so that CLI and GUI show consistent project state.
30. As a GUI user, I want switching projects in the GUI to affect only the GUI active project context, so that my terminal default does not change unexpectedly.
31. As a CLI user, I want `archloop run` with no project argument to use the CLI selected Hub project, so that I can run flows from any directory.
32. As a CLI user, I want `archloop run` with no selected project to show an interactive project picker in a TTY, so that I can choose a target without a setup detour.
33. As a CLI user, I want `archloop run` with no flow to show an interactive flow picker in a TTY, so that the command is usable without memorizing flow ids.
34. As a CLI user, I want non-interactive `archloop run` to require explicit target and flow information, so that scripts do not guess.
35. As a CLI user, I want legacy `archloop run . --flow ...` to keep working temporarily, so that existing workflows do not break immediately.
36. As a CLI user, I want legacy path runs to print migration guidance, so that I learn the new project registry path.
37. As a task-board user, I want `archloop tasks list` to target the CLI selected Hub project by default, so that task commands match run commands.
38. As a task-board user, I want task commands to accept `--project <name>`, so that I can override the selected project without confusing task selectors or titles.
39. As a task-board user, I want task commands without selected project in a TTY to open a project picker, so that I can recover without reading docs.
40. As a task-board user, I want task commands without selected project in non-interactive mode to fail with exact commands, so that scripts are explicit.
41. As a maintainer, I want Hub project ids to be stable, so that runs, tasks, and flow history survive project rename or repo path moves.
42. As a maintainer, I want Hub project names to be unique and renameable, so that users get friendly names without breaking internal identity.
43. As a maintainer, I want repo paths to be relinkable, so that moved projects can keep their Hub history.
44. As a maintainer, I want one registered repo path to map to at most one Hub project, so that Hub and GUI project lists do not duplicate state.
45. As a maintainer, I want `project rename` and `project relink`, so that identity changes are explicit operations rather than hidden edits.
46. As a maintainer, I want `project configure` to remain the command for project profile and development contract setup, so that identity operations stay separate from project-specific execution guidance.
47. As a GUI user, I want Hub flow execution from the GUI to create the same run history and task transitions as CLI `archloop run`, so that both clients are views over one model.
48. As a GUI user, I want project readiness to show missing auth, missing task store, failed tasks, and active runs, so that I know what action to take next.
49. As a user, I want v1 to register existing repos only, so that project onboarding remains focused and predictable.
50. As a future user, I want code project creation to remain a known later direction, so that archLoop can eventually create new repos without overloading v1 registration.

## Implementation Decisions

- Build a Hub project registry as a deep module with a small interface for registering, listing, selecting, renaming, relinking, and reading Hub projects. The registry owns stable project ids, unique project names, repo paths, timestamps, and basic project metadata.
- Replace path-hash identity as the product-facing Hub project model. Existing directory-hash project directories can be treated as a migration/compatibility detail, but new Hub state should reference stable project ids.
- Keep CLI selected Hub project state as CLI client context, stored separately from the shared project registry. GUI active project context is a GUI view state and does not implicitly mutate the CLI selected project.
- Add a target resolver module for Hub commands. It resolves explicit project flags or arguments first, then CLI selected Hub project, then an interactive picker for TTYs, and finally a non-interactive error with exact commands. It must not infer target project from cwd.
- Add a project onboarding service behind `project add`. It validates existing git repo requirements, detects duplicate repo paths, suggests and validates names, recommends project profile from repo signals, writes or refreshes the development contract, and recommends local task store initialization.
- Keep `project configure` focused on project profile and development contract. Add or reserve `project rename` for user-facing name changes and `project relink` for repo path changes.
- Change Hub run targeting so the primary CLI shape is `archloop run --flow <id>` against the selected project or `archloop run <project-name> --flow <id>` / `--project <name>` for explicit targeting. The explicit path form remains a compatibility path with migration guidance.
- Change task command targeting so task subcommands default to selected project and accept `--project <name>` for overrides. Avoid adding a project-name positional argument to task subcommands because task selectors, titles, and PRD refs already use positional arguments.
- Add an interactive run wizard for `archloop run` in TTYs. It selects a project if needed, selects a flow if omitted, prompts for required flow input, summarizes the planned run, and asks for confirmation.
- Add `archloop initialize` as the Hub-wide first-run and repair command. It orchestrates shared agent role setup, env setup, auth guidance/login entry points, and then prints `archloop project add` as the next step. It does not register or select projects.
- Add `archloop check` as the primary readiness command. By default it checks Hub-wide readiness and the CLI selected project if one exists. It supports `--hub`, `--project <name>`, and `--all-projects`.
- `archloop check` must render progress while running. It should use terminal spinners or task logs for each validation step and must not silently wait during provider/model calls.
- Hub-wide checks include agent role completeness, provider/model option validation, env/auth presence, provider/model smoke checks, and required external tool availability.
- Provider/model smoke checks use the same provider path as Hub flow execution. They do not bypass the provider by directly calling model APIs. Checks should use a minimal prompt and deterministic expected response.
- Provider/model smoke checks are deduplicated by provider, model, and provider options, and the result summary lists the roles covered by each check.
- Project checks include repo path existence, git repo validity, initial commit presence, development contract state, local task store state, ready/failed task summary, active runs, and flow readiness signals.
- `archloop check` returns non-zero only for blocking errors. Warnings are visible but return success.
- `initialize` runs a quick Hub check by default after setup, explains that it may perform a small provider/model call, and prints the exact skip command `archloop initialize --skip-check`.
- `project list` uses the registry plus lightweight status/readiness projection. It should show project name, repo path, project profile, selected marker, ready/failed/total task counts, active run state, last activity, and path validity.
- The GUI should consume the same project registry, project status/readiness projection, and Hub flow execution model. GUI run actions are visual frontends for the same Hub flow execution path used by CLI.
- Existing docs, user guide, bundled archLoop usage skill, and roadmap need to move from cwd/path-centered examples toward selected project and project registry examples.

## Testing Decisions

- Tests should assert external behavior and user-visible output, not implementation details of storage files or prompt internals.
- Registry tests should cover project id stability, unique name enforcement, duplicate repo path detection, rename behavior, relink behavior, and missing/path-invalid states.
- Target resolver tests should cover explicit project targeting, selected-project targeting, interactive picker fallback, non-interactive errors, and the absence of cwd fallback.
- Project onboarding tests should cover existing git repo validation, no-initial-commit rejection, profile suggestion with confirmation, development contract creation/update, task store initialization choice, and automatic CLI selected project update after successful add.
- CLI command tests should cover `project add`, `project list`, `project select`, `project rename`, `project relink`, `run`, and representative `tasks` commands using selected project and `--project` overrides.
- Legacy compatibility tests should cover explicit path runs such as `run . --flow ...` and verify migration guidance is printed.
- Check tests should cover Hub-wide success, missing role errors, missing credentials, auth-session detection, provider smoke-check success/failure, deduped provider/model checks, warning vs error exit behavior, and visible progress entries.
- Project check tests should cover missing selected project, selected project success, repo path missing, task store missing, active run summary, failed task summary, and `--all-projects`.
- Interactive command tests should use existing CLI prompt test patterns to assert prompts appear without depending on terminal rendering details.
- GUI-facing projection tests should validate registry/status/readiness data shapes independently from rendering, so future GUI can consume the same model.
- Prior art exists in the current CLI command tests, Hub project status tests, Hub agent config tests, Hub env/auth tests, task board tests, and Display tests. New tests should follow those patterns by checking command behavior and formatted output.

## Out of Scope

- Creating new code projects, new repos, or application scaffolds from `project add`.
- Replacing legacy `archloop init` or removing `.archloop/` scaffold compatibility.
- Saving a default flow per Hub project in v1.
- Inferring the target Hub project from the current working directory in new Hub command paths.
- Sharing one global active project between CLI and GUI.
- Building scheduled/background automations. This PRD's automation language is limited to Hub flow execution through `archloop run` and future GUI run actions.
- Replacing the local task store or changing the Hub task status model.
- Building the full GUI. This PRD defines shared registry/readiness/flow models that the GUI can consume.
- Implementing secret vault or system keychain storage as the only credential backend.

## Further Notes

- This PRD follows the glossary terms in `CONTEXT.md` and the architecture recorded in ADR-0029, "Hub project registry and active context."
- The current implementation already has Hub agent config, Hub env/auth commands, project status/configure, task board commands, and Hub flow execution. The work here is to organize them around explicit Hub project registration, active project context, and readiness checks.
- Roadmap phase 06 already tracks Hub and GUI work. This PRD should become the product reference for Hub project onboarding, `archloop initialize`, `archloop check`, project-centric `run`, and project-centric task commands.
