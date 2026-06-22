---
"@yibeibankaishui/archloop": patch
---

During `archloop init`, add `tsx` and `@yibeibankaishui/archloop` to project `devDependencies` and scaffold a `archloop` npm script that uses the local `tsx` binary instead of `npm exec --package tsx`, so running the workflow does not require registry access after setup.
