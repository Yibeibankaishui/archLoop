---
"@yibeibankaishui/archloop": patch
---

Refine `archloop project configure` so same-profile reruns preserve user-edited `setup`, `verify`, and `context` sections while refreshing advisory project facts, and profile changes write a timestamped backup of the previous development contract before replacing it. The CLI output now reports refreshed facts, preserved edits, and any backup path.
