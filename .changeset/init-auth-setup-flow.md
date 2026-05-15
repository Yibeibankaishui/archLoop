---
"@ai-hero/sandcastle": patch
---

Expand `sandcastle init` with an auth setup step after scaffold and before image build:

- Add auth requirement collection metadata for selected runtimes and backlog manager.
- Add interactive GitHub auth choices (use `GH_TOKEN` in `.sandcastle/.env`, run `gh auth login --insecure-storage` with `GH_CONFIG_DIR=.sandcastle/auth/gh`, or skip).
- Add interactive Codex auth choices (use `OPENAI_KEY`, run `codex login` with `CODEX_HOME=.sandcastle/auth/codex`, or skip).
- Add interactive Cursor auth choices centered on `CURSOR_API_KEY`, plus a skip option for deferred setup.
