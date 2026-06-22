---
"@yibeibankaishui/archloop": patch
---

Add the generic Project profile to `archloop init`. Init defaults to `generic`, accepts `--project-profile generic`, prompts for Project profile after workflow template selection in interactive mode, and scaffolds a user-editable no-op `.archloop/bootstrap.sh` without adding language-specific image layers or project env vars.
