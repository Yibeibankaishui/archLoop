---
"@ai-hero/sandcastle": patch
---

During `sandcastle init`, add `tsx` and `@ai-hero/sandcastle` to project `devDependencies` and scaffold a `sandcastle` npm script that uses the local `tsx` binary instead of `npm exec --package tsx`, so running the workflow does not require registry access after setup.
