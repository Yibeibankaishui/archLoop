# Hub GUI v0 QA Rerun 4 - 2026-06-24

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

The rerun confirms meaningful progress from the prior #171 failure. The Proposal Session decision area no longer overlays the content, Run Workbench now renders an in-screen inspector at desktop width, Task Board selection updates the inspector, and the preview-confirm paths for sync and proposal approval still work.

The GUI still does not pass the binding Stitch restoration contract. The remaining blockers are first-viewport layout fidelity: Run Workbench does not expose the bottom terminal/action console in the first viewport, Proposal Session does not keep the decision bar anchored in the first viewport, and Task Board still gives too much primary space to create/triage panels before the Kanban surface.

## Automated Gates

| Gate                                          | Result  | Notes                                                                                   |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `npm run typecheck`                           | Pass    | root typecheck exited 0                                                                 |
| `npm run build`                               | Pass    | root build and postbuild exited 0                                                       |
| `hub-desktop/npm run typecheck`               | Pass    | renderer and Electron TypeScript checks passed                                          |
| `hub-desktop/npm run build`                   | Pass    | Vite renderer build and Electron build passed                                           |
| `hub-desktop/npm run build:renderer-fixtures` | Pass    | fixture renderer build passed                                                           |
| Targeted Hub GUI Vitest set                   | Pass    | 8 files, 74 tests passed                                                                |
| Renderer fixture browser smoke                | Pass    | four screens reachable through Playwright                                               |
| Real Electron smoke                           | Blocked | not rerun; this host has the known LaunchServices/AppKit limitation recorded in rerun 3 |

Browser console note: only `favicon.ico` returned 404; no React/runtime bridge error appeared.

## Evidence

Captured screenshots:

- `output/playwright/archloop-gui-rerun-overview-1600.png`
- `output/playwright/archloop-gui-rerun-task-board-1600.png`
- `output/playwright/archloop-gui-rerun-task-board-selected-1600.png`
- `output/playwright/archloop-gui-rerun-run-workbench-1600.png`
- `output/playwright/archloop-gui-rerun-run-workbench-960-top.png`
- `output/playwright/archloop-gui-rerun-proposal-session-1600-top.png`
- `output/playwright/archloop-gui-rerun-proposal-session-preview-1600.png`

Playwright verified:

- Page title: `archLoop Hub`.
- Overview `SYNC NOW` opens `Sync preview` and enables `Confirm`.
- Task Board keeps `arch-2` selected and updates the inspector to `Recover stale claim` with run directory metadata.
- Run Workbench switches from `Terminal Output` to `JSONL Stream`.
- Proposal Session `Approve & Apply to Beads` opens a preview and enables `Confirm`.

## Improvements Since #171

- Proposal decision content is no longer a floating overlay over the three-column review content.
- Run Workbench now renders a right-side batch details inspector at 1600px.
- Run Workbench 960px no longer wastes the right side as an empty blank column.
- Header command text is no longer visibly clipped, although it still wraps awkwardly.

## Findings

### P1: Run Workbench still misses the Stitch bottom execution console in the first viewport

What happened:

- At 1600px the screen now has the header, stale-claim banner, timeline, and right inspector.
- The bottom terminal/JSONL output and action row are not visible in the first viewport.
- At 960px the top viewport shows header/banner/timeline only; terminal output remains below the fold.

Contract impact:

- The Stitch Run Workbench reference makes the terminal output a bottom-anchored part of the execution console.
- The contract requires timeline, inspector, bottom actions, and dark terminal output to form one cohesive workbench.

Evidence:

- `output/playwright/archloop-gui-rerun-run-workbench-1600.png`
- `output/playwright/archloop-gui-rerun-run-workbench-960-top.png`
- Reference: `.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/run_workbench/screen.png`

### P1: Proposal Session decision bar is no longer overlaying, but is not a fixed bottom action bar

What happened:

- The top 1600px viewport shows the source document, task decomposition, and inspector, but not the Reject/Approve decision bar.
- The decision area appears later in the document flow after scrolling, not as the Stitch-style bottom decision bar.

Contract impact:

- The Stitch Proposal Session reference keeps the decision bar visible at the bottom of the screen.
- Maintainers should be able to inspect the proposal and see the approval state/actions without searching below the fold.

Evidence:

- `output/playwright/archloop-gui-rerun-proposal-session-1600-top.png`
- `output/playwright/archloop-gui-rerun-proposal-session-preview-1600.png`
- Reference: `.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/proposal_session/screen.png`

### P2: Task Board still does not prioritize the Kanban surface in the first viewport

What happened:

- The Create Task and Run Triage blocks still occupy a large dark two-panel area before the board.
- The Kanban columns start halfway down the first viewport, while the Stitch reference treats the board as the primary surface.
- The waiting-for-merge column remains partially cut at the right edge in the 1600px capture.

Contract impact:

- The Task Board contract requires a dense horizontal Kanban control surface with toolbar actions, not large form panels that push the board down.
- Horizontal overflow is acceptable only when deliberate and usable; card/column content should not appear clipped as the default first view.

Evidence:

- `output/playwright/archloop-gui-rerun-task-board-1600.png`
- `output/playwright/archloop-gui-rerun-task-board-selected-1600.png`
- Reference: `.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/hub_task_board/screen.png`

### P3: Header fallback text is improved but still awkwardly wrapped

What happened:

- The prior visible clipping is mostly gone.
- The `Run Flow` fallback still wraps `<id>` onto a new line in the compact header command area.

Contract impact:

- This is no longer the primary blocker, but the command header still differs from the compact Stitch command treatment.

Evidence:

- `output/playwright/archloop-gui-rerun-overview-1600.png`
- `output/playwright/archloop-gui-rerun-run-workbench-960-top.png`

## Release Decision

Do not close #171 yet.

The runtime paths and automated gates are healthy, and several prior layout issues improved. The release blocker remains visual contract fidelity for the three primary workbench surfaces: Run Workbench, Proposal Session, and Task Board.
