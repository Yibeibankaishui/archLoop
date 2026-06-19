---
"@ai-hero/sandcastle": patch
---

The `parallel-planner-with-review` template no longer asks the planner LLM to
match `sandcastle/issue-{id}-*` branches. That guidance could pick up an
unrelated same-numbered branch from another remote (e.g. an upstream fork's
issue branch), making the planner drop the only unblocked issue and exit early.
Branch detection now happens deterministically in `main.mts` using local refs
only: before each implementer run the template checks whether the local issue
branch is already ahead of the base and, if so, skips fresh implementation and
goes straight to review and merge.
