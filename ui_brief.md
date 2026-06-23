# UI Brief: archLoop Hub Control Plane

## Goal

Create a production-quality design brief for the archLoop Hub control plane: a task board and run workbench that helps developers turn PRDs, feedback, and synced issues into verified code changes through agent-driven flows. The design should make task status, flow progress, merge/recovery state, and sync boundaries obvious without feeling like a generic issue tracker.

Per user instruction, ignore the currently generated reference UI artifacts. Do not use the existing `gui/` prototype, `gui/assets/archloop-gui-concept.png`, or the previous `ui_brief.md` as design references.

## Product Context

archLoop is an automated software engineering execution system. Users give it tasks, requirements, PRDs, or synced issues; archLoop runs AI coding agents inside controlled execution boundaries, uses worktrees and branch strategies to isolate changes, verifies and reviews work, and moves successful changes toward merge.

archLoop Hub is the user-facing control plane. It manages multiple host repos, shared agent credentials, flows, runs, local tasks, remote task sync, logs, artifacts, and recovery. The Hub task board is not the source task database and not a replacement issue tracker. It is a projection over a local Beads task store, Hub flow events, run/batch/artifact metadata, and remote sync state.

The UI matters because the CLI already exposes the underlying model, but users need a high-confidence visual operating surface for AFK agent work: what is ready, what is running, what is blocked, what failed, what can be recovered, and what has been safely merged and closed.

## Reference Digest

- `CONTEXT.md`: Use the exact product language. Key terms include archLoop, sandbox, host, agent, archLoop Hub, Hub project, Hub task board, local task store, remote task source, task sync, task selector, flow, flow batch, Hub run directory, Hub agent config, Hub agent role, worktree, worktree lease, branch strategy, and completion signal. Avoid calling Hub merely a GUI or dashboard.
- `docs/product-definition-and-scope.md`: archLoop is positioned as a reliable automated engineer, not a cute assistant or one-shot generator. The product promise is "Give it work. It ships verified code." The core scope is task to code, agent execution loop, quality loop, isolated workspaces, Hub/control plane, and capability packs.
- `docs/prd/archloop-hub-task-board.md`: Hub v1 is CLI-first, GUI later consumes the same model. Beads is the local task store. GitHub Issues and similar systems are remote task sources. PRD decomposition and triage are agent-driven proposal flows, but TypeScript orchestration owns validation, approval, state writes, and global transitions. Proposal flows write local Beads state only; remote changes happen through explicit pull/push/sync commands.
- `docs/prd/archloop-hub-task-board.md`: Canonical task statuses are `inbox`, `needs_info`, `ready_for_agent`, `ready_for_human`, `blocked`, `implementing`, `reviewing`, `waiting_for_merge`, `merging`, `done`, `wontfix`, `failed`, and `sync_conflict`. Excluded statuses must not appear: `pending`, `triaging`, `waiting_for_review`, `planning`, `reserved`, `claimed`, `deferred`.
- `docs/prd/archloop-hub-task-board.md`: Execution transitions with review are `ready_for_agent -> implementing -> reviewing -> waiting_for_merge -> merging -> done`; without review they skip `reviewing`. Failure can move any execution status to `failed`; open statuses can become `sync_conflict`; failed tasks can recover to `ready_for_agent`, `blocked`, `ready_for_human`, or `wontfix`.
- `src/taskBoard.ts`: A task projection contains `id`, `title`, `beadsStatus`, `hubStatus`, `claim`, `claimState`, `labels`, `metadata`, `description`, `notes`, `comments`, `remoteRefs`, and `runRefs`. Board groups are status-grouped lists of task projections.
- `src/projectStatus.ts`: Project status exposes repo root, archLoop user data directory, Hub project directory, registration state, Beads availability, task store initialization, ready/total task counts, per-status counts, failed task next actions, sync counts, active batches, run directories, recent events, and worktree lease diagnostics.
- `src/hubExecution.ts`: Hub runs have `runId`, `batchId`, branch, run directory, and JSONL event streams. Events include run start, batch start/planning/merge, task claim/skip/retry, implementation, review, merge, verification, task close, and status advancement. Task claim metadata records `runId`, `batchId`, `branch`, and `claimedAt`; claim is metadata, not a task status.
- `docs/qa/archloop-hub-task-board.md`: Manual QA validates project status without `archloop init`, local task projection, create/comment, PRD proposal sessions, triage proposal sessions, GitHub sync, no-review and with-review flows, merge success, merge failure/recovery, project summary, and legacy init compatibility. The UI should make these workflows easy to inspect.
- `README.md`: CLI surface includes `archloop project status`, `archloop agent-config path/show/init/configure/set-role`, `archloop tasks init/list/show/create/from-prd/triage/pull/push/sync/comment/recover/doctor/delete`, and `archloop run . --flow <id> --input <value>`. The first task-board flows are `no-review`, `with-review`, `prd-decomposition`, and `triage`.
- `docs/package.json` and docs app files: Existing web docs use Next.js 16, React 19, Tailwind CSS 4, and Fumadocs UI. There is no production Hub GUI in the tracked code model. If the Hub UI is implemented inside this repo later, it should reuse modern React/Tailwind patterns but not depend on the docs site navigation as the product UI.

