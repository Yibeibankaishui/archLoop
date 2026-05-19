---
"@ai-hero/sandcastle": patch
---

Add the Node Project profile to `sandcastle init`. Scripted init accepts `--project-profile node`, interactive init lists Node after template selection, and init scaffolds a lockfile-aware `.sandcastle/bootstrap.sh` (pnpm, yarn, npm ci, or npm install) without extra Containerfile layers or default test/build steps.
