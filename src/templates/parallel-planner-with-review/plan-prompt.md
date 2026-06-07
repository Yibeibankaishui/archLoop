# ISSUES

Here are the open issues in the repo:

<issues-json>

!`{{LIST_TASKS_COMMAND}}`

</issues-json>

The list above has already been filtered to issues ready for work.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

For each unblocked issue, assign a branch name using the format `sandcastle/issue-{id}-{slug}`.

# EXISTING BRANCHES

Before scheduling an issue for fresh implementation, check whether a matching branch (`sandcastle/issue-{id}-*`) already exists with **unmerged commits** ahead of the current branch:

```bash
git rev-list <base>..refs/heads/<branch> --count
```

When that count is greater than zero, the issue branch already contains implementation work pending review or merge. **Do not treat it as needing fresh implementation.** Prefer scheduling issues that still need implementation commits. The template will still pick up branches with unmerged commits for review and merge even if you omit them from the plan.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42-fix-auth-bug"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).
