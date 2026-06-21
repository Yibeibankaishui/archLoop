# parallel-planner-with-review

Four-phase workflow for parallel issue execution with per-branch review.

## Lifecycle

Each issue moves through these phases:

1. **Plan** — The planner selects unblocked issues and assigns branch names (`archloop/issue-{id}-{slug}`).
2. **Implement** — The implementer completes the work on the issue branch. The issue stays **open**.
3. **Review** — When the implementer produces commits, or the branch already has unmerged commits ahead of the base branch, a reviewer refines the branch.
4. **Merge & close** — The merger merges completed branches into the current branch, runs tests, and closes each issue **only after** its branch is merged successfully.

Only the **merge phase** closes issues. Implementers and reviewers must not close issues.

## Recovering from stalled work

If an issue branch already has commits ahead of the base branch but the latest implementer run made no new commits (for example after a reviewer transport failure), the template still schedules review and merge for that branch.

If the same issue completes with zero new commits across multiple iterations, the template stops scheduling it and prints recovery steps (merge the branch manually, close the issue, or fix the merge gate).