## Reference Index

Use these only for human traceability. The pasteable prompt below is self-contained.

- `CONTEXT.md`
- `docs/product-definition-and-scope.md`
- `docs/prd/archloop-hub-task-board.md`
- `docs/qa/archloop-hub-task-board.md`
- `src/taskBoard.ts`
- `src/projectStatus.ts`
- `src/hubExecution.ts`
- `README.md`
- `docs/package.json`
- Ignored by request: `gui/`, `gui/assets/archloop-gui-concept.png`, previous `ui_brief.md`

## Audience and Usage Context

- Primary users: developers, maintainers, and agent operators who run AFK coding flows across one or more host repositories.
- Usage frequency: daily or weekly during active development; sessions may be long-running while agents implement, review, merge, or recover tasks.
- Environment: desktop-first web application or local GUI; users may keep it open beside a terminal, editor, and GitHub Issues.
- Constraints: must preserve CLI terminology, make local-vs-remote task state explicit, avoid implying Hub directly edits remote issues during proposal flows, and surface recovery actions without hiding risk.

## Design Scope

In scope:

- Hub project overview and status summary.
- Task board grouped by canonical Hub task statuses.
- Task detail drawer or page with Beads details, comments, dependencies, remote refs, run refs, labels, metadata, and history.
- Run workbench for active and recent Hub runs: flow, batch, selected tasks, agent stages, branch/worktree, transcript/events, verification, merge, and recovery.
- Proposal flow surfaces for `from-prd` and `triage`: input, generated proposal, user refinement, validation, approval/apply result, and artifacts.
- Sync and credential/status surfaces: Beads availability, task store initialization, agent role config, GitHub sync state, pending push/conflict counts.
- Recovery and diagnostic views for failed tasks, stale claims, worktree lease mismatches, dirty-source merge gates, and sync conflicts.
- Desktop and mobile reference screens with state coverage.

Out of scope:

- Marketing landing page.
- IDE plugin UI.
- Replacing Beads or GitHub Issues with a new task database.
- Reimagining task statuses or introducing excluded statuses.
- Copying the existing generated static GUI prototype.
- Decorative AI assistant or chat-first visual framing.

## Screens and Flow

