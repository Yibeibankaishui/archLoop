---
"@yibeibankaishui/archloop": patch
---

Render `archloop tasks cleanup` output as section blocks grouped into safe managed / blocked managed / unowned historical candidates, with severity coloring (success ✓ / warn ! / info ●). Dry-run preview and deleted managed/historical branch summaries stay visible; under `NO_COLOR` / non-TTY / `--plain`, the same blocks flatten to plain text that preserves every branch name, task id, and skip reason. Cleanup evaluation and deletion planning are unchanged — only the presentation layer moves onto the shared `SectionBlock` renderer.
