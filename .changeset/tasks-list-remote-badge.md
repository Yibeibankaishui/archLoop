---
"@yibeibankaishui/archloop": patch
---

`archloop tasks list` now shows a trailing remote badge on each row (`github#N` when synced, `local-only` when push-pending, `sync-conflict` when diverged). `--json` emits a row array including `remoteBadge` when present; `--plain` keeps the same tokens without color.
