# Terminal-mode `section` display primitive uses a fixed block set

archLoop's **terminal mode** renders the **Hub task board view**, the **Hub run card**, and all
other CLI screens through a single `section(title, blocks)` primitive on the `Display` service. The
block set is fixed at 8 kinds: `header`, `divider`, `badges`, `group`, `kv`, `prose`,
`indented-block`, and `footer`. Progress bars, sparklines, and general tables are intentionally
excluded from this primitive.

## Decision

The `Display` service gains one new primitive:

```ts
section(title: string, blocks: SectionBlock[]): Effect.Effect<void>
```

`SectionBlock` is a discriminated union of exactly these 8 tags:

- `header` — bold title + dim subtitle + right-aligned field. At most one per section.
- `divider` — dim horizontal rule at column width.
- `badges` — one line of `{symbol, count, label}` pills (`● 2 todo   ◐ 1 in_progress   ✓ 5 done`).
- `group` — group heading (`symbol · name · count`) followed by an indented list of items, each
  `{id, title, trailingDim?}`. The list is flat; a `group` item does not carry nested sub-items.
- `kv` — key/value block; keys share a fixed gutter width; values may wrap onto continuation lines
  aligned to the gutter.
- `prose` — free-flowing paragraph text; renderer only applies soft-wrapping, no reformatting.
- `indented-block` — deeply-indented composite block (leading glyph + main line + N dim sub-lines).
  Used for the currently active task inside a **Hub run card**. Modeled as a standalone block that
  visually follows a `group`, not as a nested `group` item.
- `footer` — one line with a dim label + one or more command hints (`tip   cmd1   ·   cmd2`).

All three existing `Display` implementations (`ClackDisplay`, `SilentDisplay`, `FileDisplay`) must
implement `section`. Screens invoke `section` with a model built at the caller site (e.g.
`buildHubTaskBoardModel(...)` in `taskBoard.ts`); the caller does not know which implementation is
active.

Screens do NOT use `clack.note` (with its `│` gutter) for board-like or card-like content. Existing
`clack.spinner`, `clack.select`, `clack.confirm`, and `clack.multiselect` remain in use for their
respective interactive primitives — `section` covers static rendering only.

## Consequences

- Adding a new screen means picking blocks from the fixed set — not inventing new block kinds.
  This is the point: the terminal look stays coherent because the vocabulary is small.
- Adding a 9th block kind is a decision that costs an update to every `Display` implementation and
  a bump to the visual coherence contract. It should be treated as an amendment to this ADR, not a
  drive-by change.
- Progress bars, sparklines, and tables are deliberately absent. If a future screen (e.g. run
  history with per-day activity) needs them, that is a signal to introduce a different rendering
  path (e.g. the `--style=dashboard` variant B), not to extend `section`.
- `SilentDisplay` records `section` as a single entry with the block array preserved verbatim, so
  tests can assert on model structure rather than rendered strings — this is the migration path
  away from `expect(stdout).toContain("Hub task board")`.
- `FileDisplay` (log-to-file mode) flattens each block to plain text with no color and no dividers;
  a `section` in a run log reads as a small titled paragraph. This preserves the log's grep-ability.

## Considered Options

1. **Add specialized `boardView()` and `runCard()` methods instead of a general `section`** —
   rejected because every new screen (`hub status`, `tasks conflicts`, `run history`, …) would need
   another specialized method and another round of updates to `SilentDisplay` / `FileDisplay`. The
   shared visual language of Variant C is exactly what `section` locks in.
2. **Include `progress`, `sparkline`, and `table` in the block set now, to prepare for a later
   dashboard variant (Variant B)** — rejected because the block set would then encode two different
   design languages at once. When Variant B is warranted, it should be a separate render path
   selected by a top-level style flag, not an extension of `section`.
3. **Model `indented-block` as a nested sub-item on `group`** — rejected because the type
   complexity does not match Variant C's aesthetic. Variant C treats "the current task shown in
   detail" as a distinct block that happens to sit under a batch list, not as an expandable list
   item. Nested items are reserved for a hypothetical future variant that needs them (e.g. Variant
   B's per-task sub-progress).
4. **Keep using `clack.note` and only tweak the strings** — rejected in the top-level Variant C
   selection: the left `│` gutter is the primary cause of the current CLI feeling crowded. `section`
   is the mechanism by which Variant C removes the gutter without abandoning `@clack/prompts` for
   interactive primitives.
