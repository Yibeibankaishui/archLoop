---
"@ai-hero/sandcastle": patch
---

Add typed Hub flow input schemas for proposal flows `prd-decomposition` (PRD file) and `triage` (task query defaulting to `inbox,needs_info`). `sandcastle run --flow --input` validates flow-specific input before execution, and task shortcuts map onto the same validation helpers.
