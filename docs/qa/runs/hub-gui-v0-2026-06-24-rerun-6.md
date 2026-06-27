# Hub GUI v0 QA Rerun 6 - 2026-06-24

QA source:

- [`docs/qa/hub-gui-v0.md`](../hub-gui-v0.md)
- [`docs/qa/hub-gui-v0-contract.md`](../hub-gui-v0-contract.md)
- Stitch export under `.stitch/projects/3406577108429917875/`
- Tracking issue: [#171](https://github.com/Yibeibankaishui/archLoop/issues/171)

Branch: `gui-v0`

Environment:

- macOS 14.4.1 `23E224`
- Node `v20.20.2`
- npm `10.8.2`
- Real desktop launch path: `hub-desktop/./node_modules/.bin/electron .`
- Browser QA path: `hub-desktop/npm run dev:renderer-fixtures`

## Summary

Result: **Fail**

This run used the newly available app-control path. The host can now start the real Electron binary and capture the Electron window, which is progress over the earlier LaunchServices/AppKit blocker. However, the real desktop app renders a stable blank white window, both with the default cwd and with `ARCHLOOP_HUB_REPO_ROOT` set to the repository root.

The renderer fixture path still works and shows continued UI progress: Run Workbench now shows terminal output at both 1600px and 960px, Proposal Session keeps the bottom decision bar visible, and preview-confirm interactions still work. Task Board is still not aligned to the Stitch reference: the Kanban board moved upward, but the title/create/triage command surface is now below the board and `Board Actions` visually collides with the action panels.

## Automated Gates

| Gate                                          | Result | Notes                                                       |
| --------------------------------------------- | ------ | ----------------------------------------------------------- |
| `npm run typecheck`                           | Pass   | root typecheck exited 0                                     |
| `npm run build`                               | Pass   | root build and postbuild exited 0                           |
| `hub-desktop/npm run typecheck`               | Pass   | renderer and Electron TypeScript checks passed              |
| `hub-desktop/npm run build`                   | Pass   | Vite renderer build and Electron build passed               |
| `hub-desktop/npm run build:renderer-fixtures` | Pass   | fixture renderer build passed                               |
| Targeted Hub GUI Vitest set                   | Pass   | 8 files, 76 tests passed                                    |
| Real Electron binary smoke                    | Pass   | `./node_modules/.bin/electron --version` returned `v41.7.2` |
| Real Electron app smoke                       | Fail   | app window launches but renders blank white content         |
| Renderer fixture browser smoke                | Pass   | four screens reachable through Playwright                   |

Renderer browser console note: only `favicon.ico` returned 404; no React/runtime bridge error appeared in the fixture path.

Real Electron app note: the process stayed alive and only logged macOS input-method messages; no useful renderer error was emitted to stdout/stderr.

## Evidence

Real Electron screenshots:

- `output/playwright/archloop-gui-rerun6-electron-activated.png`
- `output/playwright/archloop-gui-rerun6-electron-with-root.png`

Renderer fixture screenshots:

- `output/playwright/archloop-gui-rerun6-overview-1600.png`
- `output/playwright/archloop-gui-rerun6-task-board-1600.png`
- `output/playwright/archloop-gui-rerun6-run-workbench-1600.png`
- `output/playwright/archloop-gui-rerun6-run-workbench-960-top.png`
- `output/playwright/archloop-gui-rerun6-proposal-session-1600-top.png`
- `output/playwright/archloop-gui-rerun6-proposal-session-preview-1600.png`

Automation verified:

- Node REPL can import Playwright and exposes `_electron`, but `_electron.launch` failed hard enough to reset the REPL kernel.
- Direct `electron --version` succeeds.
- Direct `electron .` opens an `archLoop Hub` window.
- Direct `electron .` with `ARCHLOOP_HUB_REPO_ROOT=/Users/yibeibankaishui/projects/ref/sandcastle` also opens an `archLoop Hub` window.
- Both real Electron app windows remain blank white after activation and screenshot capture.
- Renderer fixture page title is `archLoop Hub`.
- Overview `SYNC NOW` opens `Sync preview` and enables `Confirm`.
- Task Board selecting `arch-2` updates the inspector to `Recover stale claim` with run directory metadata.
- Run Workbench switches from `Terminal Output` to `JSONL Stream`.
- Proposal Session `Approve & Apply to Beads` opens a preview and enables `Confirm`.

## Revalidated Fixes

- **Run Workbench 1600px:** still shows run controls and dark terminal output in the first viewport.
- **Run Workbench 960px:** now shows terminal/JSONL output in the first viewport, so the rerun 5 narrow-viewport risk is resolved.
- **Proposal Session 1600px:** still shows the decision bar in the first viewport.
- **Preview-confirm flows:** Overview sync and Proposal apply still enable `Confirm` after preview.

## Findings

### P1: Real Electron desktop app renders a blank white window

What happened:

- `./node_modules/.bin/electron --version` succeeds.
- `./node_modules/.bin/electron .` opens a macOS window titled `archLoop Hub`.
- The app content is blank white after waiting and re-activating the window.
- Setting `ARCHLOOP_HUB_REPO_ROOT` to the repository root does not change the outcome.

Contract/user impact:

- This is now a real desktop-app failure rather than a host LaunchServices blocker.
- The desktop app cannot be used through the normal Electron launch path even though the renderer fixture path works.

Evidence:

- `output/playwright/archloop-gui-rerun6-electron-activated.png`
- `output/playwright/archloop-gui-rerun6-electron-with-root.png`

### P2: Task Board still does not match the Stitch Kanban-first layout

What happened:

- The Kanban board now appears at the top of the viewport, which is an improvement.
- The screen title, Create Task form, and Run Triage panel appear below the board instead of as a compact top toolbar.
- `Board Actions` visually collides with and partially covers the lower action panel area.

Contract impact:

- The Stitch Task Board reference keeps the command/filter strip compact above the Kanban board.
- Moving commands below the board solves the old vertical-priority problem by creating a new ordering problem.
- The visible collision/covering fails the no-overlap/no-uncontrolled-layout QA gate.

Evidence:

- `output/playwright/archloop-gui-rerun6-task-board-1600.png`
- Reference: `.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/hub_task_board/screen.png`

## Release Decision

Do not close #171.

Renderer fixture QA is getting close for Run Workbench and Proposal Session, but the real Electron app currently white-screens, and Task Board still needs a layout pass to match the Stitch contract.
