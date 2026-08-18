---
"@yibeibankaishui/archloop": patch
---

Strip only an explicit allowlist of legacy Beads runtime/export files from Hub landing candidates so polluted task branches can ship their source changes. Filtered paths are recorded on the transaction and events; the task branch, checkout, and unknown `.beads/**` files are left untouched.
