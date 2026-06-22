---
"@yibeibankaishui/archloop": patch
---

Fix `archloop tasks push` so it reads the complete Beads task board, including closed tasks beyond the default list page, closes each linked GitHub issue at most once, and avoids expensive per-task `bd show` reloads when updating sync state.
