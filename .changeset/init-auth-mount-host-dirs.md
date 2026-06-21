---
"@yibeibankaishui/archloop": patch
---

Create scaffold auth host directories under `.archloop/auth/*` during `archloop init`, and auto-create any missing scaffold auth mount host paths when Docker/Podman providers resolve mounts (e.g. after clone or before login).
