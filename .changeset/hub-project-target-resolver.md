---
"@yibeibankaishui/archloop": patch
---

`archloop project status` and `archloop project configure` now resolve Hub project targets from an explicit `--project <name>` flag first, then the CLI selected Hub project, then a TTY project picker. They no longer infer the target from the current working directory. The bundled usage skill, README, user guide, and roadmap were updated to match the new behavior.
