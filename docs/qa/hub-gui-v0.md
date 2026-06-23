# archLoop Hub GUI v0 QA

本文档用于验收 GitHub issues #151 到 #156。验收目标是确认第一版 Hub GUI 已经作为桌面端应用落地，并且能通过真实本地 Hub runtime bridge 读取项目、任务、运行、proposal session 和同步状态。

Binding design contract: [`docs/qa/hub-gui-v0-contract.md`](./hub-gui-v0-contract.md)

## Scope

| Issue | Scope                                            | Primary evidence                                                                                                                      |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| #151  | Hub GUI v0 implementation target decision        | `hub-desktop/`, `README.md` Hub desktop app section, closed issue                                                                     |
| #152  | Desktop shell and local runtime bridge           | `hub-desktop/`, `src/hubDesktopShell.ts`, `src/hubRuntimeBridge.ts`, `src/hubRuntimeBridgeService.ts`                                 |
| #153  | Run Workbench vertical slice                     | `src/hubRunWorkbench.ts`, `hub-desktop/src/components/views/RunWorkbenchView.tsx`                                                     |
| #154  | Hub Project Overview vertical slice              | `src/hubProjectOverview.ts`, `hub-desktop/src/components/views/OverviewView.tsx`                                                      |
| #155  | Proposal Session vertical slice                  | `src/hubProposalWorkbench.ts`, `src/hubProposalSession.ts`, `hub-desktop/src/components/views/ProposalSessionView.tsx`                |
| #156  | Hub Task Board and task inspector vertical slice | `src/hubTaskBoardWorkbench.ts`, `hub-desktop/src/components/views/TaskBoardView.tsx`, `hub-desktop/src/components/InspectorPanel.tsx` |

Out of scope:

- The historical static prototype in `gui/`.
- The MCP-only duplicate overview surface that does not participate in the desktop shell contract.
- Planner selection correctness regressions tracked separately by #157, #158, and #159.
- Direct GitHub mutation from the proposal screen. Current v0 copy keeps proposal apply local-first and remote sync separate.

## Preconditions

Use a throwaway target repo for destructive or mutating checks.

```bash
export ARCHLOOP_REPO=/Users/yibeibankaishui/projects/ref/sandcastle
export TARGET_REPO=/path/to/throwaway-target-repo

cd "$ARCHLOOP_REPO"
git switch gui-v0
git status --short
```

Acceptable local noise: `.beads/interactions.jsonl` may be modified by local Hub task-store/runtime activity. Do not stage it as QA evidence.

Required local tools:

- Node.js and npm compatible with the repo lockfile.
- `bd` available for local task-store checks.
- `gh` authenticated if remote GitHub sync is being verified.
- At least one configured agent runtime if generating fresh run/proposal data.

## Automated Gates

Run these from the archLoop repo root:

```bash
cd "$ARCHLOOP_REPO"
npm run typecheck
npx vitest run \
  src/hubDesktopLaunch.test.ts \
  src/hubDesktopShell.test.ts \
  src/hubRuntimeBridge.test.ts \
  src/hubProjectOverview.test.ts \
  src/hubRunWorkbench.test.ts \
  src/hubProposalSession.test.ts \
  src/hubProposalWorkbench.test.ts \
  src/hubTaskBoardWorkbench.test.ts
npm run build
```

Run the desktop app gates:

```bash
cd "$ARCHLOOP_REPO/hub-desktop"
npm install
npm run typecheck
npm run build
```

Optional full regression:

```bash
cd "$ARCHLOOP_REPO"
npm test
```

Pass criteria:

- All commands exit `0`.
- `hub-desktop/package.json` keeps `main` as `dist-electron/main.js`.
- `npm run build` in `hub-desktop/` produces both Vite output and Electron main/preload output.
- No generated QA artifacts are added outside expected build output and local runtime files.

## Desktop Launch Smoke

Renderer fixture mode verifies the app shell and all primary screens without needing a populated target repo or Electron/AppKit. Use this path for agent-run QA, CI-style browser automation, and hosts where macOS LaunchServices is unavailable:

