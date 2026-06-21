---
"@yibeibankaishui/archloop": patch
---

Generalize non-blank init templates around a repository-specific bootstrap contract:

- Add a pre-loop bootstrap phase to `simple-loop`, `sequential-reviewer`, `parallel-planner`, and `parallel-planner-with-review`.
- When `.archloop/bootstrap.sh` is missing, templates now run a dedicated `bootstrap-prompt.md` to generate it, then validate it in a sandbox before task processing starts.
- Replace template defaults that assumed Node (`copyToWorktree: ["node_modules"]` and `npm install`) with `sandbox.onSandboxReady` executing `bash .archloop/bootstrap.sh`.
- Keep `blank` as a minimal scaffold while documenting `.archloop/bootstrap.sh` as the bootstrap convention.
