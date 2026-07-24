---
"@yibeibankaishui/archloop": patch
---

Render `archloop tasks doctor` output as severity-colored section blocks (a badges summary row plus one grouped block per severity) instead of flat colorless text. Diagnostics are grouped by severity — error (interrupted/failed work), warn (stale claims / pending sync), info (orphaned / informational cleanup) — reusing the repo's existing `severityColor` vocabulary; each group shows its severity symbol/color and count, and each item shows the task id, the reason, the recommended next action as a dim trailing hint, and the human message as a dim continuation line. Under `NO_COLOR` / non-TTY / `--plain`, the same blocks flatten to plain grep-friendly text (via `flattenSectionForLog`) that preserves every task id, reason, message, and next-action string. Detection logic (`doctorHubTaskState`) is unchanged — only the presentation layer moves onto the shared `SectionBlock` renderer the task board already uses.
