# Hub UI Aesthetic and UX Review - 2026-06-25

QA source:

- `/Users/yibeibankaishui/.codex/skills/gui-qa/SKILL.md`
- `ui-ux-pro-max` local UX guidance for responsive, navigation-heavy dashboards
- Fixture renderer at `hub-desktop`

Branch: `gui-v0`

Filed issue: None

Environment:

- OS: macOS, Codex desktop session
- Launch path: `VITE_HUB_DESKTOP_FIXTURES=1 npx vite --host 127.0.0.1 --port 5174`
- Browser automation: Playwright with headless Chrome
- Viewports: `1440x900`, `1024x768`, `390x844`

## Summary

Result: **Fail for mobile/tablet UX, mixed for desktop visual polish**

The desktop visual direction is a good fit for archLoop Hub: restrained, dense, technical, and state-forward. Run Workbench is the strongest surface. The current shell still has major responsive and layout problems below desktop width, and Proposal Session has a decision bar that overlays and clips content at desktop width when the inspector is open.

## Evidence

Screenshots:

- `output/playwright/hub-overview-desktop.png`
- `output/playwright/hub-task-board-desktop.png`
- `output/playwright/hub-run-workbench-desktop.png`
- `output/playwright/hub-proposal-session-desktop.png`
- `output/playwright/hub-initial-inspector-drawer-mobile.png`
- `output/playwright/hub-overview-mobile.png`
- `output/playwright/hub-task-board-mobile.png`
- `output/playwright/hub-proposal-session-mobile.png`

Automation summary:

- `output/playwright/hub-ui-qa-summary.json`
- No page errors.
- One non-blocking console error: favicon/resource 404.

## Findings

### P1: Mobile starts on an inspector drawer instead of the active workspace

What happened:

- At `390x844`, initial load opens the inspector drawer over the app.
- Users must close the drawer before they can see or use the current view.
- Evidence: `output/playwright/hub-initial-inspector-drawer-mobile.png`

Impact:

- The first viewport reads as a details drawer or empty metadata page, not as archLoop Hub.
- It blocks navigation and primary content until dismissed.

Likely source:

- `hub-desktop/src/components/HubShell.tsx`
- `src/hubDesktopShell.ts`

### P1: Compact shell layout still renders the rail as an implicit right-side column

What happened:

- At `390x844`, `hubDesktopShellGridStyle()` switches to header/main only, but `HubNav` still renders with `grid-area: rail`.
- The rail is implicitly placed to the right, consuming about `84px`.
- Main content width drops to about `307px`, making dense workbench pages feel broken.
- Evidence: `output/playwright/hub-overview-mobile.png`, `output/playwright/hub-task-board-mobile.png`

Impact:

- Mobile is not a usable compact layout.
- The UI loses hierarchy and wastes scarce horizontal space.

Likely source:

- `src/hubDesktopShell.ts`
- `hub-desktop/src/styles/hub-desktop.css`

### P1: Proposal Session decision bar overlays and clips the desktop content

What happened:

- At `1440x900` with inspector open, the Proposal Session decision bar sits over the lower content.
- The third/primary action is visually cut off by the inspector column.
- Evidence: `output/playwright/hub-proposal-session-desktop.png`

Impact:

- The most important review action is partially hidden.
- Users cannot confidently read the proposal state and available decisions.

Likely source:

- `hub-desktop/src/styles/hub-desktop.css`

### P2: Task Board toolbar and Kanban layout overflow on tablet/mobile

What happened:

- At `1024x768`, the main pane is `584px` wide with inspector open, while Task Board content wants about `1327px`.
- At `390x844`, toolbar content wants about `970px`.
- The Create Task and Run Triage controls are clipped or hidden before users reach the board.
- Evidence: `output/playwright/hub-task-board-tablet.png`, `output/playwright/hub-task-board-mobile.png`

Impact:

- Task Board is hard to scan and difficult to operate on narrow screens.
- The toolbar competes with the board instead of supporting it.

Likely source:

- `hub-desktop/src/styles/hub-desktop.css`
- `hub-desktop/src/components/views/TaskBoardView.tsx`

### P2: Top-level actions create visual noise and weak affordance

What happened:

- Header repeats sync affordances across `Sync`, `SYNC NOW`, and `Sync Now`.
- `Run Flow`, notifications, help, and account are visible but disabled.

Impact:

- Users see many controls but only some are actionable.
- The primary next action is less obvious than it should be.

### P3: Visual system is competent but still generic

What works:

- Light technical palette is calm and readable.
- Status chips use consistent tones.
- Borders, spacing, and mono text create a credible developer-tool feel.
- Run Workbench has the best hierarchy: context, risk, actions, terminal.

What needs polish:

- Custom icons look slightly uneven compared with a standard icon set.
- The `aL` brand mark is functional but not visually distinctive.
- Some dense surfaces rely on truncation instead of progressive disclosure.

## Recommendations

1. Do not open the inspector by default on compact layouts.
2. Redesign the compact shell: move navigation to a bottom bar, top tab row, or collapsible menu instead of keeping the desktop rail.
3. Make Proposal Session actions part of normal document flow or reserve bottom padding equal to the sticky bar height; avoid clipping with the inspector open.
4. Give Task Board a narrow-specific composition: filters in a collapsible drawer, create task as a compact row/dialog, and board columns in an explicit horizontal scroller.
5. Reduce disabled header controls or group future features behind a menu until implemented.
6. Normalize action language so one primary sync affordance is dominant.

## Release Decision

The desktop direction is promising, but the UI should not be considered UX-ready across supported viewport sizes until the compact shell, Task Board overflow, and Proposal Session decision bar are fixed.
