# Hub GUI v0 QA Rerun 5 - 2026-06-24

QA source:

- [`docs/qa/hub-gui-v0.md`](../hub-gui-v0.md)
- [`docs/qa/hub-gui-v0-contract.md`](../hub-gui-v0-contract.md)
- Stitch export under `.stitch/projects/3406577108429917875/`
- Prior blocking issue: [#171](https://github.com/Yibeibankaishui/archLoop/issues/171)

Branch: `gui-v0`

Environment:

- macOS 14.4.1 `23E224`
- Node `v20.20.2`
- npm `10.8.2`
- Browser QA path: `hub-desktop/npm run dev:renderer-fixtures`

## Summary

Result: **Fail**

The latest fixes close the biggest Run Workbench and Proposal Session regressions from rerun 4. Run Workbench now shows the desktop action controls and terminal output in the 1600px first viewport, and Proposal Session now keeps the decision bar visible at the bottom of the first viewport. Runtime preview-confirm interactions also still work.

The remaining blocker is Task Board visual contract fidelity. The first viewport is still dominated by large Create Task and Run Triage panels before the Kanban surface, and the rightmost board column is partially clipped by default. This does not yet match the Stitch Task Board reference, where the board is the primary first-viewport surface and create/triage are compact toolbar actions.

## Automated Gates

| Gate                                          | Result  | Notes                                                                                   |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `npm run typecheck`                           | Pass    | root typecheck exited 0                                                                 |
| `npm run build`                               | Pass    | root build and postbuild exited 0                                                       |
| `hub-desktop/npm run typecheck`               | Pass    | renderer and Electron TypeScript checks passed                                          |
| `hub-desktop/npm run build`                   | Pass    | Vite renderer build and Electron build passed                                           |
| `hub-desktop/npm run build:renderer-fixtures` | Pass    | fixture renderer build passed                                                           |
| Targeted Hub GUI Vitest set                   | Pass    | 8 files, 76 tests passed                                                                |
| Renderer fixture browser smoke                | Pass    | four screens reachable through Playwright                                               |
| Real Electron smoke                           | Blocked | not rerun; this host has the known LaunchServices/AppKit limitation recorded in rerun 3 |

Browser console note: only `favicon.ico` returned 404; no React/runtime bridge error appeared.

## Evidence

Captured screenshots:

- `output/playwright/archloop-gui-rerun5-overview-1600.png`
- `output/playwright/archloop-gui-rerun5-task-board-1600.png`
- `output/playwright/archloop-gui-rerun5-task-board-selected-1600.png`
- `output/playwright/archloop-gui-rerun5-run-workbench-1600.png`
- `output/playwright/archloop-gui-rerun5-run-workbench-jsonl-1600.png`
- `output/playwright/archloop-gui-rerun5-run-workbench-960-top.png`
- `output/playwright/archloop-gui-rerun5-proposal-session-1600-top.png`
- `output/playwright/archloop-gui-rerun5-proposal-session-preview-1600.png`

Playwright verified:

- Page title: `archLoop Hub`.
- Overview `SYNC NOW` opens `Sync preview` and enables `Confirm`.
- Task Board keeps `arch-2` selected and updates the inspector to `Recover stale claim` with run directory metadata.
- Run Workbench switches from `Terminal Output` to `JSONL Stream`.
- Proposal Session `Approve & Apply to Beads` opens a preview and enables `Confirm`.

## Revalidated Fixes

- **Run Workbench 1600px:** now shows run controls and the dark terminal output in the first viewport.
- **Proposal Session 1600px:** now shows the decision bar at the bottom of the first viewport and no longer hides it below the fold.
- **Header fallback text:** still wraps in tight places but no longer appears clipped enough to block restoration QA.

## Findings

### P2: Task Board still does not prioritize the Kanban surface in the first viewport

What happened:

- Create Task and Run Triage still render as large dark panels above the board.
- The Kanban columns begin after those panels instead of being the primary first-viewport surface.
- The rightmost board column is partially clipped by default in the 1600px viewport.

Contract impact:

- The Stitch Task Board reference treats Create Task and Run Triage as compact toolbar commands.
- The contract requires a dense horizontal Kanban control surface with usable horizontal overflow, not large pre-board forms that push the board down.

Evidence:

- `output/playwright/archloop-gui-rerun5-task-board-1600.png`
- `output/playwright/archloop-gui-rerun5-task-board-selected-1600.png`
- Reference: `.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/hub_task_board/screen.png`

### P3: Run Workbench 960px still pushes terminal output below the fold

What happened:

- The 1600px desktop view is fixed.
- At 960px, the first viewport still shows header, stale-claim metadata, and timeline before the terminal/action area.

Contract impact:

- This is less severe than the previous desktop failure, but it remains a responsive-density risk for the constrained viewport requirement.

Evidence:

- `output/playwright/archloop-gui-rerun5-run-workbench-960-top.png`

## Release Decision

Do not close #171 yet.

The high-severity Run Workbench and Proposal Session regressions are fixed for desktop, and the runtime checks are healthy. The Task Board still needs a Kanban-first layout pass before the GUI can be considered restored against the Stitch contract.