| Screen                   | Purpose                                                                          | Primary actions                                                                                             | Data/content                                                                                                                                                                                                                       | Required states                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Hub Project Overview     | Orient the user to one host repo and its operational health                      | Open task board, start/resume flow, configure agent roles, inspect failed work, initialize task store       | Repo root, user data directory, Hub project directory, Beads availability, task store initialized, ready/total counts, status counts, failed tasks, sync counts, active batches, run directories, recent events, lease diagnostics | loading, no repo, task store missing, Beads unavailable, empty project, active flow, failed work, sync conflict            |
| Task Board               | Show local task store projection and execution state                             | Filter by status, search, create task, run triage, run from PRD, open task, start flow, sync/push/pull      | Status columns/groups for all canonical statuses; task id/title, hub status, labels, claim state, remote refs, run refs, warnings, dependency/blocked markers                                                                      | loading, empty board, no ready tasks, grouped statuses, filtered no results, failed tasks, sync conflict, stale claim      |
| Task Detail              | Explain one task and its next action                                             | Comment, triage, recover, push sync state, open remote ref, open run ref, copy selector                     | `id`, `title`, `description`, `notes`, Beads status, Hub status, labels, metadata, claim metadata, comments, remote refs, run refs, dependencies, failure reason, next action                                                      | loading, not found, ambiguous selector, failed task, stale claim, terminal task with cleanup, permission/disabled actions  |
| Run Workbench            | Monitor and control one active or recent Hub run                                 | Cancel if supported, inspect logs/events, view batch, view task branches, recover failed task, resume merge | run id, batch id, flow id, branch, started time, run dir, task ids, planned/deferred tasks, batch status, agent stages, event stream, commits, artifacts, verification, merge/close events                                         | starting, running, completed, completed with failures, failed, cancelled, partial failed batch, no events yet              |
| Proposal Session         | Let users refine agent-generated PRD decomposition or triage before local writes | Enter PRD/task query, review proposal, ask agent to revise, approve/apply, reject, inspect artifacts        | input ref/query, transcript, proposed tasks/triage decisions, dependencies, AFK/HITL classification, confidence, mutation detection, validation errors, apply result                                                               | empty input, running agent, proposal ready, validation errors, unconfirmed guarded decisions, apply success, apply failure |
| Sync Center              | Separate local task truth from remote task exchange                              | Pull, push, preview sync, confirm sync, inspect conflicts                                                   | remote task source, GitHub issue refs, label mapping, local status, remote status, sync state: local only/synced/pull pending/push pending/conflict                                                                                | disconnected, auth missing, dry-run preview, confirmation required, success, partial failure, conflict                     |
| Agent Config             | Configure Hub agent roles used by flows                                          | Set provider/model/options per role, validate missing roles, open env/auth guidance                         | roles: planning, triage, implementation, review, merge, recovery; provider, model, options, missing role diagnostics                                                                                                               | no config, partially configured, all roles ready, invalid provider/model, credentials missing                              |
| Diagnostics and Recovery | Make failures actionable without hiding state                                    | Run recover action, inspect doctor findings, open branch/worktree, copy command, mark next action           | failure reason, branch/worktree/claim/lease state, dirty source files, stale claim, worktree lease mismatch, merge-ready history, sync push needed                                                                                 | no diagnostics, warnings, blocking errors, recoverable failure, manual intervention required                               |

## Functional Requirements

- The UI must consistently use "archLoop Hub", "Hub project", "Hub task board", "local task store", "remote task source", "flow", "flow batch", "Hub run directory", "worktree lease", and "task sync".
- The task board must show only canonical Hub task statuses and must never invent excluded statuses.
- Claimed work must be displayed as task metadata (`runId`, `batchId`, `branch`, `claimedAt`, active/stale), not as a separate status.
- The board must distinguish collaboration state (`inbox`, `needs_info`, `ready_for_agent`, `ready_for_human`, `blocked`, `wontfix`) from execution state (`implementing`, `reviewing`, `waiting_for_merge`, `merging`, `failed`, `done`) and sync state.
- Proposal flows must show approval before local writes. They must not imply direct GitHub mutation.
- Remote sync actions must preview/confirm when appropriate and separate pull, push, and bidirectional sync.
- `done` must mean branch merged, verification passed, and local Beads task closed.
- Failed tasks need a visible failure reason and next action, such as recover, resolve conflict manually, fix verification, retry close, or inspect state.
- Project overview must work for a repo that has not run `archloop init`.
- Full logs/events/artifacts live in Hub run directories; comments and task views should show concise summaries with links/refs to full artifacts.

## Content and Data

