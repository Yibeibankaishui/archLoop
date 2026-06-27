---
"@yibeibankaishui/archloop": patch
---

`archloop run . --flow no-review|with-review` now loads the Hub project development contract before invoking task-board implementers, injects contract-derived setup/verification/context guidance into the bundled implementer prompts, and creates a generic fallback contract when none exists so the flow can continue with a clear `archloop project configure --project-profile <profile>` hint.
