---
"@yibeibankaishui/archloop": patch
---

Expose `--idle-timeout` on `archloop run` and skip agent idle detection while an agent-spawned child process is still running, so long verification commands like `npm test` are not killed as idle.
