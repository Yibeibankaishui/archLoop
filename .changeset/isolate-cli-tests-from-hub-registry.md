---
"@yibeibankaishui/archloop": patch
---

Isolate CLI tests from the real Hub project registry and add `archloop project prune-test-fixtures` to diagnose and recover previously leaked `cli-host-*` / `cli-resolve-*` fixtures.
