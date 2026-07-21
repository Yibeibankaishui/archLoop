---
status: superseded by ADR-0033
---

> **Superseded by [ADR-0033](./0033-hub-run-card-alt-screen-dashboard.md).** Real-world use showed
> that "append-only + reprint the whole card each transition" degenerated into the exact waterfall
> problem Variant C was meant to solve — the header and footer were reprinted for every state
> change, drowning the active state under stale copies of themselves. ADR-0033 replaces this
> decision with an alt-screen dashboard that shows a persistent done ledger above a live-updating
> active card, then dumps a plain-text summary to real scrollback on exit. The body below is
> preserved as historical context for the reversal.

---

# Hub run card uses append-only rendering with a single-line spinner heartbeat

The **Hub run card** in **terminal mode** renders as an append-only sequence of `section` snapshots
plus a single-line `clack.spinner` heartbeat pinned at the bottom of the current output. It does not
use alt-screen buffers, cursor-up escape sequences, or full multi-line in-place refresh.

## Decision

Each meaningful state transition during a Hub run — a batch entering `planning`, a task entering
`implementing`, a batch completing, the run completing — emits a new `section` describing the state
at that moment. Previously-appended sections stay on screen and eventually scroll into the
terminal's scrollback buffer, forming a durable timeline of the run.

Between state transitions a single-line `clack.spinner` sits at the bottom of the terminal with the
template:

```
◐ <task-id> · <phase> · <phase-elapsed> · run <run-short-id>
```

The spinner updates once per second — only that single line rewrites in place. When the current
state transitions to the next one, the spinner stops (leaving its final line visible in
scrollback), the new `section` is appended, and a new spinner starts for the next phase.

Completed batches, once superseded by a later batch, collapse to a single summary line in their
`section` (`✓ batch daca6200   1 task   done · 17:26`) rather than repeating their full multi-row
card layout on every subsequent state transition. Only the current batch renders its full body
(current task, phase, phase-elapsed, sub-tasks).

Log path (`logs   …/runs/run-<short-id>/   press o to open · l to tail`) appears in the section
footer, not in the spinner line.

## Consequences

- The terminal scrollback holds a complete, chronologically-ordered run history: every phase
  transition is visible by scrolling up, and the user can read the run without opening the run log
  file. This matches how `git`, `docker build`, and `pnpm install` behave.
- Total appended output grows roughly with `2 × (batch count) + (task count per batch)` sections —
  a 5-batch, 8-task run appends ~20 sections over its lifetime. Because completed batches collapse
  to one line, vertical footprint stays under ~50 rows.
- Elapsed time updates only every second, on the spinner line — not on the section snapshots. If a
  user scrolls up, timestamps in older sections are frozen at the state-transition moment, which is
  correct: they describe "when this phase started".
- Ctrl+C, tmux scrollback, `less`-style pagers, and disconnected SSH sessions all remain safe: no
  ANSI cursor movement outside the single spinner line means nothing can tear a multi-line render.
- Log-to-file mode (`FileDisplay`) receives the same sequence of `section` calls and writes them as
  paragraphs to the run log — the spinner is a no-op in that mode. Terminal mode and log-to-file
  mode share the same event ordering, only the presentation differs.
- Future dashboard-style rendering (Variant B) is NOT achieved by extending this. It requires a
  separate render path — likely a `--style=dashboard` flag that swaps in an alt-screen renderer.
  The `section` primitive itself does not need to grow to support progress bars, sparklines, or
  per-second full-card refresh.

## Considered Options

1. **Full in-place refresh using an alt-screen buffer** — rejected because Variant C's core
   trade-off is "low animation, append-only, contract-preserving with existing infrastructure".
   Alt-screen rendering conflicts with scrollback, breaks under disconnected SSH and tmux, and
   requires rewriting the entire live view path. That investment is warranted only when adopting
   Variant B (dashboard); it is out of scope for C.
2. **Pure append-only with no spinner** (a mildly-rearranged version of the current
   `hubRunLiveDisplay.ts` behavior) — rejected because the resulting UI has no visible heartbeat:
   during a 20-minute `implementing` phase, nothing on screen indicates the run is alive. Users
   would either open the run log or assume the process hung.
3. **Two render paths dispatched on `process.stdout.isTTY`** (full refresh in TTY, append-only
   elsewhere) — rejected as premature complexity: it doubles the code path count without evidence
   that the TTY-only fancy variant is worth the maintenance load. If Variant B is later adopted,
   the dispatch becomes `--style` rather than `isTTY`, which is a cleaner control surface.
4. **Full elapsed timer on the spinner line, including whole-run elapsed** (`elapsed 29:30`) —
   rejected because the run header section already carries `run 74cc88e3 · 29m30s` as of its last
   state transition, and the spinner's purpose is to signal "the current phase is still working".
   Phase-elapsed answers that question directly; whole-run elapsed is a nice-to-have available in
   the most recent section header.
