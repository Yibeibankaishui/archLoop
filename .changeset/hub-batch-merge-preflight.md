---
"@ai-hero/sandcastle": patch
---

Harden Hub flow lifecycle and batch merge behavior: reruns with existing unmerged branch work now count as successful implementation, task status transitions clear stale projection metadata, failed tasks with unmerged branch work can recover to `waiting_for_merge`, and batch merge now reports selection/preflight skip reasons while blocking dirty source files or task branches that carry `.beads/` runtime/export files.
