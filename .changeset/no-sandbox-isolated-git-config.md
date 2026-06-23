---
"@yibeibankaishui/archloop": patch
---

Isolate no-sandbox git global config writes per sandbox handle. Parallel Hub flow agents no longer contend on the user's `~/.gitconfig.lock` when setup runs `git config --global` for safe.directory or git identity.
