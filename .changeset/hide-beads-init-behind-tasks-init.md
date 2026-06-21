---
"@yibeibankaishui/archloop": patch
---

Hide Beads initialization behind archLoop task commands.

- Add `archloop tasks init` to initialize the local Hub task store via the bundled Beads runtime.
- Point uninitialized task-store failures and `archloop project status` guidance at `archloop tasks init` instead of raw `bd init`.
- Keep Beads as the internal task-store backend for existing task board commands.
