# Hub GUI v0 Layout Fix QA - arch-jli - 2026-06-24

QA source: [`docs/qa/hub-gui-v0.md`](../hub-gui-v0.md)

Scope: `arch-jli` Stitch visual contract restoration for the Hub desktop surfaces.

Branch: `archloop/arch-jli-hub-gui-restoration-qa-fails-stitch-visual-contr`

Environment:

- OS: macOS 14.4.1 `23E224`
- Node: `v20.20.2`
- npm: `10.8.2`
- Browser QA path: `hub-desktop/npm run dev:renderer-fixtures`

## Summary

Result: **Pass for task scope**

The Hub desktop screens now reclaim the desktop inspector column when the inspector is closed, keep the proposal decision bar in flow, and compact the task board, run workbench, and header control surfaces so the first viewport matches the Stitch contract much more closely.
Follow-up pass: the task board now promotes the Kanban surface ahead of supporting chrome at desktop width, and the 960px run layout keeps the terminal visible in the first viewport.

## Automated Gates

| Gate                           | Result       | Notes                                                                |
| ------------------------------ | ------------ | -------------------------------------------------------------------- |
| `npm run typecheck`            | Pass         | Root typecheck exited 0                                              |
| `npm run test`                 | Partial pass | Root suite still hits unrelated baseline failures outside this slice |
| Targeted Hub GUI Vitest set    | Pass         | Hub desktop shell and workbench tests passed                         |
| Browser renderer fixture smoke | Pass         | All four contract screens loaded in fixture mode                     |

## Screenshot Evidence

Captured in the repository:

- `output/playwright/archloop-gui-overview-1600.png`
- `output/playwright/archloop-gui-task-board-1600.png`
- `output/playwright/archloop-gui-run-workbench-1600.png`
- `output/playwright/archloop-gui-run-workbench-960.png`
- `output/playwright/archloop-gui-proposal-session-1600.png`

## Visual Checks

- Overview keeps the header command text readable and preserves the inspector layout when open.
- Task Board reclaims vertical space for the Kanban surface, shows the board before the create/triage chrome, and keeps task text from clipping in the cards.
- Run Workbench uses the available desktop width when the inspector is hidden, keeps the output stack compact, and surfaces the terminal in the 960px viewport.
- Proposal Session no longer overlays the decision area on top of the source and decomposition content.

## Notes

- The root `npm run test` command still reports unrelated baseline failures in environment-sensitive tests.
- The captured screenshots are saved under `output/playwright/` and should be treated as the task evidence for merge review.
