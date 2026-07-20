---
"@yibeibankaishui/archloop": patch
---

Fix `archloop tasks init` no-oping on an orphaned `.beads/metadata.json` whose underlying Dolt database was deleted. `tasks init` now treats the store as initialized only when both `metadata.json` and the embedded Dolt database directory exist, so a stale marker triggers a genuine `bd init` rebuild instead of returning "already initialized" while every task command fails with "no beads database found". `tasks list`/`pull`/etc. failing under the same condition now also report the archloop-owned "requires a local task store" guidance instead of leaking the raw bd error.
