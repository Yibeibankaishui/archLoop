---
"@yibeibankaishui/archloop": patch
---

Resume recovered `reviewing` tasks in the with-review flow without re-implementing.

When a with-review run is interrupted after `task_implementation_succeeded` leaves a task in `reviewing`, re-running the same flow now treats that claimed batch as unfinished: it resumes the reviewer on the preserved branch, advances successful review to `waiting_for_merge`, and continues through merge. Idempotent `reviewing -> reviewing` recoveries no longer append no-op recovery comments, and a live worktree lease still blocks takeover of an active review.
