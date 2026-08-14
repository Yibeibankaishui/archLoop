---
"@yibeibankaishui/archloop": patch
---

After Hub landing, enqueue a durable checkout projection. Fast-forward the host branch only when Git can prove it safe; otherwise keep `checkout_sync_pending` without touching WIP or `shipped`.
