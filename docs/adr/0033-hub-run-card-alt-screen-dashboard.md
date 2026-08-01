# Hub run card is an alt-screen dashboard with a persistent done ledger

The **Hub run card** in **terminal mode** enters an alt-screen buffer for the duration of a Hub run
and renders a four-region dashboard: a fixed header (project · flow · run short id · outcome ·
elapsed), a scrolling done ledger, a live-updating active card, and a fixed footer with the run
log path and hotkeys. Completed batches and tasks remain visible in the ledger; active batches and
tasks redraw in place at a fixed cadence. On exit — user pressed `q`, SIGINT, or run completed —
the CLI leaves the alt-screen buffer and dumps a plain-text summary (header + full ledger + logs
path) into the real terminal scrollback so the user has a durable record of what shipped.

## Decision

`archloop run` enters the alt-screen buffer (`\e[?1049h`) and hides the cursor (`\e[?25l`) at the
start of a run. It repaints the whole four-region dashboard at a 500 ms cadence — that is fast
enough for phase-elapsed timers to tick smoothly, slow enough to keep CPU trivial and terminal
flicker imperceptible.

The four regions, top-to-bottom:

1. **Header** — fixed, one line. `archLoop · <project> · <flow>` on the left; `run <short-id> ·
<outcome> · <elapsed>` right-aligned. Outcome is `running` (bold) while active, `✓ done` (green)
   or `✗ failed` (red) at end.
2. **Done ledger** — append-only, one row per completed task or completed batch, oldest at top,
   newest at bottom. Each row is `<sym> <id>  <title>  <duration>` with the outcome symbol
   (`✓`/`✗`) colored by severity. When the ledger plus the other regions would exceed terminal
   height, the ledger drops rows from the **top** (oldest done items scroll off) and inserts a dim
   `… N earlier shipped, see run log` sentinel at the top of the visible window. Header, active
   card, and footer are always fully visible.
3. **Live active card** — everything currently running: one row per active batch (with a
   right-aligned breakdown like `2 impl · 1 merging`), followed by one indented block per active
   task (id · title · current phase · phase-elapsed). Redrawn on every frame; text mutates in place
   so eyes track a single stable region.
4. **Footer** — fixed, one line. `logs   …/runs/run-<short-id>/` on the left; `press o open · l
tail · q quit` on the right.

Task/batch completion appends an entry to the ledger in the same frame the state transition is
detected; nothing goes to stdout via `console.log` or `Display.section` for the duration of the
run — every render passes through the alt-screen paint path.

**Exit handling** is the load-bearing piece. On any of the three exit paths — `q` keypress, SIGINT
/ SIGTERM, or natural run completion (a 2-second grace shows the final `✓ done` frame first) — the
CLI:

1. Clears the ticker.
2. Restores stdin from raw mode.
3. Shows the cursor (`\e[?25h`) and leaves the alt-screen (`\e[?1049l`).
4. Writes a plain-text summary — header, `completed · N done` line, every ledger row, logs path —
   to the real (non-alt) terminal, so it lands in real scrollback.

The result: while `archloop run` is live, the user sees only the current run's state; after it
exits, terminal history reads like every other CLI — the last thing on screen is a static summary
of what happened, no residue from the alt-screen buffer.

Non-TTY / `--yes` / `--plain` / `NO_COLOR=1` / `--stream` (new flag) all disable the alt-screen
path and fall back to the pre-ADR-0033 append-only projection: each state transition emits one
line via `Display.section`, no cursor movement, no alt-screen, safe to pipe to `grep`/`less`. CI
logs and scripts thus continue to receive a linear projection of the same run events; the
dashboard is a TTY-only affordance.

## Consequences

- The primary complaint that killed ADR-0032 — reprinting the header and footer on every state
  transition, drowning the run under stale copies of itself — is structurally impossible under
  this decision. The header and footer are drawn as part of a single frame paint; they can never
  duplicate.
- Terminal scrollback is clean for the duration of the run (alt-screen buffer isolates it), and
  the plain-text summary dumped on exit gives users a scrollback-durable record of what shipped
  without opening the run log file. This closes the "where did my tasks go?" gap that would have
  existed if completed items had simply disappeared from screen.
- Alt-screen buffers break under three scenarios the CLI must handle explicitly: terminals that
  don't support `\e[?1049h` (very rare in practice; graceful fallback: the escape becomes visible
  garbage — mitigate by feature-detecting `TERM` and falling back to `--stream` output), tmux
  copy-mode / scroll-lock during the run (`q` still works because stdin raw mode is intact; scroll
  attempts inside the alt-screen just move within the current frame), and hard disconnects (SIGHUP)
  where the shell never gets the leave sequence — mitigate by installing an `exit` handler that
  writes `\e[?25h\e[?1049l` unconditionally.
- The done ledger is bounded by terminal height, not by run length. Long-running runs with many
  merged tasks show a windowed view and rely on the run log file for the full record; the on-exit
  summary is also bounded to the visible window at exit time (documented behavior).
- `Display.section` is retained for the four screens migrated in Phase 2 (`tasks list`, `tasks
pull`, `tasks show`, and the `archloop run` pre-start plan). Only `hubRunLiveDisplay` diverges to
  the alt-screen path. ADR-0030 (the `section` block set) remains in force for those four screens.
- The debounced-start footer hint (ADR-0032's "3 second countdown before starting the run",
  reaffirmed by the Q8 decision in the grill) still fires **before** the alt-screen is entered:
  the run plan is a `section` in the real terminal, the countdown ticks in the real terminal, and
  only when the run actually starts does the CLI transition into alt-screen.
- Exit-time summary output uses only `bold` + `dim` + severity colors — same palette as the
  dashboard — so it reads consistently whether the user sees it live or in scrollback.

## Considered Options

1. **Keep ADR-0032's append-only + spinner heartbeat, but stop reprinting the header/footer on
   every transition (Mode B in the compare prototype)** — rejected. It fixes the immediate
   waterfall complaint at low cost, but leaves the on-screen model inherently linear: the user
   cannot see all active batches and tasks at once, only the most recent event. The user's
   revised requirement — "the terminal always shows the latest state of all active work" — is not
   reachable from an append-only model.
2. **Hybrid: cursor-up over an "active region" in the real terminal, completed items append below
   (Mode C in the compare prototype)** — rejected. The cursor-up path in the real terminal tears
   under tmux copy-mode, terminal scroll during the run, and any concurrent stderr write; it is
   the same class of fragility ADR-0032 originally wanted to avoid. Alt-screen isolates the
   dashboard from all of these.
3. **Full alt-screen with no scrollback residue on exit** (the original Q7 answer under the "log
   file only" branch) — rejected after the user pushed back that completed items must remain
   visible to the user after the run ends. The exit-time scrollback dump is what closes that gap
   without abandoning the alt-screen dashboard during the run.
4. **Do nothing; keep ADR-0032 as shipped and accept the reprinting behavior** — rejected. The
   shipped Phase 3a implementation is the direct cause of this reversal; every additional day it
   stays makes the migration story harder.

## Follow-ups

- ADR-0032 marked superseded with a pointer to this ADR.
- CONTEXT.md's **Hub run card** definition rewritten to describe the four-region dashboard rather
  than the append-only sequence of `section` snapshots.
- Issue #215 (which shipped the ADR-0032 implementation) is closed as superseded; a replacement
  issue tracks the alt-screen dashboard rewrite of `hubRunLiveDisplay`.
- Issue #217 (Phase 4 cleanup + docs) is amended: the bundled skill and READMEs need screenshots
  and copy for the dashboard, not the append-only card.
