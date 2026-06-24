# Hub Desktop Design Contract

This document is the binding baseline for the archLoop Hub desktop UI. Later GUI work must reconcile against this contract, the selected Stitch export, and the Hub GUI v0 PRD before making visual or workflow changes.

If any future note says a screen "roughly matches" the baseline, replace that language with the contract terms below.

## Binding Sources

- Parent PRD: [`docs/prd/archloop-hub-task-board.md`](../prd/archloop-hub-task-board.md) and GitHub issue `#150`.
- Design source: [`.stitch/projects/3406577108429917875/DESIGN.md`](../../.stitch/projects/3406577108429917875/DESIGN.md).
- Reference screenshots:
  - [Project Overview](../../.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/hub_project_overview/screen.png)
  - [Task Board](../../.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/hub_task_board/screen.png)
  - [Run Workbench](../../.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/run_workbench/screen.png)
  - [Proposal Session](../../.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/proposal_session/screen.png)
- Reference HTML for spacing/copy only:
  - [Project Overview code.html](../../.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/hub_project_overview/code.html)
  - [Task Board code.html](../../.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/hub_task_board/code.html)
  - [Run Workbench code.html](../../.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/run_workbench/code.html)
  - [Proposal Session code.html](../../.stitch/projects/3406577108429917875/export/stitch_archloop_hub_control_plane/proposal_session/code.html)
- Implementation anchors:
  - [`src/hubDesktopShell.ts`](../../src/hubDesktopShell.ts)
  - [`hub-desktop/src/styles/hub-desktop.css`](../../hub-desktop/src/styles/hub-desktop.css)
  - [`src/hubProjectOverview.ts`](../../src/hubProjectOverview.ts)
  - [`src/hubTaskBoardWorkbench.ts`](../../src/hubTaskBoardWorkbench.ts)
  - [`src/hubRunWorkbench.ts`](../../src/hubRunWorkbench.ts)
  - [`src/hubProposalWorkbench.ts`](../../src/hubProposalWorkbench.ts)

## In Scope

- Hub Project Overview.
- Hub Task Board.
- Run Workbench.
- Proposal Session.

## Out of Scope

- The historical static `gui/` prototype.
- Any MCP-only duplicate overview surface that does not participate in the desktop shell contract.
- Docs-site navigation, marketing surfaces, and non-operational landing pages.
- Replacing the local Beads task store or the remote task-source sync model.

## Visual Baseline

- Desktop-first, dense, multi-pane operations console.
- Left navigation rail, top header, main work area, and optional right inspector drawer.
- 4px spacing grid with 12px panel padding and 60px rail / 52px header / 380px inspector sizing.
- 1px low-contrast borders instead of decorative shadows.
- Terminal and event panes should use a deep midnight surface with monospace text.
- Status chips should remain compact and semantic, not decorative.
- The selected Stitch screenshots are the layout and hierarchy baseline; responsive implementations may reflow them, but they must preserve the same information ordering and density.

## Token Baseline

| Token family              | Baseline                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Background / surface      | Light neutral surfaces with `#f8fafc` background and white panels                        |
| Borders                   | Subtle slate borders, typically `#e2e8f0`                                                |
| Primary text              | Near-black slate (`#0f172a`)                                                             |
| Muted text                | Slate gray (`#64748b`)                                                                   |
| Ready / local success     | Emerald (`#059669`)                                                                      |
| Active / executing        | Indigo (`#4f46e5`)                                                                       |
| Warning / needs attention | Amber (`#d97706`)                                                                        |
| Failed / conflict         | Rose (`#e11d48`)                                                                         |
| Terminal                  | Deep midnight (`#020617`)                                                                |
| Typography                | Geist for headings, Inter for UI text, JetBrains Mono for ids, branches, paths, and logs |
| Radius                    | 4px default, 6-8px outer containers, square terminals/log panes                          |
| Elevation                 | Borders and tonal layers first; soft shadow only for drawers/popovers                    |

## Visible Command Matrix

The matrix below classifies the visible command surface that the four contract screens expose.

