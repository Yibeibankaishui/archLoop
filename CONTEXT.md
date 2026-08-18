# archLoop

A TypeScript toolkit that orchestrates AI coding agents inside isolated sandbox environments, managing the lifecycle of sandboxes, branches, prompts, and iterations.

## Language

### Core concepts

**archLoop**:
The TypeScript CLI tool that orchestrates an **agent** inside a **sandbox**.
_Avoid_: "the tool", "the CLI", "RALPH"

**Sandbox**:
The isolation boundary around the **agent** -- a container, VM, or similar environment that constrains the **agent**'s access.
_Avoid_: "container" (too specific), "Docker sandbox" (ambiguous with Claude's built-in feature), "workspace"

**Host**:
The developer's machine where archLoop runs and the real git repo lives.
_Avoid_: "local" (ambiguous -- the sandbox also has a local filesystem)

**Agent**:
The AI coding tool invoked inside the **sandbox** (e.g. Claude Code, Codex).
_Avoid_: "RALPH", "the bot", "Claude" (too specific -- agent is swappable)

**archLoop Hub**:
The user-facing control plane that manages multiple **host** repos, shared credentials, **flows**, runs, and backlog status.
_Avoid_: "workspace" (conflicts with sandbox/worktree language), "GUI" (too narrow), "dashboard" (display-only)

**Hub project**:
A user-named **archLoop Hub** entry that points to one **host** repo path and stores user preferences for running archLoop there.
_Avoid_: "project profile" (already means repo type), "workspace", "repo" (too narrow)

**Hub project id**:
The stable internal identity of a **Hub project**, used by Hub state, runs, tasks, and flow execution records even when the project name or repo path changes.
_Avoid_: "project name", "repo path", "directory hash"

**Hub project name**:
The user-facing unique name of a **Hub project**, used for display, command arguments, and interactive selection; it can be renamed without changing the **Hub project id**.
_Avoid_: "project id", "repo folder name", "package name"

**Selected Hub project**:
The **Hub project** the user has explicitly chosen, or just registered through CLI **Hub project onboarding**, as the default target for Hub commands when no project name is provided; it is not inferred from the current working directory.
_Avoid_: "current repo", "current working directory", "active workspace", "cwd fallback"

**Active Hub project context**:
The **Hub project** currently targeted by one archLoop client, such as the CLI or **archLoop Hub** GUI. Each client owns its own active context while sharing the same **Hub project** registry, and Hub commands target that context unless a project is specified explicitly.
_Avoid_: "current working directory", "global active project", "workspace"

**Hub project config**:
The **archLoop Hub**-owned settings for a **Hub project**, separate from the repo's **config directory**.
_Avoid_: "config directory", ".archloop config", "init config"

**Hub initialization**:
The idempotent **archLoop Hub**-wide setup for shared preferences, credentials, and readiness. It does not create, register, or select a **Hub project**; it only points users to **Hub project onboarding** as the next step.
_Avoid_: "project init", "repo init", "scaffold init"

**Hub readiness check**:
A Hub-wide validation, exposed through `archloop check`, that shared agent role, provider, model, credential, auth session, and required-tool settings are complete enough for **flow** execution. The check is user-visible while it runs, with progress output for each validation step.
_Avoid_: "project status", "task doctor", "repo validation"

**Hub project onboarding**:
The process of creating or selecting a **Hub project** for a **host** repo, including the project's user-facing identity, project-specific preferences, **Hub project assets**, and default-ready local task setup.
_Avoid_: "Hub initialization", "legacy init", "scaffold init"

**Hub project registration**:
Creating a **Hub project** entry for an existing **host** repo.
_Avoid_: "code project creation", "repo scaffold", "legacy init"

**Hub project registry**:
The **archLoop Hub**-owned index of **Hub projects**, where each registered **host** repo path belongs to at most one **Hub project**.
_Avoid_: "project directory list", "workspace list", "recent repos"

**Code project creation**:
Creating a new **host** repo or application project that can later be registered as a **Hub project**.
_Avoid_: "Hub project registration", "Hub initialization", "project selection"

**Hub project assets**:
Editable files owned by **archLoop Hub** for one **Hub project**, such as Hub-managed bootstrap, verification, and context files.
_Avoid_: "config directory", "scaffolded project files", "repo assets"

**Hub asset mount**:
The sandbox-visible location where **Hub project assets** are made available during a **flow** run.
_Avoid_: "worktree copy", "repo mount", ".archloop"

**Hub run directory**:
The run-specific **archLoop Hub** location that stores logs, events, artifacts, and copied-out verification outputs for one **flow** run.
_Avoid_: "run log" (a single file), "worktree", "project assets"

**Hub task board**:
The **archLoop Hub** projection that shows a **Hub project**'s tasks from the **local task store** with archLoop workflow and sync state.
_Avoid_: "backlog manager" (source system), "issue tracker", "run log"

**Local task store**:
The Beads-backed task store that **archLoop Hub** uses as the local source for task planning, triage, dependencies, and task board state.
_Avoid_: "Hub tasks JSON", "issue tracker", "remote backlog"

**Hub-owned task store**:
The **local task store** whose Beads database and runtime/export files live in the stable per-project **Hub project directory**, outside the code repository. A Git-ignored `.beads/redirect` may preserve direct `bd` command compatibility from the repository.
_Avoid_: "repo task store", "task branch data", "shared remote database"

**Task snapshot**:
An immutable, attempt-scoped projection of the selected task and required dependency/context data supplied to an execution agent. Agents do not receive write access to the live **Hub-owned task store**.
_Avoid_: "Beads clone", "task database copy", "cached task"

**Task-store migration**:
The journaled, idempotent relocation of an existing repository-local Beads store into the **Hub-owned task store**, followed by installation of a Git-ignored `.beads/redirect`. Hub quarantines the legacy database from new writes, verifies the cold copy before switching, and preserves the original as a recoverable backup.
_Avoid_: "Beads reset", "task import", "JSONL migration"

**Remote task source**:
An external task system such as GitHub Issues that can synchronize with the **local task store**.
_Avoid_: "source of truth" (the Hub works from the local task store), "backlog manager" when discussing sync direction

**Task sync**:
The pull/push process that reconciles tasks between a **remote task source** and the **local task store**.
_Avoid_: "import" (one-way), "mirror" (implies perfect identity), "backup"

**Task projection**:
A Hub-owned view of a **task** derived from the **backlog manager** and archLoop run events.
_Avoid_: "task source", "canonical task", "issue"

**Task origin**:
How a **task** entered the **local task store**, such as PRD decomposition, user feedback, manual entry, or **task sync**.
_Avoid_: "category" (reserved for bug/enhancement), "source of truth"

**Task selector**:
A user-provided reference to one **task** in the **Hub task board**, resolved as an exact Beads id or exact task title. The 1-based number formerly emitted by `archloop tasks list` is no longer a valid selector — see `docs/adr/0031-cli-task-selectors-drop-ordinal-input.md`.
_Avoid_: "task id" when title is also accepted, "query" (implies fuzzy matching), "list number" / "ordinal" (the removed form).

**Slice type**:
Whether a PRD-derived **task** is AFK-ready for an **agent** or HITL-owned by a human.
_Avoid_: "category" (reserved for bug/enhancement), "status"

**archLoop user data directory**:
The **host** user data location where archLoop stores **archLoop Hub** state such as **Hub project config**, credential references, and run history.
_Avoid_: "home directory", "install directory", "global .archloop"

**Hub env file**:
The plaintext `.env` file in the **archLoop user data directory** that stores shared credentials for **archLoop Hub** flows.
_Avoid_: "secret vault", "credential reference", "project .env"

**Hub auth directory**:
A provider-specific login-state directory in the **archLoop user data directory** that **archLoop Hub** can mount into a **sandbox**.
_Avoid_: "Hub env file" (API-key storage), "secret vault", "project auth directory"

### Sandboxes

**Sandbox provider**:
A pluggable implementation that creates and manages a **sandbox**, injected into `run()` via the `sandbox` option.
_Avoid_: "backend", "runtime", "sandbox factory"

**Bind-mount sandbox provider**:
A **sandbox provider** where the **host** filesystem is mounted directly into the environment.
_Avoid_: "local provider", "mount provider"

**Isolated sandbox provider**:
A **sandbox provider** where the environment has its own filesystem, requiring sync to move code in and commits out.
_Avoid_: "remote provider", "sync provider"

**No-sandbox provider**:
A **sandbox provider** where no container is created -- the **agent** runs directly on the **host**.
_Avoid_: "local provider", "none provider", "host provider"

### Branching

**Branch strategy**:
Configuration on a **sandbox provider** that controls how the agent's changes relate to branches, set at provider construction time.
_Avoid_: "worktree mode" (old name), "branch mode"

**Head (branch strategy)**:
A **branch strategy** where the **agent** works directly in the **host** working directory -- no **worktree**, no branch indirection.
_Avoid_: `"none"` (old name), "direct"

**Merge-to-head (branch strategy)**:
A **branch strategy** where archLoop creates a temporary branch, the agent works on it, and changes are merged back to HEAD.
_Avoid_: `"temp-branch"` (old name), "auto-branch"

**Branch (branch strategy)**:
A **branch strategy** where commits land on an explicitly named branch provided by the caller.
_Avoid_: "named-branch"

**Worktree**:
A git worktree created in `.archloop/worktrees/` on the **host**, used by the **merge-to-head** and **branch** strategies. For **bind-mount sandbox providers**, the **worktree** is mounted into the **sandbox**. For **isolated sandbox providers**, the **worktree** is the sync source/destination -- commits from the **sandbox** are pulled back into the **worktree**. Created explicitly via `createWorktree()` or implicitly by `run()`/`interactive()` when using a non-**head** **branch strategy**.
_Avoid_: "workspace", "branch copy", "clone"

**Worktree lease**:
A time-bounded claim that one archLoop run session, interactive session, or **flow** run owns a **worktree**.
_Avoid_: "workspace lease", "directory lock"

**Source branch**:
The branch the **agent** works on -- determined by the **branch strategy**.
_Avoid_: "working branch", "agent branch"

**Target branch**:
The **host**'s active branch at `run()` time -- the branch archLoop merges into when using **merge-to-head**.
_Avoid_: "base branch", "destination branch", "merge target"

**Hub publish target**:
The authoritative Git ref for one **Hub project** against which verified task work is atomically landed.
_Avoid_: "target branch", "current branch", "host checkout"

**Hub-managed local target**:
The archLoop-owned local Git ref used as the default **Hub publish target** without requiring a remote repository.
_Avoid_: "integration branch", "temporary branch", "remote branch"

**Merge candidate**:
A commit created by integrating a task's source work against a pinned **Hub publish target**, before it is landed.
_Avoid_: "merged task", "shipped commit", "target branch"

**Candidate chain**:
An ordered sequence of **merge candidates** in which each candidate is built on the prior candidate for the same **Hub publish target**. Exact candidate OIDs may be verified concurrently, but landing preserves the chain order.
_Avoid_: "parallel merges", "batch merge commit", "candidate queue"

**Merge input fingerprint**:
The durable identity of the task source commit, pinned **Hub publish target**, merge-resolution policy, and verification configuration used to produce and verify one **merge candidate**. Hub retries a terminal merge conflict only after this fingerprint changes or the user explicitly requests a retry.
_Avoid_: "run id", "merge hash", "retry token"

**Candidate repair**:
A bounded agent attempt to modify an isolated **merge candidate** after semantic conflict resolution or project verification fails. Each repair is followed by full verification and never mutates the user's checkout.
_Avoid_: "retry merge", "hotfix on target", "post-merge fix"

**Landing**:
The compare-and-swap advancement of a **Hub publish target** to a verified **merge candidate**.
_Avoid_: "checkout update", "workspace sync", "force push"

**Landing transaction**:
The durable per-task workflow that pins a **merge input fingerprint**, creates and verifies a **merge candidate**, advances the **Hub publish target** with compare-and-swap, closes the local task, and reconciles optional publication and checkout projections.
_Avoid_: "batch merge", "git merge command", "run transaction"

**Landing receipt**:
A transaction-specific Git ref advanced atomically with the **Hub publish target** and its fence, proving which exact verified candidate completed local landing.
_Avoid_: "merge event", "reflog entry", "task status"

**Landing lease**:
Short-lived exclusive ownership of one **Hub publish target**'s compare-and-swap window. The owner is identified by a nonce, process start identity, and boot identity. A demonstrably live owner is not displaced merely because a TTL elapsed.
_Avoid_: "file lock", "worktree lease", "merge lock"

**Landing coordinator**:
The per-**Hub publish target** owner of the **landing lease**, fenced target advancement, and queue-head rebuild after **target drift**.
_Avoid_: "batch merger", "git lock", "scheduler"

**Target drift**:
The **Hub publish target** OID changed after a **merge candidate** was built against it. The stale candidate and its verification artifact are invalidated, rebuilt on the new target, and fully reverified before another landing attempt.
_Avoid_: "merge failed", "CAS retry without rebuild"

**Landing transaction reconciliation**:
Reconstructing missing **landing transaction** checkpoints from durable physical evidence (candidate refs/manifests, verification artifacts, atomic **landing receipts**, Beads close metadata, and resource absence) at mutating entry points. Read-only commands may display the evidence but must not write checkpoints or advance the transaction.
_Avoid_: "tasks recover", "event replay", "merge recovery"

**Target quiet wait**:
A durable, automatically retried landing condition entered after repeated target drift. The oldest transaction retains its FIFO position while Hub waits for a stable target window.
_Avoid_: "merge failed", "retry exhausted", "requeue"

**Remote publication**:
The compare-and-swap advancement of an explicitly configured remote Git ref from a landed **Hub publish target**. It is asynchronous under the `best_effort` **publish policy** and required delivery under `required`.
_Avoid_: "landing", "task sync", "GitHub issue sync"

**Publish policy**:
The per-project code-delivery rule: `off` keeps delivery local and is the default, `best_effort` publishes asynchronously without blocking **shipped**, and `required` requires remote ancestry proof before **shipped**.
_Avoid_: "merge mode", "remote mode", "sync policy"

**Shipped task**:
A task whose verified **merge candidate** has completed **landing** and whose local task record has been closed. Under the `required` **publish policy**, the required **remote publication** must also have completed.
_Avoid_: "merge succeeded", "integration succeeded", "agent finished"

**Checkout sync**:
A best-effort update that makes the **host**'s checked-out branch reflect a landed **Hub publish target** without changing uncommitted user work.
_Avoid_: "landing", "merge completion", "stash and replay"

**Checkout sync pending**:
A non-failure reconciliation condition (`checkout_sync_pending`) recorded when **checkout sync** cannot safely update the host's checked-out branch. It does not change whether a task is **shipped**, does not block later tasks, and is retried automatically.
_Avoid_: "merge failed", "recovery required", "dirty worktree failure"

### Agents

**Agent provider**:
A pluggable implementation that builds commands and parses output for a specific **agent**, injected into `run()` via the `agent` option.
_Avoid_: "agent adapter", "agent driver"

### Execution

**Agent invoker**:
The Effect service (`Context.Tag`) that wraps the raw call handing a fully-resolved **prompt** to the **agent provider** for one **iteration**. The seam used to substitute a recording or scripted fake in tests without running a real **agent**.
_Avoid_: "agent runner", "agent caller"

**Iteration**:
A single invocation of the **agent** inside the **sandbox**, producing at most one commit against one **task**.
_Avoid_: "run" (ambiguous with the JS `run()` function), "cycle", "loop"

**Flow**:
A runtime-selectable orchestration shape for a archLoop run.
_Avoid_: "template" (reserved for scaffolded files), "script", "main file", "agent-flow" (too narrow)

**Agent-driven task command**:
A task-board CLI command whose judgment-producing work is performed by a **flow**, while the command remains as a user-friendly shortcut and archLoop owns validation, confirmation, and state writes.
_Avoid_: "plain CLI logic" (misses the **agent** judgment), "skill call" (too provider-specific), "hidden flow"

**Judgment-producing task command**:
A task-board CLI command whose primary outcome depends on semantic judgment, such as PRD decomposition or task triage.
_Avoid_: "task command" (too broad), "CRUD command" (not judgment-producing), "heuristic command"

**Task proposal**:
A schema-validated **structured output** produced by an **agent-driven task command** before archLoop writes to the **local task store**.
_Avoid_: "task mutation" (too early), "agent result" (too vague), "draft" (ambiguous with human notes)

**Proposal flow**:
A no-sandbox **flow** that produces a **task proposal** without directly changing code or writing to the **local task store**.
_Avoid_: "analysis command" (too vague), "sandboxed planning flow" (incorrect), "direct task writer"

**Proposal session**:
An interactive **proposal flow** conversation where the user and **agent** refine a **task proposal** before archLoop validates and applies it.
_Avoid_: "chat" (too generic), "approval prompt" (too narrow), "one-shot proposal"

**Flow batch**:
A group of **tasks** selected together by a **flow** and coordinated through the same implement/review/merge cycle.
_Avoid_: "iteration" (already one agent invocation), "run" (too broad), "sprint"

**Interrupted execution**:
A **task** whose **hub status** is still an execution state (`implementing`, `reviewing`, `merging`) but whose owning **worktree lease** is no longer active — the run process died before the phase completed. archLoop routes recovery by consulting the run event log (`task_implementation_succeeded` / `task_review_succeeded`): a finished phase is preserved, an unfinished one retries from `ready_for_agent` reusing the preserved **worktree**.
_Avoid_: "stuck task" (vague about cause), "orphaned task" (implies no owner metadata, which may still be present), "failed task" (a distinct **hub status** with its own recovery path)

**Flow prompt**:
A **prompt** owned by a **flow**, used when archLoop runs that **flow** through **archLoop Hub**.
_Avoid_: "prompt template" (ambiguous with scaffolded prompts), "project prompt"

**Hub agent config**:
A **archLoop Hub**-wide configuration that selects the **agent provider**, model, and provider-specific options for each stage inside each **flow**.
_Avoid_: "agent profile" (already used by init scaffold metadata), "project agent config" (too narrow), "model config" (provider is part of the decision)

**Hub agent role**:
A reusable stage-level entry in **Hub agent config**, such as planning, triage, implementation, review, merge, or recovery.
_Avoid_: "flow override" (too specific), "agent profile" (init scaffold metadata), "project role" (too narrow)

**Task**:
A work item from the **backlog manager** that the **agent** selects and works on during an **iteration**.
_Avoid_: "job", "work item", "ticket"

**Completion signal**:
The `<promise>COMPLETE</promise>` marker in the **agent**'s output indicating all actionable tasks are finished. A pure termination signal -- carries no payload. Distinct from **structured output**.
_Avoid_: "done flag", "exit signal", conflating with **structured output**

**Structured output**:
A schema-validated JSON payload emitted by the **agent** inside a caller-specified XML tag and returned to the caller of `run()`. Configured via `output: Output.object({ tag, schema })`. Orthogonal to the **completion signal** -- a run can use either, both, or neither. The caller owns the prompt-side instruction telling the agent to emit the tag; archLoop does not inject it, and `run()` errors early if the resolved prompt does not contain the configured tag.
_Avoid_: "output payload", "result", "JSON output"

**Output schema**:
The Standard Schema validator (e.g. Zod, Valibot) the caller passes alongside the XML tag name to parse and validate **structured output**.
_Avoid_: "validator", "result schema"

### Prompts

**Prompt**:
The instruction text passed to the **agent** at the start of each **iteration**.
_Avoid_: "system prompt" (too specific), "instructions" (too vague), "message"

**Inline prompt**:
A **prompt** provided as a string via the `prompt` option. Passed through to the **agent** as-is — no **prompt argument substitution**, no **prompt expansion**.
_Avoid_: "dynamic prompt", "string prompt"

**Prompt template**:
A **prompt** sourced from a file via the `promptFile` option. May contain `{{KEY}}` placeholders and `` !`command` `` **shell expressions**, which are resolved via **prompt argument substitution** and **prompt expansion** before being passed to the **agent**.
_Avoid_: "prompt file" (refers to the option, not the concept), "template prompt"

**Prompt assembly**:
The **init** step that creates a scaffolded **prompt template** by combining **preset agent** role text with **skills**, **capability pack** context, verification guidance, and selected **capability add-ons**.
_Avoid_: "prompt expansion" (already means evaluating **shell expressions**), "runtime prompt injection"

**Prompt argument**:
A runtime **template argument** passed via `promptArgs` in `run()` that substitutes a `{{KEY}}` placeholder in a **prompt**.
_Avoid_: "prompt variable" (ambiguous with env vars), "template variable", "parameter"

**Prompt argument substitution**:
**Template argument substitution** applied to a **prompt** at runtime, using the **prompt arguments** map.
_Avoid_: "template expansion", "interpolation", "variable substitution"

**Prompt expansion**:
The preprocessing step that evaluates **shell expressions** in a **prompt**, replacing them with their stdout.
_Avoid_: "prompt preprocessing" (too generic), "command expansion"

**Shell expression**:
A `` !`command` `` marker in a **prompt** that evaluates a shell command inside the **sandbox**.
_Avoid_: "command" (overloaded), "inline command", "prompt command"

**Built-in prompt argument**:
A **prompt argument** that archLoop injects automatically -- not provided by the user via `promptArgs`.
_Avoid_: "system variable", "auto argument", "default prompt argument"

### Hooks

**Host hook**:
A lifecycle hook that runs on the **host** machine, not inside the **sandbox**. Host hooks are `{ command: string }` — no `sudo`, no `cwd`.
_Avoid_: "local hook"

**Sandbox hook**:
A lifecycle hook that runs inside the **sandbox** container. Sandbox hooks are `{ command: string; sudo?: boolean }`.
_Avoid_: "container hook", "remote hook"

### Init

**Init**:
The CLI command that scaffolds the **config directory** in a **host** repo.
_Avoid_: "create", "bootstrap", "new"

**Setup action**:
An explicit user-approved action during **init** that may prepare the **host** repo or **host** tools beyond writing scaffold files.
_Avoid_: "automatic setup" (implies no consent), "scaffold" (scaffold files are not the same as mutating project dependencies)

**Hub setup action**:
An explicit user-approved action during **archLoop Hub** project onboarding that may modify a **host** repo, **host** tool state, or external backlog state without writing Hub-owned orchestration assets into the repo.
_Avoid_: "scaffold", "automatic setup", "init setup action"

**Config directory**:
The `.archloop/` directory in a **host** repo containing sandbox configuration.
_Avoid_: ".archloop folder", "archloop dir"

**Backlog manager**:
A pluggable source of **tasks** for the **agent**, selected during **init** (e.g. GitHub Issues, Beads).
_Avoid_: "task source", "issue tracker"

**Project profile**:
A project-type choice made during **init** that describes the host repo's language or build-system shape (e.g. Node, Python, C++), independent of the selected **template** or **backlog manager**.
_Avoid_: "task type", "project template", "stack" (ambiguous with runtime stack)

**Capability pack**:
An **init** choice that specializes archLoop for a class of development work by composing a **template**, **project profile**, **preset agents**, **skills**, context files, verification entrypoints, and optional **capability add-ons**.
_Avoid_: "project profile" (too narrow), "template" (workflow shape only), "agent pack" (too agent-specific)

**Capability add-on**:
An optional extension to a **capability pack** that adds specialized context or tooling for a narrower workflow, often depending on a particular **sandbox provider** or **host** state.
_Avoid_: "plugin" (overloaded), "preset" (ambiguous with **preset agent**)

**Capability variant**:
A narrower supported project shape inside a **capability pack**. The first WeChat Mini Program **capability pack** variant is native.
_Avoid_: "framework" (too implementation-specific), "sub-pack" (unclear relationship to **capability pack**)

**Generic project profile**:
The default **project profile** that makes no language-specific assumptions about the host repo.
_Avoid_: "auto", "unknown"

**Verification entrypoint**:
A user-editable executable scaffolded in the **config directory** that checks whether the host repo satisfies a **capability pack**'s development loop after the **agent** changes code.
_Avoid_: "bootstrap" (setup before work), "test script" (too narrow)

**Verification wrapper**:
Logic inside a **verification entrypoint** that runs a project-owned validation command while preserving the **capability pack**'s diagnostic contract.
_Avoid_: "adapter" (too generic), "shim" (too informal)

**Verification layer**:
A level of confidence in a **capability pack** development loop, from local checks through platform validation, runtime debugging, and cloud validation. Higher layers may depend on **host** tools or external credentials.
_Avoid_: "test stage" (too narrow), "phase" (ambiguous with roadmap phases)

**Platform validation status**:
The reported outcome of a credentialed platform **verification layer**, distinguishing unconfigured validation from configured validation that passed or failed.
_Avoid_: "tool status" (too tool-specific), "CI status" (too narrow)

**Verification diagnostic log**:
A structured log written by a **verification entrypoint** for the **agent** and user to inspect after a capability-specific check runs.
_Avoid_: "run log" (reserved for archLoop run output), "stdout" (not structured enough)

**Verification artifact**:
A run output produced by a **verification entrypoint** that helps the user or **agent** inspect validation results.
_Avoid_: "config file" (artifacts are outputs, not scaffold configuration), "build artifact" (too narrow)

**Credential drop zone**:
A user-controlled local location that a **capability pack** may document or detect for credentials, without generating, copying, committing, uploading, or owning those credentials.
_Avoid_: "credential store" (implies archLoop manages secrets), "secret manager" (implies external secret lifecycle)

**Capability manifest**:
The metadata file in the **config directory** that records which **capability pack**, **capability add-ons**, and **verification entrypoint** were scaffolded during **init**.
_Avoid_: "runtime config" (the scaffolded workflow can run without re-reading it), "lockfile" (not a dependency resolution artifact)

**Template argument**:
A named `{{KEY}}` placeholder in a scaffold template (Dockerfile, prompt `.md` file) that **init** replaces with a value derived from the user's choices.
_Avoid_: "placeholder", "variable"

**Template argument substitution**:
The preprocessing step during **init** that replaces **template arguments** with their resolved values.
_Avoid_: "template expansion", "interpolation"

### Infrastructure

**Build-image**:
A provider-namespaced CLI command that rebuilds the image (e.g. `archloop docker build-image`).
_Avoid_: "setup-sandbox" (old name)

**Remove-image**:
A provider-namespaced CLI command that removes the image (e.g. `archloop docker remove-image`).
_Avoid_: "cleanup-sandbox" (old name)

**Agent session**:
The **agent**'s persisted conversation record. Storage shape and location are owned by the **agent provider** -- Claude Code writes a `<session-id>.jsonl` under `~/.claude/projects/<encoded-cwd>/`; other agents use their own conventions (e.g. `~/.codex/sessions/`, `~/.pi/agent/sessions/`, OpenCode's SQLite store). Resumable when the **agent provider** declares session-storage support; the resume mechanism is the agent's native flag (e.g. `claude --resume`, `codex exec resume`, `pi --session`).
_Avoid_: "chat history", "transcript"

