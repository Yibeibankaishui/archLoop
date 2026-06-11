# PRD: Sandcastle Hub Task Board

## Problem Statement

Sandcastle's current project workflow is centered on `sandcastle init`, a repo-local `.sandcastle/` config directory, and scaffolded `main.mts` scripts. That path works for a single initialized project, but it makes multi-project operation, shared credentials, flexible runtime flow selection, and task progress visibility difficult.

Users need a Sandcastle Hub task board that can manage tasks locally, synchronize with remote task sources such as GitHub Issues, and show how Sandcastle flows move tasks through planning, implementation, review, merge, and completion. The task board must support both PRD-driven task creation and user feedback-driven tasks, while preserving Sandcastle's orchestration principle: agents make local judgments inside a stage, but TypeScript orchestration controls global state transitions.

## Solution

Add a Hub task board built on Beads as the local task store. Hub uses Beads for task storage, comments, dependencies, ready queues, and local task state. Remote systems such as GitHub Issues are remote task sources synchronized into and out of the local task store through task sync.

The Hub task board is not a separate issue tracker. It is a projection over:

- Beads task state and dependency graph.
- Hub flow events.
- Hub run, batch, and artifact metadata.
- Remote sync state.

Hub v1 should provide CLI-first task board workflows. GUI can later consume the same model.

## Goals

- Use Beads as the local source for task planning, triage, dependencies, and task board state.
- Support pull/push task sync with remote task sources such as GitHub Issues.
- Support PRD decomposition into dependency-aware tasks.
- Support user feedback and manual task creation.
- Preserve triage roles while adding Sandcastle execution states.
- Show task, batch, and run progress in a stable state model.
- Make Hub flow merge outcomes observable per task.
- Keep full run logs and artifacts in Hub run directories, while writing concise task comments.

## Non-Goals

- Do not replace Beads with a Hub-owned task database.
- Do not require GitHub Issues as the primary task board.
- Do not make remote task sources perfectly mirror every Hub execution state.
- Do not treat old scaffolded `main.mts` templates as the task board source of truth.
- Do not add `pending`, `triaging`, `waiting_for_review`, `planning`, `reserved`, `claimed`, or `deferred` as task statuses.

## User Stories

1. As a developer, I want PRDs to be broken into independently grabbable tasks with dependencies, so that agents can work safely in parallel.
2. As a developer, I want user bug reports and improvement feedback to enter an inbox, so that they can be triaged before any agent work starts.
3. As a maintainer, I want triage to classify tasks as needing info, ready for agent, ready for human, or wontfix, so that task ownership is explicit.
4. As a maintainer, I want human-owned work to be represented as tasks, so that agent-owned tasks can depend on them instead of hiding human work in a blocked reason.
5. As an agent operator, I want Beads dependencies to drive the ready queue, so that agents only pick unblocked tasks.
6. As an agent operator, I want claimed tasks to be protected from other concurrent Hub flows, so that two runs do not implement the same task.
7. As a reviewer, I want implementation, review, and merge progress to appear on the task board, so that I know where each task sits in the flow.
8. As a maintainer, I want failed runs to be distinguishable from blocked tasks, so that temporary execution failures do not become permanent task facts.
9. As a maintainer, I want merge progress to be observable per task, so that partial batch failures can be recovered safely.
10. As a maintainer, I want completed tasks to close locally even if remote sync is delayed, so that Beads remains the complete local task source.
11. As a collaborator using GitHub Issues, I want core triage labels and closure state to sync remotely, so that remote users can still follow task status.
12. As a developer, I want concise Beads comments for triage and Sandcastle run summaries, so that task history is readable without dumping full logs.

## Task Sources

Hub v1 supports two task creation paths:

- `sandcastle tasks from-prd <prd-ref>` decomposes a PRD into vertical slices.
- `sandcastle tasks create` creates a manual or user feedback task.

