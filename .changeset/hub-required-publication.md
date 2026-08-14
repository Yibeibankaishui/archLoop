---
"@yibeibankaishui/archloop": patch
---

Required remote publication: tasks stay `publishing` until remote ancestry proves delivery, FIFO successors cannot advance past an unacknowledged predecessor, force rewrite after ambiguous push is an integrity incident, and a delivery timeout returns `completed_with_pending_delivery` with a non-zero exit without semantic task failure.
