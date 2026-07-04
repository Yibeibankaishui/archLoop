---
"@yibeibankaishui/archloop": patch
---

Add `archloop initialize` as the idempotent Hub-wide setup entry point. It now preserves existing shared Hub agent roles and env values, surfaces Hub auth guidance, runs the quick Hub readiness check by default, supports `--skip-check`, and ends by pointing users to `archloop project add`.