PRD decomposition follows the tracer-bullet issue style:

- Each slice must be independently verifiable.
- Each slice is classified as AFK or HITL.
- Dependency relationships must be confirmed by the user.
- Approved dependencies must be written to the Beads dependency graph.

Default task creation states:

- Manual or user feedback tasks enter `inbox`.
- PRD-derived tasks enter `inbox` by default.
- PRD-derived tasks may enter `ready_for_agent` or `ready_for_human` directly only after the user confirms slice granularity, dependencies, and AFK/HITL classification.

## Local And Remote Task Model

Beads is the local task store. GitHub Issues and future systems are remote task sources.

Task sync reconciles remote task sources with Beads:

- Pull new or updated remote tasks into Beads.
- Push core local task state back to remote sources.
- Preserve Beads as the complete local state source.
- Represent sync conflicts explicitly with `sync_conflict`.

Remote task sources should receive core collaboration state, not every Sandcastle execution state.

Remote label/action mapping:

| Hub status        | Remote label/action |
| ----------------- | ------------------- |
| `inbox`           | `needs-triage`      |
| `needs_info`      | `needs-info`        |
| `ready_for_agent` | `ready-for-agent`   |
| `ready_for_human` | `ready-for-human`   |
| `blocked`         | `blocked`           |
| `wontfix`         | `wontfix` + close   |
| `done`            | close               |
| `sync_conflict`   | `sync-conflict`     |

These statuses are not required as remote labels:

- `implementing`
- `reviewing`
- `waiting_for_merge`
- `merging`
- `failed`

`failed` is a Hub execution condition, not a remote collaboration label. Hub may push a concise failure summary comment when useful.

## Task Statuses

Hub task board v1 uses these canonical task statuses:

```ts
type HubTaskStatus =
  | "inbox"
  | "needs_info"
  | "ready_for_agent"
  | "ready_for_human"
  | "blocked"
  | "implementing"
  | "reviewing"
  | "waiting_for_merge"
  | "merging"
  | "done"
  | "wontfix"
  | "failed"
  | "sync_conflict";
```

Status meanings:

- `inbox`: Task exists but has not been analyzed.
- `needs_info`: Task description is incomplete and needs reporter/user input.
- `ready_for_agent`: Task is fully specified and suitable for AFK agent work.
- `ready_for_human`: Task is valid but owned by human work.
- `blocked`: Task is valid and specified, but cannot proceed until a condition is satisfied.
- `implementing`: Task has been claimed by a Hub flow and is in implementation.
- `reviewing`: Reviewer stage is active for the task.
- `waiting_for_merge`: Implementation and review, if any, are complete; task is waiting for its flow batch to merge.
- `merging`: Task is part of a batch currently handed to the merge phase.
- `done`: Branch merged, verification passed, and local Beads task closed.
- `wontfix`: Task is explicitly not being actioned and local Beads task is closed.
- `failed`: Sandcastle execution failed for this task and needs recovery.
- `sync_conflict`: Local and remote task state conflict semantically and need human resolution.

Explicitly excluded task statuses:

- `pending`
- `triaging`
- `waiting_for_review`
- `planning`
- `reserved`
- `claimed`
- `deferred`

## Status Fields

Task status should stay small. Reasons and secondary state are fields.

Suggested reason fields:

```ts
type BlockedReason = "dependency" | "needs_info" | "auth" | "external_system";

type FailureReason =
  | "agent_failed"
  | "sandbox_failed"
  | "merge_conflict"
  | "verification_failure"
  | "close_failed"
  | "unknown";

type SyncState =
  | "local_only"
  | "synced"
  | "pull_pending"
  | "push_pending"
  | "conflict";
```

`sync_failed` is sync subsystem state, not a task status. For example, a task can be `done` with `syncState: "push_pending"` when a remote close request fails because credentials expired.

## Triage Mapping

Hub task statuses map to canonical triage roles:

| Hub status        | Triage role                 |
| ----------------- | --------------------------- |
| `inbox`           | unlabeled or `needs-triage` |
| `needs_info`      | `needs-info`                |
| `ready_for_agent` | `ready-for-agent`           |
| `ready_for_human` | `ready-for-human`           |
| `wontfix`         | `wontfix`                   |

`blocked` is not a triage role. It is a task board status for valid tasks whose next action is blocked by dependency, auth, external system, or missing information that has already been identified.

Human work that blocks agent work should be represented as its own `ready_for_human` task. Agent tasks should then be blocked by dependency, not by an opaque human-decision reason.

## Beads Mapping

Beads native status should carry the coarse lifecycle. Hub-specific task state is represented through Beads labels/custom metadata and comments.

Recommended mapping:

| Hub status          | Beads coarse state              |
| ------------------- | ------------------------------- |
| `inbox`             | open + `needs-triage` label     |
| `needs_info`        | open + `needs-info` label       |
| `ready_for_agent`   | open + `ready-for-agent` label  |
| `ready_for_human`   | open + `ready-for-human` label  |
| `blocked`           | blocked + reason metadata       |
| `implementing`      | in_progress + label             |
| `reviewing`         | in_progress + label             |
| `waiting_for_merge` | in_progress + label             |
| `merging`           | in_progress + label             |
| `done`              | closed + `done` marker          |
| `wontfix`           | closed + `wontfix` marker       |
| `failed`            | open + `failed` label           |
| `sync_conflict`     | blocked + `sync-conflict` label |

`failed` remains open because it is recoverable. It should not become Beads blocked unless a human recovery action determines the task has a durable external blocker.

## Flow Batches

A flow batch is a group of tasks selected together by a flow and coordinated through the same implement/review/merge cycle.

Batch statuses:

```ts
type FlowBatchStatus =
  | "planning"
  | "implementing"
  | "reviewing"
  | "waiting_for_merge"
  | "merging"
  | "done"
  | "partial_failed"
  | "failed";
```

`planning` exists only at batch level. It is not a task status.

`waiting_for_merge` is a stable task status because a task may finish implementation and review before the rest of its flow batch is ready to merge.

When a flow batch enters merge, all eligible tasks in that batch move from `waiting_for_merge` to `merging` together. Fine-grained per-branch progress belongs in run events, not in task board columns.

## Run Statuses

Hub run statuses:

```ts
type HubRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "completed_with_failures"
  | "failed"
  | "cancelled";
```

Definitions:

- `starting`: Hub is preparing project config, credentials, assets, or sandbox setup.
- `running`: At least one flow batch is active.
- `completed`: Flow ended normally and all handled batches completed.
- `completed_with_failures`: Flow completed the work it could, but one or more tasks or batches failed.
- `failed`: Run-level failure prevented normal flow operation.
- `cancelled`: User explicitly stopped the run.

## State Transitions

Triage and human transitions:

```text
inbox
  -> needs_info
  -> ready_for_agent
  -> ready_for_human
  -> blocked
  -> wontfix
```

Agent flow transitions with reviewer:

```text
ready_for_agent
  -> implementing
  -> reviewing
  -> waiting_for_merge
  -> merging
  -> done
```

Agent flow transitions without reviewer:

```text
ready_for_agent
  -> implementing
  -> waiting_for_merge
  -> merging
  -> done
```

Failure and sync transitions:

```text
any execution status -> failed
any open status -> sync_conflict
failed -> ready_for_agent | blocked | ready_for_human | wontfix
```

`implementing`, `reviewing`, `waiting_for_merge`, and `merging` are execution statuses. Normal task editing should not set them directly. They are driven by Hub flow events or explicit recovery commands.

## Claiming Tasks

Hub must prevent concurrent flows from taking the same ready task.

When planner output selects a task:

1. Hub attempts to claim the task.
2. If claim succeeds, task status becomes `implementing`.
3. Claim metadata records `runId`, `batchId`, `branch`, and `claimedAt`.
4. Other flows skip active claims.
5. Recovery commands can release or repair stale claims.

There is no `claimed` or `reserved` task status. Claim is metadata.

## Flow Responsibilities

Planner:

- Reads the Beads ready queue, not arbitrary open tasks.
- Selects unblocked tasks for a flow batch.
- Emits batch planning events.
- Does not implement, review, merge, or close tasks.

Implementer:

- Receives a specific task id, title, and branch from orchestration.
- Works only on that task and branch.
- Produces commits.
- Does not close tasks.

Reviewer:

- Runs only when the flow includes a reviewer.
- Reviews the branch diff and commit log.
- May make review commits.
- Does not close tasks.

Merger:

- Works on merge/conflict resolution for controlled merge units.
- Does not own task board state.
- Does not close local Beads tasks in Hub flows.

TypeScript orchestration:

- Claims tasks.
- Creates flow batches.
- Writes run, batch, and task events.
- Advances task statuses.
- Runs verification gates.
- Closes local Beads tasks.
- Starts task sync.

## Merge Semantics

Hub flows must emit per-task merge events even if the UI presents an entire flow batch as `merging`.

Required event types include:

- `merge_started`
- `merge_succeeded`
- `merge_failed`
- `verification_started`
- `verification_passed`
- `verification_failed`
- `task_close_started`
- `task_closed`
- `task_close_failed`

V1 verification policy:

- Run verification after each task merge.
- A task reaches `done` only after merge success, verification pass, and local Beads close success.
- Verification failure stops batch merge by default.
- Unresolved merge conflict stops batch merge by default.
- Local task close failure stops batch merge by default.

Failure outcomes:

```text
current task -> failed
unprocessed eligible tasks -> waiting_for_merge
batch -> partial_failed
```

Recovery for `close_failed`:

1. Check whether the branch is already merged.
2. Run verification.
3. Retry local Beads close.
4. Mark `done` if close succeeds.
5. Do not repeat the merge.

## Comments

Beads supports task comments. Hub should use comments for durable human-readable summaries, not full logs.

AI triage comments must start with:

```md
> _This was generated by AI during triage._
```

Sandcastle run comments must start with:

```md
> _This was generated by Sandcastle during an agent run._
```

Run comments should include concise fields such as:

- Flow
- Run id
- Batch id
- Task status
- Branch
- Commits
- Artifacts
- Next action

Full logs, events, and artifacts live in the Hub run directory.

## CLI Surface

Hub task board v1 should expose:

```bash
sandcastle tasks list
sandcastle tasks show <id>
sandcastle tasks create
sandcastle tasks from-prd <prd-ref>
sandcastle tasks triage
sandcastle tasks sync
sandcastle tasks comment <id>
sandcastle tasks recover <id>
sandcastle project status
```

Command responsibilities:

- `tasks list`: show the task board grouped by status.
- `tasks show`: show Beads task details, comments, remote refs, run refs, and current status.
- `tasks create`: create a manual or feedback task.
- `tasks from-prd`: decompose a PRD into Beads tasks and dependencies.
- `tasks triage`: process inbox and needs-info tasks through the triage workflow.
- `tasks sync`: pull/push remote task source changes.
- `tasks comment`: append a Beads comment.
- `tasks recover`: repair failed or stale execution states and write a recovery comment.
- `project status`: show project summary, credentials, active runs, and task board counts.

## Open Questions

- Which exact Beads label/custom metadata format should store Hub task status?
- Should Hub use Beads GitHub sync directly, wrap it, or maintain its own sync adapter over Beads?
- How should multiple remote task sources map to one local Beads task?
- Should `tasks triage` apply labels directly, or always ask for maintainer confirmation first?
- What is the first Hub flow that should implement the per-task merge event model?