- Key entities: Hub project, task, task group, task comment, task dependency, remote ref, run ref, run, flow batch, task event, batch event, claim, worktree lease diagnostic, sync plan, agent role config, proposal session.
- Required task fields: id, title, description, notes, Beads status, Hub status, labels, metadata, comments, remote refs, run refs, claim, claim state, dependency/blocked information, failure reason when failed, sync state when known.
- Required run fields: run id, batch id, flow id, branch, started time, run directory, events directory, status, task ids, selected/deferred tasks, batch strategy requested/used, rationale, commit count, artifacts, diagnostics.
- Example task titles: "Add retry handling with clear acceptance criteria and verification steps", "Human-owned release approval", "Sync Hub task state", "Implement task board pagination".
- Example statuses: `ready_for_agent` with synced GitHub issue, `implementing` with active claim, `waiting_for_merge` after review, `failed` with `verification_failure`, `done` with `push_pending`, `sync_conflict` for semantic local/remote mismatch.
- Empty/error copy needs: missing local task store should tell users to run `archloop tasks init`; unavailable task runtime should mention dependencies, `ARCHLOOP_BD_PATH`, or bundled Beads runtime; missing agent role should point to `archloop agent-config set-role <role> --provider <provider> --model <model>`; failed recoverable tasks should show `archloop tasks recover <id>` as a fallback CLI command.

## Existing Product and Engineering Constraints

- Existing framework/component patterns: the docs app uses Next.js 16, React 19, Tailwind CSS 4, and Fumadocs UI, but the Hub UI should be treated as an application surface, not a documentation page.
- Existing design system or UI library: no production app design system exists. The design agent should define tokens and components that can later be implemented with React/Tailwind or an equivalent local app stack.
- Layout constraints: desktop-first, dense operational UI. Users need side-by-side board, details, run events, terminal-like output, and merge/recovery diagnostics.
- Routing constraints: support direct links to Hub project overview, task board, task detail, run detail, proposal session, sync center, agent config, and diagnostics.
- Data constraints: data may arrive from CLI-equivalent commands, local Beads store, JSONL event files, Hub project state, GitHub sync metadata, and local filesystem diagnostics.
- Auth/permissions constraints: credentials and auth state are sensitive. UI should report configured/missing/expired states without exposing token values.
- Behaviors that must not change: local Beads remains the complete local task source; remote sources are synchronized explicitly; agent judgment is stage-local; TypeScript orchestration owns global state transitions; Hub flows must not read repo-local `.archloop/` prompts when invoked through Hub flow commands.

## Visual Direction

- Desired feel: calm, professional operations console for a reliable automated engineer. It should feel controlled, auditable, and high-trust.
- Information density: high but structured. Prefer split panes, tables, compact status chips, timelines, and inspector drawers over oversized cards.
- Typography direction: utilitarian sans-serif with strong numeric/tabular readability. Use small, clear headings inside panels; avoid hero-scale typography in the app shell.
- Color direction: restrained neutral base with distinct semantic colors for ready, active, blocked, failed, done, sync conflict, and warning. Avoid one-note palettes, decorative gradients, and generic AI-purple dominance.
- Motion/interaction tone: subtle progress and event updates. Use motion to indicate live flow activity and state transitions, not decoration.
- Anti-goals: no marketing hero, no chat-app framing, no cute assistant persona, no decorative blobs/orbs, no ambiguous "pending" states, no visual design that hides the difference between local task store and remote task source.

## Responsive and Accessibility Requirements

- Desktop: primary target. Support a three-region layout: navigation/project rail, main board or run timeline, and detail/inspector pane. Users should be able to scan many tasks and keep run details open.
- Tablet/mobile: preserve read and recovery workflows. Collapse to status tabs, searchable task list, task/run detail pages, and bottom action bars. Do not require drag-and-drop for status understanding.
- Keyboard/focus: all filters, tabs, command buttons, task rows, event rows, and drawers must be keyboard accessible with visible focus states.
- Contrast/readability: status chips and event severity must meet contrast requirements without relying on color alone.
- Screen reader/semantic needs: task status, sync state, failure reason, and claim state should be exposed as text labels. Event timelines should have semantic ordered/list structure.

## Interaction and State Requirements

