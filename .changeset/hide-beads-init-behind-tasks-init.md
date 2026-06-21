---
"@ai-hero/sandcastle": patch
---

Hide Beads initialization behind Sandcastle task commands.

- Add `sandcastle tasks init` to initialize the local Hub task store via the bundled Beads runtime.
- Point uninitialized task-store failures and `sandcastle project status` guidance at `sandcastle tasks init` instead of raw `bd init`.
- Keep Beads as the internal task-store backend for existing task board commands.
