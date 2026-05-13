---
"@ai-hero/sandcastle": patch
---

Expand `sandcastle init` with an auth setup step after scaffold and before image build:

- Add auth requirement collection metadata for selected runtimes and backlog manager.
- Add interactive GitHub auth choices (use `GH_TOKEN` in `.sandcastle/.env`, run `gh auth login` with `GH_CONFIG_DIR=.sandcastle/auth/gh`, or skip).
- Show manual auth guidance for Codex and Cursor in the same flow.
