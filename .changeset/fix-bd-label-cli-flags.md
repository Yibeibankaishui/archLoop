---
"@yibeibankaishui/archloop": patch
---

Fix Hub Beads task board commands to use `bd` CLI flags compatible with bundled `@beads/bd@1.0.4`: `--add-label` / `--remove-label` instead of `--add-labels` / `--remove-labels`, and `--metadata` (JSON) instead of `--set-metadata` for full metadata updates on `bd update`.
