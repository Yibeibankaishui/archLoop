---
"@ai-hero/sandcastle": patch
---

Add Hub task selectors for task commands: `sandcastle tasks show`, `tasks comment`, and `tasks recover` now accept an exact Beads id, exact task title, or the 1-based number shown by `tasks list`. `tasks list` prints stable per-output numbers, and `tasks show` uses Beads 1.0.4-compatible detail commands instead of unsupported `bd show --include-comments --include-dependents` flags.
