---
"@yibeibankaishui/archloop": patch
---

Respect Hub agent role config for task-board implementation and review runs. `archloop run . --flow no-review|with-review` now uses the configured `implementation` and `review` providers instead of always invoking Cursor.