```bash
cd "$ARCHLOOP_REPO/hub-desktop"
npm run dev:renderer-fixtures
```

Expected renderer fixture behavior:

- Open `http://127.0.0.1:5173/` in a browser automation harness.
- Navigation exposes exactly four primary sections: Overview, Task Board, Run Workbench, Proposal Session.
- Fixture mode shows representative non-empty Hub data.
- No runtime unavailable banner appears while `VITE_HUB_DESKTOP_FIXTURES=1` is active.

Electron fixture mode verifies the real desktop shell, preload bridge, IPC channel, window chrome, and packaged renderer path. Run it from an interactive macOS GUI session with a working LaunchServices/AppKit environment:

```bash
cd "$ARCHLOOP_REPO"
npm run build
cd hub-desktop
ARCHLOOP_HUB_DESKTOP_FIXTURES=1 npm run dev
```

Real project mode verifies the local runtime bridge against a target repo:

```bash
cd "$ARCHLOOP_REPO"
npm run build
cd hub-desktop
ARCHLOOP_HUB_REPO_ROOT="$TARGET_REPO" npm run dev
```

Expected:

- Electron window title is `archLoop Hub`.
- Navigation exposes exactly four primary sections: Overview, Task Board, Run Workbench, Proposal Session.
- Window starts at desktop size and remains usable down to the configured minimum window size.
- Real mode reads from `ARCHLOOP_HUB_REPO_ROOT`, not from the desktop app directory.
- If the runtime bridge fails, the UI shows a runtime unavailable state with CLI fallback copy.
- If `/usr/bin/open` reports `kLSServerCommunicationErr` or Electron aborts in `_RegisterApplication` before app code runs, the host cannot perform Electron smoke QA; record the host failure and use renderer fixture smoke for automated renderer coverage.

## Test Data Setup

For read-only QA, use an existing target repo with tasks and Hub run artifacts. For a clean throwaway repo:

```bash
cd "$TARGET_REPO"
archloop project status
archloop tasks init
archloop tasks create "QA ready task" --description "Small change with clear acceptance criteria."
archloop tasks create "QA human task" --description "Requires human product decision before implementation."
archloop tasks list
```

To generate run data only in a throwaway repo:

```bash
cd "$TARGET_REPO"
archloop run . --flow with-review
```

To generate proposal data only in a throwaway repo:

```bash
cd "$TARGET_REPO"
archloop tasks from-prd <prd-ref>
archloop tasks triage
```

Record the run directory paths printed by CLI commands. They are needed when checking Run Workbench and Proposal Session.

## Manual QA Matrix

| Area                         | Pass/Fail | Evidence                                                              |
| ---------------------------- | --------- | --------------------------------------------------------------------- |
| #151 desktop target          |           | Screenshot of `hub-desktop` Electron app and `README.md` command used |
| #152 shell/bridge            |           | Screenshot of nav, runtime fallback, preview/confirm action           |
| #154 overview                |           | Screenshot of project paths, task counts, sync panels, banners        |
| #156 task board              |           | Screenshot of columns, filters, selected task inspector               |
| #153 run workbench           |           | Screenshot of selected run, stage timeline, terminal events, gates    |
| #155 proposal session        |           | Screenshot of proposal run, task cards, validation/apply state        |
| responsive layout            |           | Screenshots at desktop and narrow widths                              |
| keyboard/accessibility smoke |           | Notes for tab order, focus ring, controls reachable                   |

## #151 Desktop Target

Steps:

1. Launch fixture mode.
2. Confirm the app is the Electron shell under `hub-desktop/`, not `gui/index.html`.
3. Confirm `README.md` documents `npm run build`, `cd hub-desktop`, `npm install`, `npm run dev`.
4. Confirm the app uses the current archLoop identity in visible text.

Expected:

- Desktop app is usable as first screen, with no marketing or static prototype interstitial.
- The old `gui/` prototype is clearly only historical reference.
- The four Stitch-derived control-plane areas are visible through navigation.

Fail signals:

- QA can only open `gui/index.html`.
- The first screen is a static mock without runtime bridge data.
- Visible text introduces old Sandcastle identity.

