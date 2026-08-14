---
"@yibeibankaishui/archloop": patch
---

Adopt pre-transaction Hub landing history without false completion. Already closed tasks stay completed. Ancestry-proven in-flight branches enter a new verified transaction; a historical `merge_succeeded` event never proves delivery. Missing or diverged evidence is `legacy_landing_integrity`.
