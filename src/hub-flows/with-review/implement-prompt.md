# TASK

Fix task {{TASK_ID}}: {{TASK_TITLE}}

The selected task context is provided below as an immutable Hub task snapshot.
Do not query the live Beads store (`bd show`, `bd list`, `bd ready`) and do not
write Beads state (`bd update`, `bd comments`, `bd close`, `bd dolt`). Hub
applies structured notes after this attempt.

{{TASK_SNAPSHOT}}

Only work on the task specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# PROJECT DEVELOPMENT CONTRACT

Hub project profile: {{PROJECT_PROFILE}}
Hub project development contract: {{PROJECT_DEVELOPMENT_CONTRACT_PATH}}

## Setup guidance

{{PROJECT_DEVELOPMENT_CONTRACT_SETUP}}

## Verification guidance

{{PROJECT_DEVELOPMENT_CONTRACT_VERIFY}}

## Project context

{{PROJECT_DEVELOPMENT_CONTRACT_CONTEXT}}

{{RETRY_CONTEXT}}

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

Before committing, run the verification guidance from the project development contract.

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

- **You are the implementer.** Your job ends at **committing to the task branch** and running tests. **Do not close the task.**
- Do **not** `git push` to any remote. Do **not** run `bd dolt push` or `bd dolt commit`. Do **not** sync Beads. Hub handles merge and remote sync later.
- The task stays **open** until the merge phase closes it after branches are merged into the base branch.
- If you cannot finish, emit structured task notes describing what was done and what remains. Say it is **awaiting the merge phase** instead of waiting for human review.

# THE TASK

If the task is not complete, emit structured task notes with what was done.

Do not close the task — only the merge phase closes tasks after branches are merged.

To record a comment on this task, emit:

<task-notes>
{"schemaVersion":1,"taskId":"{{TASK_ID}}","comments":["what was done"]}
</task-notes>

Invalid or oversized notes are rejected and are not applied. Do not comment via `bd`.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.

Do not `git push`, do not run `bd dolt push` / `bd dolt commit`, and do not sync Beads — stop after the local commit on the task branch.
