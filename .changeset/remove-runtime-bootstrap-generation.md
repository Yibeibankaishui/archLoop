---
"@yibeibankaishui/archloop": patch
---

Remove runtime bootstrap generation from non-blank workflow templates. Init scaffolds `.archloop/bootstrap.sh` from the selected Project profile; templates only run it via `sandbox.onSandboxReady` and no longer scaffold `bootstrap-prompt.md` or agent-driven bootstrap repair.
