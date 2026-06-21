# ISSUES

Here are the open issues in the repo:

<issues-json>

{{ISSUES_JSON}}

</issues-json>

The list above is the complete allowed ready queue for this planner run.

Each issue may include computed blocker fields from live backlog state:

- `blockersDeclared` — refs parsed from the issue body's `## Blocked by` section
- `blockersResolved` — each declared ref with live `state` and `title`
- `openBlockers` — declared refs whose live state is still open

**Primary source of truth for whether an issue is blocked:** `openBlockers`.
When `openBlockers` is empty (including `[]`), treat the issue as **unblocked**
even if the body still lists closed blockers in `## Blocked by`. Blockers outside
the ready queue still count when their live state is open.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

You may only choose issues from the provided `<issues-json>` list. Do not run
additional `gh issue list`, `bd list`, `bd ready`, or other backlog-listing
commands to discover more tasks. If `<issues-json>` is an empty array, output an
empty plan.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** when `openBlockers` is empty and it has zero other
blocking dependencies on open issues in the ready queue.

Do **not** assign branch names. The template derives each issue branch
deterministically as `sandcastle/issue-{id}` after planning.

Include every unblocked issue in your plan. Do **not** inspect git branches or
try to detect existing implementation work — the template handles that
deterministically. It checks the local issue branch before each implementer run
and, when that branch already has commits ahead of the base, skips fresh
implementation and goes straight to review and merge.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).
