---
"@ai-hero/sandcastle": patch
---

Copy hook-referenced `.sandcastle/*.sh` scripts from the host repo into issue worktrees before sandbox hook preflight, so gitignored init scaffold such as `bootstrap.sh` works with `createSandbox()` without manual `copyToWorktree`.
