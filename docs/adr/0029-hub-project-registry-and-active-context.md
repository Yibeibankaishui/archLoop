# Hub project registry and active context

**archLoop Hub** uses a shared **Hub project registry** with stable **Hub project ids**, unique user-facing **Hub project names**, and updateable repo paths. Hub commands target a client-owned **active Hub project context** unless the user specifies a project explicitly; the current working directory is not an implicit project selector.

## Decision

Add a first-class Hub project registry for all Hub clients. Each registered host repo path belongs to at most one Hub project. A Hub project has a stable internal id for runs, tasks, flow execution records, and GUI state; a unique name for display, command arguments, and interactive selection; and a repo path that can be updated when the project moves.

`archloop initialize` remains Hub-wide setup only. It configures shared agent roles, credentials, and provider auth guidance, then points users to `archloop project add` as the next step. It does not register or select a project.

`archloop project add` registers an existing git repo as a Hub project. It asks for or confirms the repo path, project name, project profile, development contract, and local task-store setup. Successful CLI registration sets the new project as the CLI selected Hub project.

CLI commands such as `archloop run` and `archloop tasks ...` resolve their target from an explicit project argument or `--project`, then from the CLI selected Hub project, then from an interactive project picker in TTYs. They do not fall back to the current working directory. The existing explicit path shape, such as `archloop run . --flow with-review`, can remain as a compatibility path with migration guidance.

`archloop check` is the primary readiness command. By default it checks Hub-wide configuration and the CLI selected Hub project when one exists; `--hub`, `--project <name>`, and `--all-projects` narrow or broaden the target explicitly. `archloop initialize` runs a quick Hub check after setup by default, explains that the check may perform a small provider/model call, and prints the exact `archloop initialize --skip-check` command for users who want to skip it.

The future GUI uses the same registry and project ids, but owns its own active project context, like a selected item in a project sidebar. GUI project switching does not implicitly change the CLI selected project; the GUI may expose an explicit action to set the CLI default.

## Consequences

- archLoop becomes a multi-project control plane rather than a repo-local command that infers state from `cwd`.
- Hub runs, tasks, and flow history can survive project renames and repo path moves because they reference stable project ids.
- CLI and GUI can share project data while keeping their current selection visible and client-local.
- Existing cwd-centered commands need migration toward project-name and selected-project targeting.
- `project list` should be a lightweight multi-project status surface, not just a registry dump.

## Considered Options

1. **Infer the project from the current working directory** -- rejected because it keeps archLoop tied to repo-local invocation and can silently switch targets when the user starts the CLI from a different directory.
2. **Use repo path as project identity** -- rejected because paths can move and path hashes are poor user-facing identities.
3. **Use project name as the only identity** -- rejected because names should be user-facing and renameable without breaking historical runs, tasks, or flow history.
4. **Share one global active project between CLI and GUI** -- rejected because GUI navigation, multiple windows, and terminal automation should not implicitly mutate each other's target project.
