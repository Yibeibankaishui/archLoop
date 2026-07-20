---
"@yibeibankaishui/archloop": patch
---

`archloop tasks pull` / `push` / `sync` success output now uses the Variant C `section` layout: header (`archLoop · sync · <project>`), `↓ pulled` / `↑ pushed` rows with dim zero-valued details, optional conflict group, and a `next` / `fix` footer instead of the legacy "Synced Hub tasks with GitHub Issues" / `Pulled:` / `Pushed:` lines.
