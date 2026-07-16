---
"@yibeibankaishui/archloop": patch
---

Hub batch merge now attempts best-effort cleanup of a safe managed task branch after a task closes successfully. The cleanup step uses non-force `git branch -d`, records structured cleanup events for deleted/skipped/failed outcomes, and leaves the task in `done` when cleanup fails. Update the Hub merge lifecycle docs and bundled usage skill to match.
