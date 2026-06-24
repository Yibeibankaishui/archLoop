# Hub GUI v0 QA Final - arch-jya - 2026-06-24

QA source: [`docs/qa/hub-gui-v0.md`](../hub-gui-v0.md)

Scope: `arch-jya` final cross-screen visual QA, runtime validation, and cleanup.

Branch: `archloop/arch-jya-final-cross-screen-visual-qa-runtime-validation-`

Environment:

- OS: macOS 14.4.1 `23E224`
- Architecture: arm64
- Node: `v20.20.2`
- npm: `10.8.2`
- Browser smoke: Playwright Chromium `134.0.6998.35`

## Summary

Result: **Pass for task scope**

The four contract screens were smoke-checked in renderer fixture mode at desktop and narrow widths, and the bridge-backed preview/confirm actions were exercised for the overview, task board, run workbench, and proposal session surfaces. The root repo test suite still has one unrelated baseline failure outside this slice.

## Automated Gates

| Gate                            | Result       | Evidence                                                                                                                                         |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`             | Pass         | `tsgo --noEmit` exited 0                                                                                                                         |
| `hub-desktop/npm run typecheck` | Pass         | renderer and Electron TypeScript checks passed                                                                                                   |
| `hub-desktop/npm run build`     | Pass         | Vite renderer build and Electron build passed                                                                                                    |
| `npm run test`                  | Partial pass | Root suite reached `src/SandboxLifecycle.test.ts > runHostHooks > uses the provided cwd` and failed on a `/private/var` vs `/var` path assertion |
| Browser renderer fixture smoke  | Pass         | Playwright opened `http://127.0.0.1:5173/`, visited all four screens at 1440px and 700px, and captured screenshots                               |
| Bridge runtime smoke            | Pass         | Preview/execute passed for sync push, task create, recover, and proposal apply actions                                                           |

## Screenshot Evidence

Captured under:

`/tmp/archloop-qa/arch-jya-final`

### Desktop 1440px

| Screen           | Evidence                                                                                 | Result |
| ---------------- | ---------------------------------------------------------------------------------------- | ------ |
| Overview         | [`overview-1440.png`](/tmp/archloop-qa/arch-jya-final/overview-1440.png)                 | Pass   |
| Task Board       | [`task-board-1440.png`](/tmp/archloop-qa/arch-jya-final/task-board-1440.png)             | Pass   |
| Run Workbench    | [`run-workbench-1440.png`](/tmp/archloop-qa/arch-jya-final/run-workbench-1440.png)       | Pass   |
| Proposal Session | [`proposal-session-1440.png`](/tmp/archloop-qa/arch-jya-final/proposal-session-1440.png) | Pass   |

### Narrow 700px

| Screen           | Evidence                                                                               | Result |
| ---------------- | -------------------------------------------------------------------------------------- | ------ |
| Overview         | [`overview-700.png`](/tmp/archloop-qa/arch-jya-final/overview-700.png)                 | Pass   |
| Task Board       | [`task-board-700.png`](/tmp/archloop-qa/arch-jya-final/task-board-700.png)             | Pass   |
| Run Workbench    | [`run-workbench-700.png`](/tmp/archloop-qa/arch-jya-final/run-workbench-700.png)       | Pass   |
| Proposal Session | [`proposal-session-700.png`](/tmp/archloop-qa/arch-jya-final/proposal-session-700.png) | Pass   |

## Runtime Smoke

Renderer fixture smoke command:

```bash
cd hub-desktop
npm run dev:renderer-fixtures
```

Verified in Playwright:

- Overview rendered fixture project status, sync banner, and inspector content.
- Task Board rendered the create-task toolbar, canonical task columns, and inspector shell.
- Run Workbench rendered the selected batch, stage timeline, inspector, and terminal region.
- Proposal Session rendered the source document, task decomposition, validation panel, inspector, and decision bar.
- Bridge-backed preview/confirm actions were exercised on the overview sync action, task board create task action, run workbench recover action, and proposal apply action.

Direct bridge smoke command:

```bash
NODE_PATH=/tmp/archloop-pw/node_modules node
```

Result:

```text
overview preview/execute: true / true
taskCreate preview/execute: true / true
recover preview/execute: true / true
proposalApply preview/execute: true / true
```

## Accepted Deviations

- Narrow-width captures collapse the inspector into a drawer or stacked layout to preserve readability.
- Full-page screenshots include long scrolling surfaces where the contract screen is intentionally dense.
- Fixture data is used for deterministic browser smoke; the visual hierarchy matches the contract while values come from the fixture runtime.

## Notes

- The root `npm run test` failure is unrelated to this slice and is already present in `src/SandboxLifecycle.test.ts`.
- No additional UI code changes were required after the final smoke pass.
