---
"@yibeibankaishui/archloop": patch
---

CLI visual overhaul (Variant C): Hub task board, task detail, sync result, and interactive run plan screens use the shared `section` primitive (no `clack.note` gutter). Status badges, directional ↓/↑ sync rows, append-only Hub run card + spinner heartbeat, and a 3s debounced run start are documented in README / skill / user guide. Pass `--plain` or `NO_COLOR=1` to strip styling while keeping symbols; `FORCE_COLOR=1` forces color. (Ordinal task-selector removal remains in `drop-ordinal-task-selector.md`.)