### Display

**Log-to-file mode**:
The display mode where archLoop writes iteration progress and agent output to a **run log**.
_Avoid_: "file mode", "file logging", "quiet mode"

**Run log**:
A log file written to `.archloop/logs/` during a run session.
_Avoid_: "log file" (too generic), "output file"

**Terminal mode**:
The display mode where archLoop renders an interactive UI in the terminal with spinners and styled status messages.
_Avoid_: "stdout mode", "interactive mode", "CLI mode" (ambiguous with the CLI itself)

**Hub task board view**:
The terminal-mode rendering of the **Hub task board** — the visual layout with header line, status badges, per-status task groups, and a footer tip. Distinct from the underlying **Hub task board** (the data projection): the same board data can be rendered as the **Hub task board view** (terminal mode), the `--json` payload, or the `--plain` fallback. Grouping and default filtering (e.g. hiding **done** by default) are properties of the view, not the underlying board.
_Avoid_: "task list screen" (ambiguous with `archloop tasks list` command), "board card", "board panel"

**Hub run card**:
The terminal-mode rendering of a Hub run in progress — an alt-screen dashboard with four regions: a fixed header (project · flow · run short id · outcome · elapsed), a **Hub run done ledger** listing completed **tasks** and **flow batches** (append-only within the run, scrolls internally when the terminal is short), a live-updating active card showing every active **flow batch** and every active **task** with its current phase and phase-elapsed, and a fixed footer with the run log path and hotkeys. On exit — user pressed `q`, SIGINT, or run completed — the CLI leaves the alt-screen and dumps a plain-text summary (header + full ledger + logs path) into real terminal scrollback so the user has a durable record of what shipped. It is the visual counterpart of the plain-text streaming events available in **log-to-file mode**; the same underlying run state can be rendered as the **Hub run card** (terminal mode), the run log (log-to-file mode), or the `--json` / `--stream` event stream. See ADR-0033.
_Avoid_: "run panel", "batch card" (a run card contains multiple batches), "live view" (ambiguous with `--follow`), "run status card" (redundant), "append-only run card" (superseded — see ADR-0032/0033).

