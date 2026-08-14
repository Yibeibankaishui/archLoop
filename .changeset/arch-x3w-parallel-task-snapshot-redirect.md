---
"@yibeibankaishui/archloop": patch
---

Stop rewriting the shared repository `.beads/redirect` when creating Hub task snapshots. Parallel Agents isolate through per-attempt `BEADS_DIR` empty stores, so the managed redirect stays intact and stale snapshot redirects no longer recommend `tasks init`.
