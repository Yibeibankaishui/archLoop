---
"@yibeibankaishui/archloop": patch
---

Codex sandbox images install the `@openai/codex` main package (npm selects the matching platform binary via optionalDependencies) and run `codex --version` during image build so a missing CLI or platform binary fails at build time instead of at agent runtime.
