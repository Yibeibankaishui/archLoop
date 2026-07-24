---
"@yibeibankaishui/archloop": patch
---

Fix the Hub flow implementer marking an already-merged task as `agent_failed` on a zero-new-commit re-run. When the agent emits a completion signal but produces no new branch work because the task's implementation was previously merged into the base branch (a prior `merge_succeeded` / `task_closed` run event), the run now records success and closes the task as `done` instead of `task_implementation_failed`. The prior-merge event is the only signal that distinguishes this faithful re-run from a genuine no-work failure, so the completion signal alone is not trusted and the #221/#57 empty-loop guard is preserved.
