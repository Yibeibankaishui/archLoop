---
"@ai-hero/sandcastle": patch
---

Add `sandcastle tasks create` and `sandcastle tasks comment <id>` for local Hub task management. New tasks now default to the Hub inbox with `needs-triage` labeling and origin metadata, `--category` is accepted as an alias for `--kind`, comments append through Beads without changing task status, and the README, bundled usage skill, and roadmap are updated to match.
