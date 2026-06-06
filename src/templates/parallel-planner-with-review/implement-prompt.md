# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `{{VIEW_TASK_COMMAND}}`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, run `npm run typecheck` and `npm run test` to ensure the tests pass.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# WORKFLOW LIFECYCLE

This template runs **implement → review → merge → close** for each issue.

- **You are the implementer.** Commit your work and run tests, but **do not close the issue**.
- The issue stays **open** until the **merge phase** closes it after branches are merged into the base branch.
- If you cannot finish, leave a comment on the issue describing what was done and what remains. Do **not** say the issue is waiting for "human review" unless this project explicitly defines a human gate — say it is **awaiting the merge phase** instead.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue — only the merge phase closes issues after branches are merged.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
