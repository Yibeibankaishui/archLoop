# Hub flows emit per-task merge events

**Sandcastle Hub** flows must make merge progress observable per task, even when the UI presents a whole **flow batch** as merging together. Existing scaffold templates can only infer merger outcomes after a black-box merger agent run, but Hub task board state requires per-task events such as merge started, merge succeeded, merge failed, and task closed.

## Considered Options

1. **Treat the merger as a black-box batch agent** -- rejected because Hub cannot reliably determine which tasks merged, failed, or were skipped.
2. **Require only structured merger output** -- useful, but still depends on the agent reporting every outcome correctly.
3. **Have Hub orchestration emit per-task merge events** -- chosen because TypeScript orchestration owns global state transitions while agents make local merge/conflict-resolution judgments.
