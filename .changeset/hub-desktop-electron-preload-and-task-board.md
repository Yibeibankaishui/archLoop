---
"@yibeibankaishui/archloop": patch
---

Fix the Hub desktop Electron production launch path by loading relative Vite assets
and using a CommonJS preload script for the sandboxed renderer bridge. Also tighten
the Task Board desktop toolbar/actions layout so the Kanban board remains the
primary first-viewport surface.
