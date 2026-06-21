---
"@yibeibankaishui/archloop": patch
---

Add post-run mutation detection for proposal flows. archLoop snapshots repository and local task store state before and after proposal sessions, fails before apply when unexpected changes are detected, reports the changes in user-readable output, and does not automatically revert mutations.
