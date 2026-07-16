---
"@yibeibankaishui/archloop": patch
---

Make `archloop run` project-centric with an interactive TTY wizard. The command now defaults to the selected Hub project, accepts `--project <name>` for explicit targeting, prompts for a project and flow when needed, prompts for required flow input before execution, and keeps `archloop run . --flow <id>` as temporary compatibility guidance for legacy path calls. Update the README, user guides, bundled usage skill, and roadmap to match.