## #152 Shell And Runtime Bridge

Steps:

1. Launch fixture mode and navigate all four sections.
2. Launch real project mode with `ARCHLOOP_HUB_REPO_ROOT="$TARGET_REPO"`.
3. Temporarily point `ARCHLOOP_HUB_REPO_ROOT` to a non-Hub path and relaunch.
4. Trigger at least one preview action, then confirm it.

Expected:

- Main process creates the bridge with `ARCHLOOP_HUB_REPO_ROOT` or `process.cwd()`.
- Preload exposes `window.hubRuntime.invoke` through the `hub-runtime:invoke` IPC channel.
- Renderer has no direct Node integration requirement.
- Preview actions produce a summary and confirm token before confirm.
- Confirm without preview is rejected by the runtime contract.
- Runtime unavailable states include a CLI fallback.

Fail signals:

- Renderer directly reads local files instead of using the bridge.
- Mutating actions execute without preview/confirm.
- Real mode always reads the desktop app directory instead of the target repo.

## #154 Project Overview

Steps:

1. Open Overview in real project mode.
2. Compare visible project paths and counts with:

   ```bash
   cd "$TARGET_REPO"
   archloop project status
   archloop tasks list
   ```

3. Create or use tasks with `push_pending`, `sync_conflict`, failed task, or worktree lease diagnostic metadata.
4. Use Overview preview buttons for recover or sync where available.

Expected:

- Project root, archLoop user data dir, Hub project dir, Beads availability, and task-store initialization are visible.
- Task counts and status counts match CLI output.
- Local task-store health is distinct from remote sync status.
- Failed task, sync conflict, push pending, and lease diagnostic banners are actionable.
- CLI-only actions are clearly marked as CLI-only.

Fail signals:

- Overview collapses local and remote sync into one ambiguous number.
- Missing task store is shown as a fatal app crash.
- Recover/sync actions do not expose disabled reasons when unavailable.

## #156 Task Board And Inspector

Steps:

1. Open Task Board in real project mode.
2. Compare columns with `archloop tasks list`.
3. Exercise search by task id, title, label, remote ref, and run ref.
4. Exercise filters for status, claim state, and sync state.
5. Select a task and inspect the right panel.
6. Trigger available preview/confirm actions for recover or sync.

Expected:

- Columns use only canonical Hub statuses.
- Excluded statuses such as `pending`, `triaging`, `waiting_for_review`, `planning`, `reserved`, `claimed`, and `deferred` never appear as board columns.
- Claim state is rendered as metadata, not as a task status.
- Cards show title, id, labels, sync/claim/failure/dependency markers, remote refs, and run refs.
- Inspector shows Beads details, comments summary, lease/run metadata, next actions, and action controls.
- Empty task store shows an empty state with CLI fallback, not a crash.

Fail signals:

- Task selection does not populate the inspector.
- Search/filter changes corrupt the task count.
- Failed, blocked, or sync-conflict tasks lose their reason fields.
- Recover confirm is available for non-failed tasks.

## #153 Run Workbench

Steps:

1. Open Run Workbench after at least one Hub run exists.
2. Compare selected run/batch with Hub run directories under the local archLoop user data dir.
3. Select recent and active runs if multiple are present.
4. Compare terminal event lines with JSONL event files in the run directory.
5. Use or simulate success, running, failed verification, merge conflict, dirty source, stale claim, and close failure states.
6. Trigger recover preview/confirm on a failed task where available.

Expected:

- Default focus selects an active batch first; otherwise the latest run/batch.
- Metadata includes run id, batch id, flow id, branch, strategy, selected tasks, deferred tasks, and worktree leases when present.
- Stage timeline maps real Hub event vocabulary to run start, task claim, implementation, review, verification, merge, close, failure, and recovery.
- Terminal phase distinguishes no events, running, verification passed, failed, and completed.
- Gates include actionable title, message, next step, and CLI fallback.
- Resume/cancel operations that have no desktop confirm path in v0 are visibly CLI-only.

Fail signals:

