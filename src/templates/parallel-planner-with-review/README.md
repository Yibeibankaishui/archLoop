# parallel-planner-with-review

Four-phase workflow for parallel issue execution with per-branch review.

## Lifecycle

Each issue moves through these phases:

1. **Plan** — The planner selects unblocked issues; the template assigns stable branch names (`archloop/issue-{id}`).
2. **Implement** — The implementer completes the work on the issue branch. The issue stays **open**.
3. **Review** — When the implementer produces commits, or the branch already has unmerged commits ahead of the base branch, a reviewer refines the branch.
4. **Merge & close** — The merger merges completed branches into the current branch, runs tests, and closes each issue **only after** its branch is merged successfully.

Only the **merge phase** closes issues. Implementers and reviewers must not close issues.

## Recovering from stalled work

Before each implementer run, the template checks the **local** issue branch. If that branch already has commits ahead of the base branch (for example after a reviewer transport failure left work unmerged), it skips the implementer and goes straight to review and merge. This check uses local refs only, so it never matches an unrelated same-numbered branch from another remote.

If the same issue makes no merge progress across multiple iterations, the template stops scheduling it and prints recovery steps (merge the branch manually, close the issue, or fix the merge gate).

The planner only performs dependency analysis; it does not inspect git branches. Branch state is handled deterministically in `main.mts`.

## Stale blocker hygiene

Before the planner runs, `main.mts` enriches each ready issue with computed
blocker fields (`blockersDeclared`, `blockersResolved`, `openBlockers`) by
parsing `## Blocked by` from the issue body and resolving live blocker state
via `gh issue view` (GitHub Issues) or `bd show` (Beads). The planner prompt
treats `openBlockers` as the source of truth, so downstream work is not skipped
when blocker issues are already closed but the body was not updated. A warning
is printed when all declared blockers are closed.
