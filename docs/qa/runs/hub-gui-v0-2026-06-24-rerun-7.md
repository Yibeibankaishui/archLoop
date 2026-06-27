# Hub GUI v0 QA Rerun 7 - 2026-06-24

QA source:

- `/Users/yibeibankaishui/.codex/skills/gui-qa/SKILL.md`
- Stitch restoration contract for Hub desktop GUI
- Previous failure report: `docs/qa/runs/hub-gui-v0-2026-06-24-rerun-6.md`

Branch: `gui-v0`

Filed issue: [#171](https://github.com/Yibeibankaishui/archLoop/issues/171)

Environment:

- OS: macOS, Codex desktop session
- Electron: `41.7.2`
- Launch paths:
  - Real Electron: `ARCHLOOP_HUB_REPO_ROOT=/Users/yibeibankaishui/projects/ref/sandcastle ./node_modules/.bin/electron .`
  - Fixture renderer: `hub-desktop/npm run dev:renderer-fixtures`

## Summary

Result: **Pass for the rerun-6 blockers**

The quick-fix pass resolves both release-blocking regressions from rerun 6. The real Electron production app no longer white-screens and no longer falls back to `Hub runtime bridge is unavailable`; it loads the real local Hub project through the Electron preload bridge. The Task Board now keeps the compact toolbar above the Kanban surface, gives the Kanban board the primary first viewport, and leaves Board Actions collapsed below the board.

Subagent `019efa3f-f8e3-7210-9eec-bf17bb148ab3` contributed the fast patch direction for the Vite relative asset path and Task Board layout. Main-agent follow-up fixed the sandboxed Electron preload bridge and completed the final QA.

## Automated Gates

| Gate                                          | Result | Notes                                                                                        |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `npm run typecheck`                           | Pass   | Root TypeScript check passed                                                                 |
| `hub-desktop/npm run typecheck`               | Pass   | Renderer and Electron TypeScript checks passed                                               |
| `hub-desktop/npm run build`                   | Pass   | Vite renderer build and Electron build passed                                                |
| `hub-desktop/npm run build:renderer-fixtures` | Pass   | Browser-safe fixture renderer build passed                                                   |
| Targeted Hub GUI Vitest set                   | Pass   | 8 files, 77 tests passed with default command after slow-test timeouts were encoded in tests |

Targeted test command:

```bash
npx vitest run src/hubRuntimeBridge.test.ts src/hubProposalSession.test.ts src/hubTaskBoardWorkbench.test.ts src/hubDesktopLaunch.test.ts src/hubDesktopShell.test.ts src/hubProjectOverview.test.ts src/hubRunWorkbench.test.ts src/hubProposalWorkbench.test.ts
```

## Evidence

Screenshots:

- `output/playwright/archloop-gui-rerun7-electron-live-bridge.png`
- `output/playwright/archloop-gui-rerun7-task-board-1600.png`

Automation verified:

- Real Electron production app starts and renders real project status: `51 ready / 50 total`, `Beads ready`, project paths, activity timeline, and inspector metadata.
- Electron production `dist/index.html` uses relative `./assets/...` paths.
- Electron sandboxed preload is CommonJS and exposes `window.hubRuntime` through `contextBridge`.
- Task Board fixture loads five status columns and keeps toolbar, board, and collapsed actions in the correct order.
- Task Board metrics at 1600x1024 with inspector open:
  - toolbar: `top=80`, `bottom=171`, `height=90`
  - Kanban board: `top=183`, `bottom=969`, `height=787`
  - Board Actions: `top=981`, `height=39`, `open=false`
- Selecting `arch-2` updates the inspector to `Recover stale claim`.
- Recover preview shows `Recover arch-2 to ready_for_agent in fixture mode.` and enables Confirm.

Console/network notes:

- Fixture renderer reported one non-blocking console error: `/favicon.ico` 404.
- No app runtime bridge errors remained after the preload fix.

## Findings

No P1/P2 findings remain for the rerun-6 blockers.

Resolved:

- P1 real Electron blank white window.
- P1/P2 Electron production app could render but showed `Hub runtime bridge is unavailable`.
- P2 Task Board Kanban-first layout regression.
- P2 Task Board toolbar text collision in the compact Create Task action.

## Release Decision

Pass this quick-fix QA scope. The real Electron path and Task Board first viewport are now usable enough to close #171.
