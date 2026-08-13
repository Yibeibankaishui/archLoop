# Hub flows emit per-task merge events

> Amended by [ADR-0035](./0035-hub-landing-uses-durable-fenced-transactions.md). Per-task observability remains required, but events project durable OID-bearing landing checkpoints and are not recovery truth. The ambiguous `merge_succeeded` milestone is retired.

**archLoop Hub** flows must make merge progress observable per task, even when the UI presents a whole **flow batch** as merging together. Existing scaffold templates can only infer merger outcomes after a black-box merger agent run, but Hub task board state requires per-task milestones for candidate creation, verification, target landing, optional publication, and task closure.

## Considered Options

1. **Treat the merger as a black-box batch agent** -- rejected because Hub cannot reliably determine which tasks merged, failed, or were skipped.
2. **Require only structured merger output** -- useful, but still depends on the agent reporting every outcome correctly.
3. **Have Hub orchestration emit per-task merge events** -- chosen because TypeScript orchestration owns global state transitions while agents make local merge/conflict-resolution judgments.
