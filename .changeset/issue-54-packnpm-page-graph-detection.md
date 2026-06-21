---
"@yibeibankaishui/archloop": patch
---

Fix Mini Program `packNpm` auto-detection to walk declared `app.json` page and subpackage paths instead of assuming `pages/*/<dirname>.json` layouts.
