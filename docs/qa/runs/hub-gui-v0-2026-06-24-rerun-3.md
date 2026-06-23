# Hub GUI v0 QA Rerun 3 - 2026-06-24

QA source: [`docs/qa/hub-gui-v0.md`](../hub-gui-v0.md)

Scope: #163 follow-up after adding browser-safe renderer fixture smoke.

Branch: `gui-v0`

Base commit: `0f3124d` plus working tree #163 fix.

Environment:

- OS: macOS 14.4.1 `23E224`
- Architecture: arm64
- Node: `v20.20.2`
- npm: `10.8.2`
- Electron dependency: `41.7.2`

## Summary

Result: **Partial pass**

The original Electron/AppKit launch path is still blocked in this Codex host by macOS LaunchServices before archLoop app code runs. The codebase now has a separate renderer fixture smoke path that lets agents and CI-style browser automation validate the React shell and all four primary views without requiring Electron.

## LaunchServices Diagnosis

Direct Electron startup still fails before the app entrypoint:

```bash
cd hub-desktop
./node_modules/.bin/electron --version
```

Actual:

```text
Electron exited with signal SIGABRT
```

Launching the app bundle through LaunchServices also fails:

```bash
/usr/bin/open -n hub-desktop/node_modules/electron/dist/Electron.app --args --version
launchctl asuser "$(id -u)" /usr/bin/open -n hub-desktop/node_modules/electron/dist/Electron.app --args --version
```

Actual:

```text
kLSServerCommunicationErr: The server process (registration and recent items) is not available
```

This matches the prior crash report stack:

```text
abort()
_RegisterApplication
GetCurrentProcess
-[NSApplication init]
+[NSApplication sharedApplication]
ElectronMain
```

Conclusion: this host cannot perform real Electron smoke QA. It must be run from an interactive macOS GUI session with a working LaunchServices/AppKit environment.

## Implemented Fix

- Added `VITE_HUB_DESKTOP_FIXTURES=1` renderer bridge fallback in `hub-desktop/src/bridge.ts`.
- Added browser-safe fixture data in `hub-desktop/src/fixtureRuntime.ts`.
- Added `npm run dev:renderer-fixtures` and `npm run build:renderer-fixtures` in `hub-desktop/`.
- Updated QA docs to split renderer fixture smoke from Electron fixture smoke.

The fallback only activates when the Electron preload bridge is absent and `VITE_HUB_DESKTOP_FIXTURES=1` is set. Real Electron preload IPC remains the default path.

## Automated Gates

| Gate                                                              | Result | Evidence                                    |
| ----------------------------------------------------------------- | ------ | ------------------------------------------- |
| `npm run typecheck`                                               | Pass   | `tsgo --noEmit` exited 0                    |
| `hub-desktop/npm run typecheck`                                   | Pass   | renderer and Electron TS checks passed      |
| `npm run build`                                                   | Pass   | root build and postbuild completed          |
| `hub-desktop/npm run build`                                       | Pass   | normal Vite renderer + Electron build       |
| `hub-desktop/npm run build:renderer-fixtures`                     | Pass   | fixture renderer built into `dist-fixtures` |
| Targeted Hub GUI tests                                            | Pass   | 8 files, 69 tests passed                    |
| Browser renderer fixture smoke via Playwright on `127.0.0.1:5173` | Pass   | title and all four primary views verified   |

## Browser Renderer Fixture Smoke

Command:

```bash
cd hub-desktop
npm run dev:renderer-fixtures
```

Playwright opened `http://127.0.0.1:5173/`.

Verified:

- Page title: `archLoop Hub`.
- Overview rendered fixture project paths, task counts, failed-task banner, sync metadata, and local actions.
- Task Board rendered five fixture tasks across canonical Hub statuses and the inspector shell.
- Run Workbench rendered `run-fixture-1/batch-fixture-1`, stage timeline, deferred task, stale lease diagnostic, and event output.
- Proposal Session rendered `run-proposal-fixture-1`, transcript excerpt, proposed task cards, validation state, artifacts, and decision actions.

Console note: the only console error was a missing `favicon.ico` 404 from Vite dev server; no React/runtime bridge error appeared.

## Release Decision

Renderer-level agent QA for #163 now has a passing automated path. Real Electron smoke remains a host prerequisite and should be rerun in a normal macOS GUI session before declaring the desktop launch path fully passed.
