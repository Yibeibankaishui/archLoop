---
"@ai-hero/sandcastle": patch
---

Add the generic Project profile to `sandcastle init`. Init defaults to `generic`, accepts `--project-profile generic`, prompts for Project profile after workflow template selection in interactive mode, and scaffolds a user-editable no-op `.sandcastle/bootstrap.sh` without adding language-specific image layers or project env vars.
