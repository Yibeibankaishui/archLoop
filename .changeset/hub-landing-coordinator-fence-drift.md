---
"@yibeibankaishui/archloop": patch
---

Fence concurrent Hub landing coordinators with a nonce, process-start, and boot identity lease. Target drift invalidates the stale candidate, rebuilds on the new target, and fully reverifies before another CAS.
