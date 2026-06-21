---
"@yibeibankaishui/archloop": patch
---

Copy hook-referenced `.archloop/*.sh` scripts from the host repo into issue worktrees before sandbox hook preflight, so gitignored init scaffold such as `bootstrap.sh` works with `createSandbox()` without manual `copyToWorktree`.
