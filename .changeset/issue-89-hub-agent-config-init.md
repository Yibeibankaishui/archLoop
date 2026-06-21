---
"@yibeibankaishui/archloop": patch
---

Add interactive Hub agent role setup: `archloop agent-config init` (alias `configure`) walks all roles with apply-one-to-all support, and `set-role` prompts for provider/model in TTY when flags are omitted while failing clearly in non-interactive mode.
