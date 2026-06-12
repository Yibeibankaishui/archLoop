# GIT SAFETY (required)

Sandcastle may run many iterations from one long-lived `main.ts` process. `.sandcastle/` is **local agent orchestration** (from `sandcastle init`) — not application source and not for version control. The merge phase must not remove or stash those runtime files.

- Do **not** run `git stash push -u` (never stash untracked files — this can swallow local `.sandcastle/bootstrap.sh` and other init scaffold).
- If you must stash **tracked** application changes, use `git stash push -m "..."` **without** `-u`, then run **`git stash pop`** before you finish.
- Do not stash, delete, move, or `git add` `.sandcastle/` orchestration files (`bootstrap.sh`, `main.ts`, prompts, auth dirs).
- Prefer merging with a clean worktree on **tracked** application files only; leave local `.sandcastle/` on disk.

# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run {{PROJECT_PROFILE_VERIFY_GUIDANCE}} to verify everything works
4. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`{{CLOSE_TASK_COMMAND}}`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
