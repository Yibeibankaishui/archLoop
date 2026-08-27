---
"@yibeibankaishui/archloop": patch
---

Isolate CLI tests from the real Hub project registry and add `archloop project prune-test-fixtures` to safely recover previously leaked fixtures. Cleanup now recognizes the legacy Hub recovery-test path hashes, validates canonical non-symlink targets, and verifies complete project/run payload backups before deletion.
