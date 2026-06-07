---
"@ai-hero/sandcastle": patch
---

Fix `parallel-planner-with-review` to run review and merge when an issue branch already has unmerged commits, even if the current implementer run produced zero new commits. Console output now distinguishes pending branch work from truly empty pipelines.
