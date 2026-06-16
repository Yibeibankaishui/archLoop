---
"@ai-hero/sandcastle": patch
---

Fix `tasks from-prd` and other proposal flows failing with `spawnSync git ENOBUFS` when repositories have large untracked trees (for example `node_modules` not in `.gitignore`).
