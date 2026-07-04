---
"@yibeibankaishui/archloop": patch
---

Add `archloop tasks cleanup` for Hub-managed branches. The command now defaults to safe preview mode, confirms deletion of safe managed branches, and requires `--include-unowned` before touching historical unowned `archloop/...` candidates. Update the Hub task-board docs, bundled usage skill, and roadmap to match the new cleanup flow.
