---
"@yibeibankaishui/archloop": patch
---

Defer Hub Beads migration when an active writer, source fingerprint change, unsafe snapshot, or live migration owner is detected before quarantine, retry with durable backoff against the verified legacy store, copy only a quarantined cold database across filesystems, and stop automatic task-store writes on split brain instead of merging databases.
