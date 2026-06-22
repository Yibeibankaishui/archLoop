---
"@yibeibankaishui/archloop": patch
---

Add the Node Project profile to `archloop init`. Scripted init accepts `--project-profile node`, interactive init lists Node after template selection, and init scaffolds a lockfile-aware `.archloop/bootstrap.sh` (pnpm, yarn, npm ci, or npm install) without extra Containerfile layers or default test/build steps.