- Navigation: project switcher, overview, task board, runs, proposals, sync, agent config, diagnostics/settings.
- Filters/search/sort: filter by Hub status, sync state, failure reason, claim state, remote source, flow, batch, label, warning severity, and text query. Sort by status priority, updated time, dependency readiness, and failure severity.
- Forms/validation: create task, comment, PRD proposal input, triage query, sync confirmation, role config. Validate missing titles, invalid selectors, missing role/provider/model, missing task store, and unsafe sync/remote actions.
- Loading: show skeletons for board groups, task detail, run timeline, and sync preview; live event streams should support "no events yet".
- Empty: empty project, no local task store, no ready tasks, no failed tasks, no sync conflicts, no active runs, no proposal artifacts.
- Error: Beads unavailable, task store not initialized, ambiguous task selector, GitHub auth unavailable, sync conflict, mutation detection failure, verification failure, merge conflict, close failure, dirty source worktree gate.
- Success: task created, comment added, proposal applied, sync applied, task recovered, run completed, verification passed, task closed.
- Permission/disabled: disable remote sync actions when auth is missing; disable flow start when required agent roles are missing; disable direct status edits for execution statuses driven by flow events.

## Design Agent Instructions

Create 2-3 distinct design directions before converging. Preserve the functional requirements and information hierarchy. Prefer reusable UI patterns over decorative novelty.

Output:

- A `design.md` or equivalent design specification.
- Desktop and mobile reference screens for overview, task board, task detail, run workbench, proposal session, sync center, and diagnostics.
- Design tokens: color, typography, spacing, radii, shadows, motion, semantic status colors, and terminal/event styling.
- Component mapping and interaction notes.
- State coverage for loading, empty, error, disabled, success, live-running, failed, sync-conflict, and recovery states.
- Asset list and source notes.
- Any tradeoffs, assumptions, and implementation risks.

## Pasteable Design-Agent Prompt

Design an archLoop Hub control plane UI for a developer tool named archLoop. archLoop is an automated software engineering execution system: users give it tasks, PRDs, feedback, or synced issues; archLoop runs AI coding agents inside controlled execution boundaries, uses sandboxes/worktrees/branches, verifies and reviews work, and moves successful changes toward merge. Product promise: "Give it work. It ships verified code."

Do not use any existing generated reference UI. Do not copy a static prototype or concept image. Build the design from this product model.

Use these exact domain terms: archLoop, archLoop Hub, Hub project, Hub task board, local task store, remote task source, task sync, flow, flow batch, Hub run directory, Hub agent config, Hub agent role, sandbox, host, agent, worktree, worktree lease, branch strategy, task selector.

Core model:

- archLoop Hub is the user-facing control plane. It manages multiple host repos, shared agent credentials, flows, runs, local tasks, remote task sync, logs, artifacts, and recovery.
- The Hub task board is not a replacement issue tracker. It is a projection over a local Beads task store, Hub flow events, run/batch/artifact metadata, and remote sync state.
- GitHub Issues and similar systems are remote task sources. Remote changes happen through explicit pull/push/sync actions.
- PRD decomposition and triage are agent-driven proposal flows. They can recommend tasks or status updates, but the user approves before local writes. They write local Beads state only and must not look like they directly mutate GitHub.
- TypeScript orchestration owns global state transitions. Agents make local stage judgments.

Design scope:

