---
"@ai-hero/sandcastle": patch
---

`sandcastle init` now creates or updates `package.json` with `@ai-hero/sandcastle` and `tsx` devDependencies, adds a `sandcastle` npm script, and runs `npm install` so the generated entrypoint resolves on first run.
