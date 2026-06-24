# Hub GUI v0 Restoration QA - 2026-06-24

QA source:

- [`docs/qa/hub-gui-v0.md`](../hub-gui-v0.md)
- [`docs/qa/hub-gui-v0-contract.md`](../hub-gui-v0-contract.md)
- Stitch export under `.stitch/projects/3406577108429917875/`

Branch: `gui-v0`

Filed issue: [#171](https://github.com/Yibeibankaishui/archLoop/issues/171)

Environment:

- macOS 14.4.1 `23E224`
- Node `v20.20.2`
- npm `10.8.2`
- Browser QA path: `hub-desktop/npm run dev:renderer-fixtures`

## Summary

Result: **Fail**

The latest GUI iteration is materially closer to the Stitch contract than the earlier generic panel grid: it now has real icon rail navigation, a compact header, multi-pane screen layouts, task cards, timelines, proposal decision controls, fixture bridge data, and preview-confirm paths.

It does not yet pass restoration QA. The main failures are visual/layout fidelity and usability regressions against the binding Stitch contract.

## Automated Gates

| Gate                                          | Result  | Notes                                |
| --------------------------------------------- | ------- | ------------------------------------ |
| `npm run typecheck`                           | Pass    | root typecheck exited 0              |
| `npm run build`                               | Pass    | root build exited 0                  |
| `hub-desktop/npm run typecheck`               | Pass    | renderer + Electron TS               |
| `hub-desktop/npm run build`                   | Pass    | Vite + Electron build                |
| `hub-desktop/npm run build:renderer-fixtures` | Pass    | fixture renderer build               |
| Targeted Hub GUI Vitest set                   | Pass    | 8 files, 74 tests passed             |
| Renderer fixture browser smoke                | Pass    | four screens reachable               |
| Real Electron smoke                           | Not run | known host LaunchServices limitation |

Browser console note: only `favicon.ico` returned 404; no React/runtime bridge error appeared.

## Evidence

Captured screenshots:

- `output/playwright/archloop-gui-overview-1600.png`
- `output/playwright/archloop-gui-task-board-1600.png`
- `output/playwright/archloop-gui-run-workbench-1600.png`
- `output/playwright/archloop-gui-proposal-session-1600.png`
- `output/playwright/archloop-gui-run-workbench-960.png`

Playwright verified:

- Page title: `archLoop Hub`.
- Overview, Task Board, Run Workbench, and Proposal Session all load fixture data.
- Overview `SYNC NOW` opens a sync preview and enables `Confirm`.
- Task Board selecting `arch-2` updates the inspector.
- Run Workbench switches from `Terminal Output` to `JSONL Stream`.
- Proposal Session `Approve & Apply to Beads` opens preview and enables `Confirm`.

## Findings

### P1: Proposal decision bar overlays content instead of acting as a bottom action bar

The Proposal Session decision area renders as a large white panel over the main three-column content. It obscures source document/proposal details and pushes the main layout away from the Stitch reference.

Contract impact:

- Violates Proposal Session contract: bottom decision bar with Reject and Approve & Apply to Beads.
- Causes source document content to be visually cut off behind the decision panel.
- Makes the first viewport hard to compare with the Stitch reference.

Evidence:

- `output/playwright/archloop-gui-proposal-session-1600.png`

### P1: Run Workbench does not preserve the Stitch desktop layout

At 1600px the Run Workbench hides the right inspector in the main layout and leaves a large unused right-side area. The bottom terminal/JSONL pane is not visible in the first viewport, while the Stitch reference makes output a bottom-anchored part of the workbench.

At 960px the content column remains narrow and the right side is mostly blank, so the narrow layout does not use available width well.

Contract impact:

- Violates Run Workbench contract: timeline, right inspector, bottom actions, and dark terminal output should form a cohesive execution console.
- Fails the narrow viewport rule: preserve information ordering and density without uncontrolled empty space.

Evidence:

- `output/playwright/archloop-gui-run-workbench-1600.png`
- `output/playwright/archloop-gui-run-workbench-960.png`

### P2: Header command area clips or compresses CLI fallback text

The top header renders command buttons and CLI fallback notes inline. At 1600px, the fallback text for `Run Flow` is visibly truncated and wraps awkwardly.

Contract impact:

- Violates no-overlap/no-uncontrolled-overflow QA gate.
- Reduces readability of disabled/CLI-backed command explanations.

Evidence:

- `output/playwright/archloop-gui-overview-1600.png`
- `output/playwright/archloop-gui-task-board-1600.png`

### P2: Task Board first viewport and horizontal overflow do not match the Stitch board contract

The Task Board now has the right ingredients, but the Create Task and Run Triage blocks occupy too much vertical space before the Kanban board. At 1600px only the top portion of cards is visible in the first viewport, and the `waiting_for_merge` column/card text is clipped at the right edge.

Contract impact:

- Violates Task Board contract: dense horizontal Kanban control surface should be primary.
- Fails horizontal overflow/card-width expectation: cards should not clip text in their own column.

Evidence:

- `output/playwright/archloop-gui-task-board-1600.png`

## Release Decision

Do not pass Hub GUI restoration QA yet.

The implementation has moved in the right direction and the runtime/fixture paths are healthy, but the screen-level visual contract is not satisfied. The next work should focus on layout fidelity and first-viewport usability, not runtime model plumbing.
