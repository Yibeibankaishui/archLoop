---
"@yibeibankaishui/archloop": patch
---

Render `archloop tasks repair-state` output as section blocks grouped by target Hub status, with board-bucket severity coloring (Planned vs Applied heading). Under `NO_COLOR` / non-TTY / `--plain`, the same blocks flatten to plain text that preserves every task id, reason, target status, and branch; the “Re-run with --yes” guidance remains when repairs are planned but not applied. Repair logic (`repairHubTaskState`) is unchanged — only the presentation layer moves onto the shared `SectionBlock` renderer.