- Latest run is selected while an active batch exists.
- Verification failure appears as completed/passed.
- JSONL event lines are absent even though run events exist.
- Failed gates do not provide recovery or CLI fallback guidance.

## #155 Proposal Session

Steps:

1. Open Proposal Session after at least one `prd-decomposition` or `triage` proposal run exists.
2. Select proposal run directories from the dropdown.
3. Compare source context, transcript excerpt, final proposal, apply result, and events with the proposal session artifacts on disk.
4. Check valid, warning, and error proposal cards.
5. Check apply state for none, pending, applied, validation failed, and blocked mutations when fixture or test data allows it.

Expected:

- Screen states clearly say proposal apply writes local Beads tasks only.
- Remote GitHub issue sync remains separate and points to `archloop tasks push` or `archloop tasks sync`.
- PRD decomposition proposals show task cards with dependencies, intended status, validation state, warnings, confidence, and rationale.
- Triage proposals show guarded decisions as warnings or disabled actions when they require human confirmation.
- Missing acceptance criteria, invalid dependencies, schema mismatch, and mutation detection failure are blocking validation errors.
- Approve, reject, revise, and apply actions are represented with CLI fallbacks and disabled reasons.

Fail signals:

- Proposal screen implies GitHub is mutated during local apply.
- Invalid proposal can be applied without validation error.
- Mutation detection failure is treated as a warning rather than a blocker.
- Applied proposal can still be rejected from the desktop shell.

## Responsive And Accessibility Smoke

Run both fixture and real modes at:

- Desktop: `1440 x 960`
- Tablet/narrow: about `800 x 900`
- Compact: minimum supported width around `720`

Expected:

- Shell uses rail + header + main + inspector on desktop.
- Inspector collapses or becomes optional on narrow widths.
- Text does not overlap or overflow control boundaries.
- Tab order reaches nav, filters, selects, cards, Preview, Confirm, and CLI-only buttons.
- Focus ring is visible on keyboard focus.
- Buttons expose clear labels and disabled states.

Fail signals:

- Inspector overlays main content without user control.
- Long paths or run ids break the layout.
- Preview/Confirm buttons are unreachable by keyboard.

## Regression And Negative Cases

Verify these cases in a throwaway repo or fixture mode:

| Case                                | Expected                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| No local task store                 | Overview and Task Board show init fallback, no crash                             |
| Beads unavailable                   | Runtime shows task-store unavailable copy and read-only/disabled actions         |
| Empty runs                          | Run Workbench shows empty state with `archloop run . --flow <id>` fallback       |
| Empty proposal sessions             | Proposal Session shows empty state with `archloop tasks from-prd <ref>` fallback |
| Nonexistent proposal run dir        | Runtime bridge returns `not_found` and UI shows actionable error                 |
| Confirm without preview token       | Runtime returns `confirm_invalid`                                                |
| Recover preview for non-failed task | Preview is disabled with reason                                                  |
| Sync conflict                       | Overview and Task Board show conflict state and CLI fallback                     |
| Worktree lease diagnostic           | Overview and Run Workbench show lease diagnostic / recovery guidance             |
| Dirty source worktree gate          | Run Workbench shows dirty source gate with next step                             |

## Evidence Checklist

For each QA run, record:

- Date, tester, OS, Node version, npm version.
- archLoop commit SHA and branch.
- `gh issue view 151..156` state snapshot or links.
- Output of automated gates.
- Desktop fixture launch screenshot.
- Desktop real project launch screenshot.
- `TARGET_REPO` path and `archloop project status` output.
- Task ids used for board/inspector checks.
- Run id, batch id, run directory path, and event file path.
- Proposal run directory and artifact paths.
- Any failed scenario with exact reproduction steps.

## Release Decision

Pass Hub GUI v0 QA only when:

- All automated gates pass.
- Both fixture mode and real project mode launch.
- All four primary screens meet their manual pass criteria.
- Mutating paths require preview/confirm or are clearly CLI-only.
- Local Beads writes and remote GitHub sync are not conflated.
- Known planner issues #157, #158, and #159 are not misclassified as failures of #151 to #156 unless the test scope explicitly includes planner task selection.
