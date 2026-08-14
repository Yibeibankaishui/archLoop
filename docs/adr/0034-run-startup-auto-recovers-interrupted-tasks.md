# Run startup auto-recovers interrupted tasks

> Amended by [ADR-0035](./0035-hub-landing-uses-durable-fenced-transactions.md). Implementation/review interruption routing remains applicable, but managed candidate, landing, publication, close, checkout, cleanup, and task-store migration work is resumed by durable transaction reconcilers and must not be routed through routine `tasks recover`.

When an `archloop run` is terminated mid-execution, tasks can be left stuck in `implementing`/`reviewing`/`merging` with no live worktree lease and no signal anywhere the user looks — `tasks list`, `tasks show`, `project status`, even `tasks doctor` are silent for the released-lease case. We decided that `archloop run` startup will detect such interrupted tasks, run an event-aware recovery route on them automatically, and then resume their remaining phase (`waiting_for_merge` → `resumed_batch` merge; `reviewing` after `task_implementation_succeeded` → reviewer-only resume then merge; `ready_for_agent` → implement with preserved worktree). This is a deliberate deviation from ADR-0007's "explicit recovery action, not the default" principle: we judged that leaving users blind after an interruption, requiring them to remember and type `archloop tasks recover <id>` per task, was the worse outcome. The recovery route is event-aware (consults `task_implementation_succeeded` / `task_review_succeeded` in the run event log) and idempotent, so auto-applying it does not discard preserved work — the property ADR-0007 was protecting.

## Considered Options

- **Auto-recover on run startup (chosen).** One `archloop run` detects, recovers, and resumes. Violates ADR-0007's explicit-recovery default but closes the visibility gap at the moment the user is most likely to act.
- **Detect + prompt, recover only on confirmation.** Preserves the explicit-recovery principle; rejected because every recovery branch is already deterministic (no human judgment needed after the event-aware routing decision), so the prompt is pure friction.
- **Detect + hint only, require explicit `tasks recover`.** Most faithful to ADR-0007; rejected because it leaves the gap that motivated this work — the user still has to know to run a separate command per task.

## Consequences

- `archloop run` now mutates task board state on startup when interrupted tasks are present. The run output must state how many tasks were auto-recovered so the change is auditable.
- `tasks doctor`'s `interrupted_execution` diagnostic and `tasks recover --stale` remain as read-only and explicit-recovery surfaces for users who inspect or clean up without re-running.
- `recoverStaleExecutionStatus` must be event-aware before this is safe; a blind reset would re-implement tasks whose implement/review already completed (the footgun this ADR's auto-apply path would otherwise amplify).
