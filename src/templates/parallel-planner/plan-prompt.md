# ISSUES

Here are the open issues in the repo:

<issues-json>

{{ISSUES_JSON}}

</issues-json>

The list above is the complete allowed ready queue for this planner run.

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

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

For each unblocked issue, assign a branch name using the format `sandcastle/issue-{id}-{slug}`.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42-fix-auth-bug"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).
