---
"@yibeibankaishui/archloop": patch
---

Resume unfinished Hub flow batches before starting no-op work. When a flow run has no ready tasks but finds a previous same-flow `waiting_for_merge` batch, archLoop resumes that old batch's merge selection by its original batch id and reports the resumed batch in CLI output. Runs with ready tasks keep the normal new-batch path and report unfinished old batch ids as not resumed.
