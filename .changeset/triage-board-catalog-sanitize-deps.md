---
"@yibeibankaishui/archloop": patch
---

Triage prepared context now includes the live Hub board task catalog so agents use real Beads ids from `bd list` instead of stale `.beads/issues.jsonl` ghosts. Unknown dependency suggestions are sanitized and skipped with a recorded reason instead of failing the entire triage after approval.
