# CLI task references drop 1-based ordinal input

`archloop tasks show`, `archloop tasks comment`, `archloop tasks recover`, and other task-selecting
commands no longer accept a "1-based number from `tasks list`" as a task selector. Task selectors
are now **Beads id** (e.g. `AutoTuneAgent-2mr`) or **exact task title** only. The **Hub task board
view** stops displaying the ordinal column that produced those numbers.

## Decision

The `taskSelectorsArg` description in `src/cli.ts` changes from

> Beads id, exact task title, or 1-based number from tasks list.

to

> Beads id, or exact task title.

The **Hub task board view** in Variant C removes the leading `1. 2. 3. …` ordinal column from each
task line. `formatHubTaskBoardLines` (`src/taskBoard.ts`) stops computing `displayIndex`.

Run and flow batch identifiers displayed in the **Hub run card** are shortened to their leading 8
characters (e.g. `74cc88e3` for a full UUID `74cc88e3-6757-4472-b152-f5cf151be9d3`). CLI commands
that accept a run id also accept the 8-char prefix; ambiguous prefixes surface as
`error: run id "74cc88" matches 2 runs — pass the full id`. Beads task ids remain displayed at full
length (they are already short: `<Project>-<3chars>`).

## Consequences

- **Breaking change.** Users who wrote `archloop tasks show 3` in a script or alias get an error
  message pointing them at the Beads id form. A changeset is filed under `.changeset/` marking this
  as a patch (pre-1.0) so downstream users see it in release notes.
- The **Hub task board view** frees ~4 columns per row previously spent on the ordinal, which lets
  long task titles show more content before tail-truncation.
- Task selection becomes stable across filters and time — the old ordinal changed when
  `--status`, `--warning`, or the underlying task set changed, so `archloop tasks show 3` referred
  to a different task at different times. The new contract is only ambiguous if two tasks share the
  exact same title (Beads ids are unique by construction).
- Run and batch UUIDs are half-visible in logs and PR descriptions. The 8-char prefix is enough for
  a project-lifetime uniqueness margin (birthday-bound roughly `sqrt(2^32) ≈ 65k` runs before
  meaningful collision probability), and CLI ambiguity errors handle the edge case.
- Automated integrations (CI, external tooling) that produced task selectors from `tasks list`
  output should switch to consuming Beads ids directly — the `--json` output already emits them.

## Considered Options

1. **Keep the 1-based ordinal in both display and input** — rejected because the ordinal is unstable
   under filters and reorderings, and a task selector that silently retargets under `--warning` is
   worse than removing the feature.
2. **Remove display, keep input as deprecated** — rejected because it leaves the CLI contract and
   the visual output out of sync ("what number do I even type?"). A deprecation window costs more
   than the breaking change: users who never used ordinals see nothing change, and users who did
   would prefer a fast error over silent behavior change later.
3. **Short-id prefix matching for Beads ids too** (`archloop tasks show 2mr` matches
   `AutoTuneAgent-2mr` via prefix) — deferred. Beads ids are already short (`<Project>-<3chars>`),
   and prefix matching introduces an ambiguity-resolution surface (`error: 2m matches 2mr, 2mp, …`)
   that is not worth solving until users ask. `bd show <full-id>` remains the canonical form.
4. **Show full run UUIDs** — rejected because a 36-char UUID inflates every **Hub run card** row.
   The 8-char prefix is git's convention, and CLI accepts both forms so scripts that captured full
   UUIDs from `--json` continue to work.
