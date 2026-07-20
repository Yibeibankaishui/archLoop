---
"@yibeibankaishui/archloop": patch
---

`archloop tasks show <id>` now uses the Variant C typographic `section` layout: header (`archLoop · task · <id>` with status/owner), 12-char `kv` identity rows, `description` / `comments · N` prose sections, and a `next` footer (`archloop tasks update <id> ...`, plus `gh issue view <n>` when a `github#` remote ref is present).
