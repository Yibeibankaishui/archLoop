# TASK

Fix task {{TASK_ID}}: {{TASK_TITLE}}

Pull in the task using `{{VIEW_TASK_COMMAND}}`. If it has a parent PRD, pull that in too.

Only work on the task specified.

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
2. Include task completed + PRD reference when applicable
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# WORKFLOW LIFECYCLE

This Hub flow runs **implement → review → merge → close** for each task.

- **You are the implementer.** Commit your work and run tests, but **do not close the task.**
- The task stays **open** until the merge phase closes it after branches are merged into the base branch.
- If you cannot finish, leave a comment on the task describing what was done and what remains. Say it is **awaiting the merge phase** instead of waiting for human review.

# THE TASK

If the task is not complete, leave a comment on the task with what was done.

Do not close the task — only the merge phase closes tasks after branches are merged.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
