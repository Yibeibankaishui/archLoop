---
"@yibeibankaishui/archloop": patch
---

Fresh-validate Hub batch selections before claims. Task-board flows reload the ready queue after batch planning, reject stale or invalid selected task ids, fall back to conservative selection when needed, and record fallback reasons in Hub batch events and flow output.
