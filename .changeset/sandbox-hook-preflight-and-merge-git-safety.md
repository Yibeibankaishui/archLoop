---
"@ai-hero/sandcastle": patch
---

Validate local `.sandcastle/*.sh` sandbox hook scripts exist before `onSandboxReady` runs, with actionable errors when init-scaffold files such as `bootstrap.sh` are missing from the worktree (without suggesting git commit). Add merge-prompt git safety rules forbidding `git stash push -u` so long-lived orchestration loops do not lose local `.sandcastle/` orchestration files.
