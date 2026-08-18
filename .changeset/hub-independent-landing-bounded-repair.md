---
"@yibeibankaishui/archloop": patch
---

Land each merge-ready Hub task in its own landing transaction. Bounded Agent repair isolates semantic conflicts and verification failures; independent siblings continue, dependents wait, and mixed batches report `partial_failed`.
