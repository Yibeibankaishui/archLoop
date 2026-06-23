---
"@yibeibankaishui/archloop": patch
---

Split Hub desktop renderer helpers off from runtime-only task-store, proposal,
and PRD modules so `hub-desktop` production builds no longer pull Node-only
code into the renderer. Add a `hub-desktop` build regression gate to the
desktop launch test.
