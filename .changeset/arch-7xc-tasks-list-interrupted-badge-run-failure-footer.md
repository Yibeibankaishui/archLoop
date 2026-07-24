---
"@yibeibankaishui/archloop": patch
---

Make interrupted-run execution visible at a glance and point failed runs at a real recovery command.

- `archloop tasks list` now badges tasks the shared interrupted-execution detector flags as stuck in `implementing` / `reviewing` / `merging` with no live worktree lease, rendering a trailing `⚠ interrupted` marker on the row so they are visible without running `tasks doctor`. The badge is additive to the `--json` output shape (a new `interrupted: true` field on flagged rows; omitted for healthy tasks so existing JSON consumers are unchanged). The lease load the detector needs is gated behind a cheap check: when no `.archloop/locks/` directory exists (the common healthy-board path), the badge is skipped entirely so `tasks list` incurs no extra cost.
- The failed-run `fix` footer no longer suggests `archloop run --resume <runId> --only-failed`, a flag that was never implemented and errored when run. It now points at a real next step chosen by the run's failure composition: `archloop tasks recover --stale` when a task genuinely failed, or `archloop run` when the run was interrupted (tasks left in an in-flight status with no `failed` task) so re-running resumes the interrupted work.
- Documentation (bundled `skills/archloop-usage/SKILL.md`, `README.md`, `readme_cn.md`, `user_guide.md`, `docs/roadmap.md`) now describes interruption visibility, `tasks recover --stale`, and the failed-run footer, kept mutually consistent.
