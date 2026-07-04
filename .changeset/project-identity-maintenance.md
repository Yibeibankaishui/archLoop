---
"@yibeibankaishui/archloop": patch
---

Add `archloop project rename` and `archloop project relink` so Hub projects can change their user-facing name or repo path without changing the stable Hub project id. The registry now preserves selected-project state across identity edits, rejects duplicate names and duplicate paths with actionable guidance, and the README, bundled usage skill, and user guides were updated to describe the new commands.
