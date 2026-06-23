# Hub GUI v0 QA Rerun - 2026-06-24

QA source: [`docs/qa/hub-gui-v0.md`](../hub-gui-v0.md)

Scope: GitHub issues #151 to #156, with re-verification of QA findings #160 to #162.

Branch: `gui-v0`

Commit: `848fe9f`

Environment:

- OS: macOS 14.4.1 `23E224`
- Kernel: Darwin 23.4.0 arm64
- Node: `v20.20.2`
- npm: `10.8.2`
- Electron dependency: `41.7.1`
- Electron binary: Mach-O arm64

## Summary

Result: **Fail**

Reason: The previous automated blockers #160, #161, and #162 are fixed, but desktop launch smoke is still blocked because the installed Electron runtime aborts in normal app/Chromium mode on this macOS host.

Issues:

- #160: Closed, verified fixed by `hub-desktop/npm run typecheck`.
- #161: Closed, verified fixed by `hub-desktop/npm run build`.
- #162: Closed, verified fixed by `hub-desktop/npm ci`, `npm install`, and `npm audit --audit-level=critical`.
- #163: Open, new finding. Electron runtime aborts on macOS fixture launch smoke.

## Automated Gates

| Gate                                           | Result | Evidence                                                          |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------- |
| `npm run typecheck`                            | Pass   | `tsgo --noEmit` exited 0                                          |
| Targeted GUI model tests                       | Pass   | 8 files, 69 tests passed                                          |
| `npm run build`                                | Pass   | root build and postbuild completed                                |
| `hub-desktop/npm ci`                           | Pass   | installed from lockfile, 203 packages audited, 0 vulnerabilities  |
| `hub-desktop/npm install`                      | Pass   | up to date, 203 packages audited, 0 vulnerabilities               |
| `hub-desktop/npm run typecheck`                | Pass   | renderer and Electron TypeScript checks passed                    |
| `hub-desktop/npm run build`                    | Pass   | Vite renderer build and Electron build passed                     |
| `hub-desktop/npm audit --audit-level=critical` | Pass   | found 0 vulnerabilities                                           |
| Electron direct launch                         | Fail   | `electron --version` exits with `SIGABRT`                         |
| Electron fixture app launch                    | Fail   | `ARCHLOOP_HUB_DESKTOP_FIXTURES=1 electron .` exits with `SIGABRT` |

Targeted GUI model test command:

```bash
npx vitest run \
  src/hubDesktopLaunch.test.ts \
  src/hubDesktopShell.test.ts \
  src/hubRuntimeBridge.test.ts \
  src/hubProjectOverview.test.ts \
  src/hubRunWorkbench.test.ts \
  src/hubProposalSession.test.ts \
  src/hubProposalWorkbench.test.ts \
  src/hubTaskBoardWorkbench.test.ts
```

Result:

```text
Test Files  8 passed (8)
Tests       69 passed (69)
```

## Previously Failed Gates

### #160 Type Contract

Command:

```bash
cd hub-desktop
npm run typecheck
```

Result: pass.

The previous `TS2305` for `HubTaskStatus` did not reproduce.

### #161 Renderer Production Build

Command:

```bash
cd hub-desktop
npm run build
```

Result: pass.

Vite output:

```text
✓ 52 modules transformed.
✓ built in 723ms
```

The previous Node-only renderer import graph failure did not reproduce.

### #162 Dependency Hygiene

Commands:

```bash
cd hub-desktop
npm ci
npm install
npm audit --audit-level=critical
```

Result: pass.

Evidence:

```text
found 0 vulnerabilities
```

`hub-desktop/package-lock.json` is now present before install.

## New Finding: Electron Launch Smoke Fails

Issue: #163

Commands:

```bash
cd hub-desktop
./node_modules/.bin/electron --version
```

Actual:

```text
/Users/yibeibankaishui/projects/ref/sandcastle/hub-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron exited with signal SIGABRT
```

Fixture launch also aborts:

```bash
ARCHLOOP_HUB_DESKTOP_FIXTURES=1 ELECTRON_ENABLE_LOGGING=1 ELECTRON_ENABLE_STACK_DUMPING=1 ./node_modules/.bin/electron .
```

Captured result:

```json
{
  "exitCode": null,
  "signalCode": "SIGABRT",
  "stdout": "",
  "stderr": "Received signal 6\\n [stack trace addresses only]\\n"
}
```

Control check:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "console.log(process.versions.electron); console.log(process.version)"
```

Result:

```text
41.7.1
v24.15.0
```

This means the Electron binary exists and can run Node-mode code, but normal Electron/Chromium startup aborts.

## Manual QA Status

| Area                         | Result       | Notes                                                       |
| ---------------------------- | ------------ | ----------------------------------------------------------- |
| #151 desktop target          | Blocked      | Build passes, but Electron runtime launch aborts            |
| #152 shell/bridge            | Partial pass | Type/model tests pass; runtime window could not be launched |
| #154 overview                | Partial pass | Model tests pass; visual desktop QA blocked                 |
| #156 task board              | Partial pass | Type/model tests pass; visual inspector QA blocked          |
| #153 run workbench           | Partial pass | Model tests pass; visual desktop QA blocked                 |
| #155 proposal session        | Partial pass | Model/session tests pass; visual desktop QA blocked         |
| responsive layout            | Not run      | Blocked by #163                                             |
| keyboard/accessibility smoke | Not run      | Blocked by #163                                             |

## Release Decision

Do not pass Hub GUI v0 QA yet.

Minimum fix before rerun:

1. Close #163 so `ARCHLOOP_HUB_DESKTOP_FIXTURES=1 npm run preview` or equivalent direct Electron launch stays alive.
2. Rerun fixture-mode visual QA.
3. Rerun real-project desktop QA with `ARCHLOOP_HUB_REPO_ROOT`.

After #163 is resolved, automated gates do not need redesign for #160 to #162 unless their regressions reappear.
