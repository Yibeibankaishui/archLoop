# Hub GUI v0 QA Rerun 2 - 2026-06-24

QA source: [`docs/qa/hub-gui-v0.md`](../hub-gui-v0.md)

Scope: GitHub issues #151 to #156, with re-verification of #160 to #163.

Branch: `gui-v0`

Commit: `0f3124d`

Environment:

- OS: macOS 14.4.1 `23E224`
- Architecture: arm64
- Node: `v20.20.2`
- npm: `10.8.2`
- Electron dependency: `41.7.2`

## Summary

Result: **Fail**

Reason: Build, typecheck, audit, and model-level GUI tests pass when run in a stable sequence, but Electron still aborts in normal app/Chromium startup mode. Fixture and real-project visual QA remain blocked by #163.

Issues:

- #160: Closed, still verified fixed.
- #161: Closed, still verified fixed.
- #162: Closed, still verified fixed for lockfile/audit cleanliness.
- #163: Open, still reproduces with Electron `41.7.2`.

## Automated Gates

| Gate                                           | Result            | Evidence                                                                         |
| ---------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `npm run typecheck`                            | Pass              | `tsgo --noEmit` exited 0                                                         |
| `npm run build`                                | Pass              | root build and postbuild completed                                               |
| Targeted GUI model tests                       | Pass              | 8 files, 69 tests passed after dependency install completed                      |
| `hub-desktop/npm ci`                           | Pass with warning | 150 packages audited, 0 vulnerabilities, `EBADENGINE` warnings under Node 20     |
| `hub-desktop/npm install`                      | Pass with warning | up to date, 0 vulnerabilities, same `EBADENGINE` warnings                        |
| `hub-desktop/npm run typecheck`                | Pass              | renderer and Electron TypeScript checks passed                                   |
| `hub-desktop/npm run build`                    | Pass              | Vite renderer build and Electron build passed                                    |
| `hub-desktop/npm audit --audit-level=critical` | Pass              | found 0 vulnerabilities                                                          |
| Electron direct launch                         | Fail              | `electron --version` exits with `SIGABRT`                                        |
| Electron fixture preview                       | Fail              | `ARCHLOOP_HUB_DESKTOP_FIXTURES=1 npm run preview` exits after Electron `SIGABRT` |

## QA Hygiene Note

Do not run `hub-desktop/npm ci` in parallel with targeted Vitest tests. `npm ci` rewrites `hub-desktop/node_modules`, and it caused false failures while `hubDesktopLaunch.test` was invoking `hub-desktop/npm run typecheck`.

After rerunning sequentially, the targeted GUI test set passed:

```text
Test Files  8 passed (8)
Tests       69 passed (69)
```

## Install Warning

`npm ci` and `npm install` both exit 0 and audit clean, but emit engine warnings in this QA environment:

```text
package: 'electron@41.7.2'
required: { node: '>= 22.12.0' }
current: { node: 'v20.20.2', npm: '10.8.2' }
```

The same warning appears for `@electron/get@5.0.0` and `@electron-internal/extract-zip@1.0.3`.

This warning is not the immediate automated gate failure because npm exits 0, but it is relevant context for #163 and for documenting supported desktop QA prerequisites.

## #163 Reproduction

Command:

```bash
cd hub-desktop
./node_modules/.bin/electron --version
```

Actual:

```text
/Users/yibeibankaishui/projects/ref/sandcastle/hub-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron exited with signal SIGABRT
```

Fixture preview:

```bash
ARCHLOOP_HUB_DESKTOP_FIXTURES=1 npm run preview
```

Actual:

```text
✓ built in 810ms
> tsc -p tsconfig.electron.json
Received signal 6
[end of stack trace]
.../Electron exited with signal SIGABRT
```

Crash report still shows pre-app-code AppKit registration:

```text
EXC_CRASH / SIGABRT
abort()
_RegisterApplication
GetCurrentProcess
-[NSApplication init]
+[NSApplication sharedApplication]
ElectronMain
```

Control check:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "console.log(process.versions.electron); console.log(process.version)"
```

Output:

```text
41.7.2
v24.15.0
```

## Manual QA Status

| Area                         | Result       | Notes                                                 |
| ---------------------------- | ------------ | ----------------------------------------------------- |
| #151 desktop target          | Blocked      | Electron runtime launch aborts before window creation |
| #152 shell/bridge            | Partial pass | Type/model tests pass; runtime window cannot launch   |
| #154 overview                | Partial pass | Model tests pass; visual desktop QA blocked           |
| #156 task board              | Partial pass | Type/model tests pass; visual inspector QA blocked    |
| #153 run workbench           | Partial pass | Model tests pass; visual desktop QA blocked           |
| #155 proposal session        | Partial pass | Model/session tests pass; visual desktop QA blocked   |
| responsive layout            | Not run      | Blocked by #163                                       |
| keyboard/accessibility smoke | Not run      | Blocked by #163                                       |

## Release Decision

Do not pass Hub GUI v0 QA yet.

#160, #161, and #162 are verified fixed. #163 remains the release blocker for desktop fixture and real-project GUI validation.
