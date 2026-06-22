# CANDIDATES

Here are the current ready_for_agent candidates for this Hub flow batch:

<candidates-json>

{{CANDIDATES_JSON}}

</candidates-json>

The list above is the complete allowed candidate pool for this planner run.

Each candidate may include blocker fields:

- `explicitBlockers` — structured Beads dependency edges when available
- `blockersDeclared` — refs parsed from the task description `## Blocked by` section when structured edges are unavailable
- `blockerSource` — `beads_dependency`, `description`, or `none`

**Primary source of truth for explicit blockers:** `explicitBlockers` when
`blockerSource` is `beads_dependency`. Otherwise use `blockersDeclared`.

# TASK

Select a safe parallel subset of candidates for the next Hub flow batch.

You may only choose task ids from the provided `<candidates-json>` list. Do not
run `bd ready`, `bd list`, `gh issue list`, git commands, or any other command to
discover more tasks.

Do **not** inspect git branches, assign branch names, or reason about existing
implementation branches. archLoop Hub owns branch naming, claiming,
implementation, review, merge, verification, close, recovery, and task state
transitions.

Defer tasks that should not run in parallel with your selected set because of:

- explicit blockers on other ready candidates or selected tasks
- API shape or infrastructure dependencies on another selected task
- overlapping core module ownership with another selected task
- docs/QA work that depends on behavior another selected task will establish
- design decisions another selected task must land first
- batch size limits (`maxTasks` is {{MAX_TASKS}})
- lower priority relative to safer parallel work

Do not write dependency edges to the local task store. Your deferrals apply only
to this batch selection.

# OUTPUT

Output your plan as JSON wrapped in `<batch-plan>` tags:

<batch-plan>
{
  "selectedTaskIds": ["bd-1"],
  "deferred": [
    { "taskId": "bd-2", "reason": "explicit_blocker" }
  ],
  "rationale": "Short human-readable explanation."
}
</batch-plan>

Use only these deferred `reason` values:

- `explicit_blocker`
- `selected_api_shape_dependency`
- `same_core_module`
- `docs_or_qa_for_selected_behavior`
- `design_decision_dependency`
- `over_max_tasks`
- `lower_priority`

Select at most {{MAX_TASKS}} task ids. If every candidate is unsafe to parallelize,
select the single safest eligible candidate.