| Screen           | Visible command / control                                                                              | Classification                                          | Contract note                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Overview         | Section navigation (Project / Run / Batch in the Stitch reference, or the equivalent shell navigation) | Local navigation                                        | Changes screen context only.                                              |
| Overview         | Initialize task store                                                                                  | CLI-only, disabled with reason when already initialized | `archloop tasks init` remains the recovery path.                          |
| Overview         | Preview push                                                                                           | Bridge preview                                          | Must show preview summary before confirm.                                 |
| Overview         | Preview pull                                                                                           | Bridge preview                                          | Must show preview summary before confirm.                                 |
| Overview         | Review agent config                                                                                    | CLI-only, read-only surface                             | The desktop can summarize config state, but v0 keeps writes in the CLI.   |
| Overview         | Recover failed task                                                                                    | Bridge preview                                          | Uses the selected failed task id and must keep the CLI fallback visible.  |
| Task Board       | Search, status filter, claim filter, sync filter                                                       | Local board state controls                              | Pure UI controls, no CLI fallback needed.                                 |
| Task Board       | Initialize task store                                                                                  | CLI-only, disabled with reason                          | Same CLI fallback as Overview.                                            |
| Task Board       | Preview push                                                                                           | Bridge preview                                          | Must keep remote sync separate from local proposal approval.              |
| Task Board       | Preview pull                                                                                           | Bridge preview                                          | Must keep remote sync separate from local proposal approval.              |
| Task Board       | Add comment                                                                                            | CLI-only, reasoned fallback                             | Readable Beads comment, not a status change.                              |
| Task Board       | Recover selected failed task                                                                           | Bridge preview                                          | Only when a failed task is selected.                                      |
| Task Board       | Open remote ref                                                                                        | CLI-only, read-only fallback                            | Opens the remote source, not the desktop shell.                           |
| Task Board       | Open run directory                                                                                     | CLI-only, read-only fallback                            | Run directory navigation stays CLI-first in v0.                           |
| Run Workbench    | Run / batch selector                                                                                   | Local run focus control                                 | Changes the selected run context only.                                    |
| Run Workbench    | Resume merge                                                                                           | CLI-only, disabled with reason unless merge-ready       | The contract allows this as a CLI-backed recovery path in v0.             |
| Run Workbench    | Cancel run                                                                                             | CLI-only, disabled with reason                          | No desktop confirm path in v0.                                            |
| Run Workbench    | Recover failed task                                                                                    | Bridge preview                                          | Uses the selected failed task metadata.                                   |
| Proposal Session | Run / proposal selector                                                                                | Local session focus control                             | Changes the selected proposal artifact only.                              |
| Proposal Session | Approve & Apply to Beads                                                                               | Bridge preview-confirm                                  | Previews local Beads writes and requires confirmation before local apply. |
| Proposal Session | Reject                                                                                                 | Disabled with reason                                    | Re-open the proposal session from the CLI to cancel or restart.           |
| Proposal Session | Revise                                                                                                 | Disabled with reason                                    | Re-enter the proposal session loop from the CLI.                          |

## Contract Rules

- Proposal approval never implies remote GitHub mutation.
- Remote sync actions must remain preview/confirm gated where a bridge path exists.
- Primary visible CTAs must never become unexplained CLI-only fallbacks; if v0 cannot provide a desktop action path, the control must be preview-confirm gated or disabled with a reason that names the CLI recovery path.
- Claim state must remain metadata, not a task status.
- The four canonical screens are the only in-scope desktop baseline for this contract.

## Accepted Deviations

- Responsive breakpoints may stack or collapse panes to preserve readability.
- Exact Stitch-generated pixel sizes may shift slightly to fit the implementation stack.
- Class names, markup structure, and component decomposition may differ from the exported HTML.
- Additional loading, empty, error, disabled, and accessibility states may be added beyond the screenshots.
- Typography may normalize to the repo's frontend conventions as long as the hierarchy stays intact.

## Evidence Checklist

When this contract changes, record evidence in the QA run documents:

- Contract markdown path.
- Source artifact inventory.
- Baseline screenshot paths.
- Accepted deviations.