1. Hub Project Overview: repo root, archLoop user data directory, Hub project directory, project registered state, Beads availability, task store initialized, ready/total counts, per-status counts, failed task next actions, sync counts, active batches, recent events, run directories, worktree lease diagnostics.
2. Task Board: grouped by canonical Hub statuses with search/filter/sort. Task cards/rows show id, title, labels, hub status, sync state, claim state, remote refs, run refs, warning/failure markers, dependencies/blockers.
3. Task Detail: id, title, description, notes, Beads status, Hub status, labels, metadata, comments, remote refs, run refs, dependencies, claim metadata, failure reason, next action, recovery/sync/comment actions.
4. Run Workbench: active/recent run with run id, batch id, flow id, branch, started time, run directory, task ids, selected/deferred tasks, batch strategy, rationale, agent stages, event stream, commits, artifacts, verification, merge, task close events, recovery actions.
5. Proposal Session: PRD decomposition and triage input, transcript, generated proposal, dependencies, AFK/HITL classification, confidence, validation errors, mutation detection, approve/apply result.
6. Sync Center: GitHub/remote task source pull, push, sync preview/confirm; label mapping; sync states local only, synced, pull pending, push pending, conflict.
7. Agent Config: roles such as planning, triage, implementation, review, merge, recovery; provider/model/options; missing role diagnostics and auth hints.
8. Diagnostics and Recovery: failed tasks, stale claims, worktree lease mismatch, dirty source worktree gates, merge conflicts, verification failures, close failures, sync conflicts.

Canonical task statuses are only: `inbox`, `needs_info`, `ready_for_agent`, `ready_for_human`, `blocked`, `implementing`, `reviewing`, `waiting_for_merge`, `merging`, `done`, `wontfix`, `failed`, `sync_conflict`.

Never introduce these excluded statuses: `pending`, `triaging`, `waiting_for_review`, `planning`, `reserved`, `claimed`, `deferred`. Claim is metadata, not a status. Claim metadata includes `runId`, `batchId`, `branch`, and `claimedAt`, with active or stale claim state.

Execution transitions:

- With review: `ready_for_agent -> implementing -> reviewing -> waiting_for_merge -> merging -> done`.
- Without review: `ready_for_agent -> implementing -> waiting_for_merge -> merging -> done`.
- Failure can move execution statuses to `failed`. Open statuses can become `sync_conflict`. Failed tasks recover to `ready_for_agent`, `blocked`, `ready_for_human`, or `wontfix`.
- `done` means branch merged, verification passed, and local Beads task closed.

CLI-equivalent actions to surface:

- `archloop project status`
- `archloop agent-config path/show/init/configure/set-role`
- `archloop tasks init/list/show/create/from-prd/triage/pull/push/sync/comment/recover/doctor/delete`
- `archloop run . --flow <id> --input <value>`
- First flows: `no-review`, `with-review`, `prd-decomposition`, `triage`

Visual direction:

- Desktop-first operational console, not marketing page.
- Calm, professional, high-trust, auditable, "reliable automated engineer" tone.
- Dense but organized. Use split panes, compact tables/lists, timelines, inspector drawers, status chips, event streams, and terminal/log panels.
- Use a restrained neutral base with distinct semantic colors for ready, active, blocked, failed, done, sync conflict, warning, and disabled states.
- Avoid chat-first framing, decorative AI imagery, cute assistant persona, hero sections, gradients/orbs, or one-note purple palettes.

Responsive/accessibility:

- Desktop: navigation/project rail, main board or run timeline, detail inspector pane.
- Mobile/tablet: collapse to status tabs, searchable lists, task/run detail pages, bottom action bars.
- All controls keyboard accessible with visible focus. Status must not rely on color alone. Event timelines should be semantic lists.

Please produce:

- 2-3 distinct design directions first, then a recommended direction.
- Desktop and mobile reference screens for overview, task board, task detail, run workbench, proposal session, sync center, and diagnostics.
- Design tokens for color, type, spacing, radii, shadows, motion, status colors, and terminal/event styling.
- Component mapping, interaction notes, empty/loading/error/success/disabled/live/failure/recovery state coverage.
- Implementation risks and assumptions.

## Assumptions and Open Questions

- Assumption: the requested brief targets a future archLoop Hub GUI/control plane, not the existing documentation site.
- Assumption: implementation will likely use a React/Tailwind-compatible stack, but the design should stay framework-neutral enough for a local desktop/web shell.
- Assumption: no production Hub GUI component library exists yet.
- Open question: should the first implementation be a local static web app, a packaged desktop app, or integrated into the docs/app workspace?
- Open question: should the UI support multi-project switching in v1, or focus on one Hub project at a time with project switching deferred?
- Open question: which artifacts should be viewable inline versus opened from the Hub run directory?
