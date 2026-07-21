---
"@yibeibankaishui/archloop": patch
---

`archloop tasks pull` / `push` / `sync` now list each changed task under the ↓/↑ headers (`<id> <title> <github#N>`), with conflict reason continuation lines. `--json` includes the full `entries[]` array; global `--plain` keeps the same layout without color.