**Hub run done ledger**:
The append-only region of the **Hub run card** listing tasks and **flow batches** that completed during the current run. Each row is `<outcome-symbol> <id>  <title>  <duration>`, oldest at top, newest at bottom. When the terminal is shorter than the ledger plus the other **Hub run card** regions, the ledger drops rows from its top and shows a dim `… N earlier shipped, see run log` sentinel; the run log file holds the unbounded history. The ledger is what makes "completed tasks stay visible to the user after they finish" true; without it the alt-screen card would erase completed work from view.
_Avoid_: "done list" (too generic), "history panel" (evokes a separate window), "run log" (that's the file, not the ledger).

**Agent stream event**:
A single item in the **agent**'s output stream -- either a `text` chunk or a `toolCall` -- surfaced to the caller of `run()` so the stream can be forwarded to an external observability system. Available only in **log-to-file mode** via the `onAgentStreamEvent` callback on the `logging` option. Each event carries its `iteration` number and a `timestamp`.
_Avoid_: "log event" (the log file contains more than just agent output), "display entry" (internal UI type)

## Relationships

- **archLoop** orchestrates an **agent** inside a **sandbox**
- A **sandbox** is created by a **sandbox provider**, which is injected into `run()` via the `sandbox` option -- this is required, there is no default
- A **sandbox provider** is a **bind-mount sandbox provider**, **isolated sandbox provider**, or **no-sandbox provider**
- Each **sandbox provider** has a **branch strategy** configured at construction time
- A **bind-mount sandbox provider** supports all three **branch strategies**: **head** (default), **merge-to-head**, and **branch**
- An **isolated sandbox provider** supports **merge-to-head** (default) and **branch** only -- **head** is not valid because it cannot write directly to the **host** filesystem
- A non-**head** **branch strategy** requires a **worktree lease** before the **agent** can use a **worktree**
- A **worktree lease** acquired by a Hub **flow** should identify the owning **task** and **flow batch** when that context exists
- A Hub task retry starts from the preserved task branch and **worktree**, and the retry **flow** must tell the **agent** to continue from the preserved work rather than start from scratch
- An **isolated sandbox provider** handles syncing code in and extracting commits out -- optionally using **bundle/patch sync**. **Isolated sandbox providers are defined in the type system but not yet implemented**
- A **no-sandbox provider** supports all three **branch strategies** (default: **head**). It is accepted by `run()`, `createSandbox()`, and `interactive()` -- the caller opts in to host execution by importing `noSandbox()`. The **agent provider** does not receive `dangerouslySkipPermissions: true`
- `run()`, `createSandbox()`, and `interactive()` all accept any **sandbox provider** type, including **no-sandbox**
- **Sandbox providers** are imported from subpaths (e.g. `archloop/sandboxes/docker`) -- the main `archloop` entry point does not re-export any provider
- **Host hooks** run on the **host**; **sandbox hooks** run inside the **sandbox**. Hooks are grouped under `host` and `sandbox` in the `hooks` option
- Lifecycle ordering: `copyToWorktree` -> `host.onWorktreeReady` (sequential) -> sandbox created -> `host.onSandboxReady` + `sandbox.onSandboxReady` (parallel)
- Each **iteration** may produce one or more commits; iterations repeat until the **completion signal** fires or the max count is reached
- A provider non-zero exit with no **agent** output (a transient startup abort) does not fail a multi-**iteration** run while iterations remain; the next **iteration** continues with a progress summary, and a zero-commit exploration turn is nudged toward implementation. Exhausting the iteration limit with no **completion signal** and no commits is still a failure.
- **Init** creates the **config directory** on the **host**, prompting the user to select an **agent**, **backlog manager**, and **project profile**
- **Init** may also prompt the user to select a **capability pack**. archLoop does not silently infer a **capability pack** from repository files in the first version.
- A **template** defines the scaffolded workflow shape; a **project profile** defines the repo environment and bootstrap assumptions. They compose independently.
- A **capability pack** composes existing init concepts for specialized development work; it may choose defaults for **template**, **project profile**, **preset agents**, **skills**, context files, verification entrypoints, and **capability add-ons**.
- A **template** controls **agent** orchestration shape; a **capability pack** controls domain context, verification contract, diagnostic log contract, and completion reporting for that specialized work.
- **Capability pack** defaults are overridden by explicit **init** choices such as `--template`, `--project-profile`, or `--preset-agents`.
- A **capability add-on** may scaffold context and **prompt templates** without installing external tools or completing host authentication.
- The first WeChat Mini Program **capability pack** supports only the native **capability variant**; cross-framework variants such as Taro or uni-app are not supported in the first version.
- The WeChat Mini Program **capability pack** core loop supports sandboxed and **no-sandbox provider** init paths; its MCP-oriented **capability add-ons** require the **no-sandbox provider** in the first version.
- A **capability pack** owns scaffold artifacts in the **config directory** by default; it does not modify host repo application files such as `package.json` in the first version.
- **Init** writes a **capability manifest** when a **capability pack** is selected. The manifest records scaffold metadata; generated workflows do not need to read it to run in the first version.
- The default **project profile** is generic; **init** does not infer a language-specific profile automatically.
- The first supported **project profiles** are generic, Node, Python, and C++.
- A **project profile** contributes project language and build-tool requirements to the generated Dockerfile or Containerfile.
- The **generic project profile** generates a no-op bootstrap script and does not add language-specific tools to the generated Dockerfile or Containerfile.
- An **agent runtime** contributes the agent CLI installation layer; a **backlog manager** contributes task-source tooling; a **sandbox provider** decides the containerfile name and runtime family.
- Interactive **init** asks users to choose a **project profile**; that choice drives the generated Dockerfile or Containerfile and the generated bootstrap script.
- **Init** generates the bootstrap script directly from the selected **project profile**; templates do not generate it at run time.
- Scaffolded templates run the generated bootstrap script through a **sandbox hook**; they do not scaffold a bootstrap-generation prompt.
- **Init** does not execute or validate the generated bootstrap script; it is first run by the scaffolded workflow's **sandbox hook**.
- The generated bootstrap script is not part of image build; it runs inside the **sandbox** after the worktree is mounted and before the **agent** runs.
- A **verification entrypoint** is separate from the generated bootstrap script: bootstrap prepares the repo before agent work, while verification checks the result after agent changes.
- The WeChat Mini Program **capability pack** uses layered verification: native fallback verification is the required core loop when a project-specific `wx:check` is absent, while `miniprogram-ci` platform validation is recommended, automatically enabled when its configuration is detected, and host-dependent runtime or cloud validation is optional.
- **archLoop Hub** uses the **local task store** as the local source for task planning and the **Hub task board**; **remote task sources** synchronize into and out of it through **task sync**.
- Hub projects use a **Hub-owned task store** outside the code repository. A local `.beads/redirect` preserves direct `bd` command discovery, while execution agents consume a read-only **task snapshot** and Hub orchestration owns task-state writes.
- Existing Hub projects perform **task-store migration** automatically on first use. An active Beads writer, source fingerprint change, unsafe snapshot, or migration contention before quarantine keeps the verified old store active, records **task-store migration pending**, and retries with durable backoff without blocking a flow run. Independent modification of both the leftover legacy database and the Hub-owned store after redirect is **task-store split brain**: automatic task-store writes stop, and neither database is merged or deleted.
- A **Hub-managed local target** is the default **Hub publish target**; a remote repository is optional rather than a dependency of **landing**.
- A **merge candidate** is verified before **landing**; **checkout sync** happens only when it is safe and does not determine whether landing succeeded.
- The default **publish policy** is `off`. `best_effort` preserves local-first completion while **remote publication** is pending; `required` is an explicit per-project delivery contract and never becomes active merely because a Git remote exists.
- If **checkout sync** cannot preserve the user's uncommitted state, Hub records **checkout sync pending**, continues later work, and retries reconciliation without stash or replay.
- A semantic merge conflict gets at most two agent resolution-and-verification attempts for the same **merge input fingerprint**. If both fail, the task enters **blocked** with reason `merge_conflict_unresolved`; independent tasks continue, and Hub does not retry the unchanged conflict indefinitely.
- Each eligible task in a **flow batch** has its own **landing transaction**. A successful task is not rolled back when a sibling task fails; independent siblings continue, dependent siblings remain **blocked**, and the batch reports `partial_failed` when outcomes are mixed.
- A failed candidate verification receives at most two **candidate repair** attempts for the same **merge input fingerprint**. If full verification still fails, the task enters **blocked** with reason `verification_failed`; the unverified candidate never lands and independent tasks continue.
- Tasks for one target form a durable FIFO/dependency-ordered **candidate chain**. Candidate OIDs may verify concurrently, but only the queue head may land; after repeated drift it retains its position in **target quiet wait** instead of requeuing behind newer tasks.
- **Landing** atomically advances the expected target, fencing ref, and **landing receipt**. Recovery derives missing checkpoints from those refs and exact OIDs rather than trusting display events.
- **Blocked** is a **Hub task board** status with a reason, not a family of separate task statuses.
- Durable human decisions or human work should be represented as separate **tasks**; dependent agent-ready **tasks** are **blocked** by those human-owned dependencies.
- **Waiting for merge** is a stable **Hub task board** status because a task may finish implementation and review before the rest of its flow batch is ready to merge.
- When a **flow batch** reaches landing, each eligible **task** independently enters its ordered **landing transaction**; the batch aggregates outcomes but is not a shared Git transaction boundary.
- A **project profile** is an **init** scaffolding choice, not a public runtime option on `run()`, `createSandbox()`, or a **sandbox provider**.
- The generated bootstrap script is a user-editable scaffold artifact owned by the host repo after **init**.
- The generated bootstrap script prepares the repo for agent work; it does not run full project verification by default.
- **Init** performs **template argument substitution** on Dockerfiles and scaffold `.md` files, replacing **template arguments** with values derived from the user's choices
- Each **backlog manager** declares a Dockerfile snippet (installed via **template argument substitution**) and command placeholders for **prompt** templates
- The **agent**'s Dockerfile template contains **template arguments** (e.g. `{{BACKLOG_MANAGER_TOOLS}}`) that **init** fills in based on the selected **backlog manager**
- **Build-image** and **remove-image** are namespaced under their provider in the CLI (e.g. `archloop docker build-image`)
- The **agent provider** is selected via the `agent` field in config or `--agent` CLI flag
- At launch, archLoop resolves env vars from **config directory** `.env` and `process.env`, then passes the full env map into the **sandbox**
- **Inline prompts** bypass **prompt argument substitution** and **prompt expansion** entirely -- they are passed to the **agent** as-is. `promptArgs` cannot be combined with an **inline prompt**; doing so raises an error
- **Prompt argument substitution** and **prompt expansion** only apply to **prompt templates** (prompts sourced via `promptFile`)
- **Prompt assembly** happens during **init** and writes scaffolded **prompt templates** into the **config directory**; it is not a runtime option on `run()` in the first version.
- **Prompt argument substitution** runs once after prompt resolution, replacing `{{KEY}}` placeholders with values from **prompt arguments** -- this happens on the **host**, before the **sandbox** exists
- **Prompt expansion** runs before each **iteration**, evaluating all **shell expressions** inside the **sandbox**
- **Prompt argument substitution** runs before **prompt expansion**, so **prompt arguments** can inject values into **shell expressions**
- A `{{KEY}}` placeholder in a **prompt template** with no matching **prompt argument** is an error in `run()` (AFK mode); in `interactive()`, archLoop prompts the user to fill in missing values
- Unused **prompt arguments** produce a warning
- A **prompt** may contain zero or more **prompt arguments** and/or **shell expressions**; each substitution step is skipped if there are no matches
- archLoop injects **built-in prompt arguments** `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` automatically
- If a user passes `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs`, **prompt argument substitution** fails with an error -- **built-in prompt arguments** cannot be overridden
- **Target branch** defaults to the **host**'s current branch at `run()` time (via `git rev-parse --abbrev-ref HEAD`)
- **Source branch** is either the explicitly provided `branch` option or a archLoop-generated temp branch
- **Log-to-file mode** is the default for programmatic use via `run()`; **terminal mode** is used when passing `logging: { type: 'stdout' }` to `run()`
- In **log-to-file mode**, archLoop writes a **run log** to `.archloop/logs/` and prints a `tail -f` command to the console
- In **terminal mode**, archLoop renders spinners, styled status messages, and summaries directly in the terminal
- In **log-to-file mode**, callers may pass an `onAgentStreamEvent` callback on the `logging` option to receive each **agent stream event** alongside the file log -- intended for forwarding the **agent**'s output to an external observability system. The callback is sync, fire-and-forget, and errors thrown by the callback are swallowed so a broken forwarder cannot kill the run

## Example dialogue

### Sandbox providers & branch strategies

> **Dev:** "What if I want to use Podman instead of Docker?"

> **Domain expert:** "Import a different **sandbox provider**. Instead of `import { docker } from 'archloop/sandboxes/docker'`, use `import { podman } from 'archloop/sandboxes/podman'`. Both are **bind-mount sandbox providers** -- the **branch strategy** controls how changes land. By default it's **head**, so the agent writes directly to your working directory."

> **Dev:** "What if I want safety -- a temp branch that merges back?"

> **Domain expert:** "Pass `branchStrategy: { type: 'merge-to-head' }` when constructing the provider. archLoop creates a **worktree**, the agent works on a temp branch, and it gets merged back to HEAD when done."

> **Dev:** "What about a cloud VM that can't bind-mount my local filesystem?"

> **Domain expert:** "That would be an **isolated sandbox provider**. It defaults to **merge-to-head** -- syncs code in, agent works, changes get merged back. You can also use `{ type: 'branch', branch: 'foo' }` to sync back to a named branch. But you can't use **head** -- there's no host directory to write to directly."

> **Dev:** "Can I write my own provider?"

> **Domain expert:** "Yes. Implement a function that returns a `SandboxProvider`. If your environment can mount a host directory, use the bind-mount factory -- archLoop handles worktrees and commit extraction for you. If not, use the isolated factory and implement `copyIn`, `copyFileOut`, and `extractCommits`. The **branch strategy** is configured on the provider at construction time."

### No-sandbox provider

> **Dev:** "I want to use `interactive()` without Docker -- I'm sitting right here, I can approve permissions myself."

> **Domain expert:** "Use the **no-sandbox provider**: `noSandbox()`. The **agent** runs directly on the **host** with no container. archLoop won't pass `--dangerously-skip-permissions` to the **agent provider**, so Claude Code's normal permission prompts stay active."

> **Dev:** "Can I still use a worktree with `noSandbox()`?"

> **Domain expert:** "Yes. All three **branch strategies** work. If you want the agent to work on a temp branch and merge back, pass `branchStrategy: { type: 'merge-to-head' }`. The worktree lifecycle is the same -- it's just not mounted into a container."

> **Dev:** "What about using `noSandbox()` with `run()` for an AFK job?"

> **Domain expert:** "Allowed -- `run()` and `createSandbox()` both accept `noSandbox()`. There's no isolation, so only opt in when archLoop itself is already running inside an isolated environment, like containerized CI, a VM, or a sandbox host. The explicit `noSandbox()` import is the opt-in."

### Prompt system

> **Dev:** "I want to reuse the same **prompt** file for multiple issues in parallel. How do I pass the issue number in?"

> **Domain expert:** "Use **prompt arguments**. Put `{{ISSUE_NUMBER}}` in the **prompt** file, then pass `promptArgs: { ISSUE_NUMBER: 42 }` to `run()`. **Prompt argument substitution** replaces it before anything else runs."

> **Dev:** "What if I also have a **shell expression** that uses the issue number -- like `` !`gh issue view {{ISSUE_NUMBER}}` ``?"

> **Domain expert:** "That works. **Prompt argument substitution** runs first on the **host**, so `{{ISSUE_NUMBER}}` becomes `42` everywhere -- including inside **shell expressions**. Then **prompt expansion** evaluates the **shell expression** inside the **sandbox**."

> **Dev:** "What happens if I typo the key -- like `{{ISSUE_NUBMER}}`?"

> **Domain expert:** "**Prompt argument substitution** fails with an error. Every `{{KEY}}` in the **prompt** must have a matching **prompt argument**. The reverse is just a warning -- unused **prompt arguments** don't block execution."

> **Dev:** "My prompt has `{{ISSUE_NUMBER}}` but I forgot to pass it in `promptArgs`. What happens in interactive mode?"

> **Domain expert:** "archLoop scans the **prompt**, finds the missing `{{ISSUE_NUMBER}}`, and prompts you at the terminal to type it in. In `run()` it would just error -- there's nobody to ask."

### Agent providers & environment

> **Dev:** "What if I want to add support for OpenCode instead of Claude Code?"

> **Domain expert:** "Create a new **agent provider**. It declares which env vars it needs -- maybe `OPEN_CODE_API_KEY` instead of `ANTHROPIC_API_KEY`. And it provides its own Dockerfile template that installs the right binary."

> **Dev:** "How does archLoop know which **agent provider** to use?"

> **Domain expert:** "The `agent` option passed to `run()`, or the `--agent` CLI flag. archLoop loads env vars and passes them straight through to the **sandbox** -- the **agent** handles missing credentials on its own."

### Built-in prompt arguments

> **Dev:** "My reviewer agent diffs against `main`, but I'm working from a feature branch. The diff is huge."

> **Domain expert:** "Use the **built-in prompt argument** `{{TARGET_BRANCH}}` in your **prompt**. It resolves to the **host**'s active branch at `run()` time -- so if you kick off archLoop from `feature/auth`, the reviewer diffs against `feature/auth`, not `main`."

> **Dev:** "Can I override `{{TARGET_BRANCH}}` in `promptArgs`?"

> **Domain expert:** "No -- **built-in prompt arguments** can't be overridden. If you pass `TARGET_BRANCH` in `promptArgs`, **prompt argument substitution** fails with an error. Use a different key name if you need a custom value."

### Hub landing and checkout sync

> **Dev:** "Does a Hub flow need `origin/main` before it can finish merging a task?"
>
> **Domain expert:** "No. The verified **merge candidate** lands on the **Hub-managed local target** by default. Remote publication is optional."
>
> **Dev:** "What if my checked-out branch has uncommitted changes?"
>
> **Domain expert:** "Those changes do not block **landing**. archLoop attempts **checkout sync** only when it can preserve the user's uncommitted state without stash or replay."

## Flagged ambiguities

- **"Worktree mode"** -- The old name for **branch strategy**. Use **branch strategy** -- it describes where changes land, not the mechanism.
- **"Provider"** -- Overloaded: both **agent provider** and **sandbox provider** exist. Always qualify -- never say just "provider" in isolation.
- **"Docker sandbox"** -- In this project, **sandbox** is our isolation concept, not Claude Code's built-in `docker sandbox` CLI feature.
- **"Container"** vs **"Sandbox"** -- "Container" is a Docker/Podman primitive; **sandbox** is our abstraction. Use **sandbox** for the concept, "container" only for provider implementation details.
- **"Local"** vs **"Host"** -- Use **host** for the developer's machine. "Local" is ambiguous (the **worktree** is also on a local filesystem).
- **"Run"** -- Can mean the JS `run()` function or a single **iteration**. Use **iteration** for one agent invocation; "run session" for a call to `run()`.
- **"Token"** vs **"Env var"** -- archLoop handles all environment variables generically. Use "env var" for the general concept; "token" only for auth credential values.
- **"Command"** -- Overloaded: hook commands, shell commands, CLI commands, **shell expressions**. Use **shell expression** for `` !`...` `` syntax; "hook" for lifecycle hooks; "CLI command" for `archloop init`, etc.
- **"Variable"** vs **"Argument"** -- **Prompt arguments** are host-side values substituted into `{{KEY}}` placeholders. Env vars are passed into the **sandbox** environment. Don't call prompt arguments "variables".
- **"File mode"** vs **"Log-to-file mode"** -- Use **log-to-file mode**. "File mode" is ambiguous. Similarly, avoid "stdout mode" for **terminal mode**.
- **"Base branch"** vs **"Target branch"** -- Use **target branch**. "Base branch" is ambiguous in archLoop's context.
- **"Target branch"** vs **"Hub publish target"** -- **Target branch** belongs to the programmatic branch-strategy interface and follows the host's active branch at `run()` time; **Hub publish target** is the stable authoritative Git ref used by Hub landing and must not be inferred from the current checkout.
- **"Built-in"** vs **"Default"** prompt arguments -- "Default" implies overridable. **Built-in prompt arguments** cannot be overridden. Use "built-in".
- **"No sandbox"** vs **"local"** vs **"none"** -- The provider type is `NoSandboxProvider`, the factory is `noSandbox()`, the tag is `"none"`. Say **no-sandbox provider** in prose.
- **"Workspace"** -- Retired term. Use **worktree** for the git worktree on the **host**, and **sandbox** for the isolation boundary. Don't say "workspace" in this project.
- **"Interactive mode"** -- Could mean `interactive()` (archLoop's function) or Claude Code's TUI. In this project, it means archLoop's `interactive()`. Don't confuse with **terminal mode**.
- **"Pending"** -- Too broad for the **Hub task board**. Use a precise status such as `inbox`, `needs_info`, `ready_for_agent`, `ready_for_human`, `blocked`, or `waiting_for_merge`.
