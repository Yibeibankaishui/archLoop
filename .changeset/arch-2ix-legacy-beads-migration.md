---
"@yibeibankaishui/archloop": patch
---

Automatically migrate a writer-free repository-local Beads store into Hub-owned storage on the first mutating `archloop run` or task command. Migration uses a durable journal, quarantines the legacy database before copying, verifies identity and task graph, installs `.beads/redirect`, keeps a recoverable backup, and resumes after a crash without `tasks recover`.
