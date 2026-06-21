---
"@yibeibankaishui/archloop": patch
---

Improve `archloop init` for no-sandbox scaffolds.

- Generate `main.mts` / `main.ts` with `noSandbox()` when init selects the `no-sandbox` provider.
- Validate that `bd` is available on the host before allowing the `no-sandbox + beads` combination, and explain why that host dependency is required.
