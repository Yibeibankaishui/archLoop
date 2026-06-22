---
"@yibeibankaishui/archloop": patch
---

Resume same-flow merge-ready batches before planning or claiming new ready tasks. When `waiting_for_merge` work remains from a prior batch, `archloop run . --flow <task-board-flow>` runs the merge phase for that batch first, leaves concurrent `ready_for_agent` tasks unclaimed, and reports `resumed_batch` mode in CLI output.
