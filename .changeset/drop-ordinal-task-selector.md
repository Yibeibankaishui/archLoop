---
"@yibeibankaishui/archloop": patch
---

**Breaking:** `archloop tasks show`, `tasks comment`, `tasks recover`, and other task-selecting commands no longer accept a 1-based number from `tasks list` as a task selector. Pass a Beads id (e.g. `AutoTuneAgent-2mr`) or the exact task title instead. The **Hub task board view** in terminal mode also drops the leading ordinal column — the number was unstable across filters and reorderings, so a selector like `archloop tasks show 3` silently retargeted under `--warning` or `--status`. Use `archloop tasks list --json | jq '.[].id'` if you need machine-readable ids in scripts. See `docs/adr/0031-cli-task-selectors-drop-ordinal-input.md`.
