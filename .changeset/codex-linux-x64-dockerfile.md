---
"@ai-hero/sandcastle": patch
---

Codex sandbox images now install `@openai/codex-linux-x64` explicitly and run `codex --version` during image build so a missing platform binary fails at build time instead of at agent runtime.
