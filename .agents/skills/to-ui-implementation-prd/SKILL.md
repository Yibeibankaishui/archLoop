---
name: to-ui-implementation-prd
description: Convert selected UI design-agent outputs into an engineering-ready UI implementation PRD compatible with to-prd and to-issues workflows. Use after design artifacts exist, such as Figma files, Google Stitch output, design.md, screenshots, exported HTML/CSS, tokens, asset lists, or design review notes, and before creating implementation issues or asking a coding agent to build the UI.
---

# To UI Implementation PRD

Create a UI implementation PRD from selected design artifacts. The PRD translates visual design intent into engineering decisions, testable behavior, and issue-ready implementation scope.

## Boundaries

- Do not implement code.
- Do not create issues directly unless the user explicitly asks; hand the PRD to `to-issues` for tracer-bullet issue slicing.
- Do not treat design-agent generated code as production-ready by default.
- Treat screenshots as visual references, not as complete specifications.
- If multiple design directions exist and none is selected, ask the user to choose or produce a short design review section before writing the final PRD.
- Mark unresolved design or engineering decisions as HITL candidates for `to-issues`.

## Workflow

1. Gather design artifacts:
   - `design.md`, Figma links/files, Stitch output, screenshots, exported HTML/CSS, tokens, assets, and design review notes.
   - The original `ui_brief.md` if available.
   - Relevant codebase context: existing components, design system, routes, state management, data contracts, tests, and constraints.
2. Normalize the design:
   - Identify selected direction and source artifacts.
   - Extract screens, component hierarchy, content model, tokens, interactions, responsive rules, and required states.
   - Separate must-match requirements from reference-only visual ideas.
3. Reconcile with implementation reality:
   - Map design elements to existing components or new components.
   - Note acceptable deviations from the design and why.
   - Flag missing states, impossible layouts, asset/licensing gaps, accessibility gaps, and data/API assumptions.
4. Produce a PRD using the template below.
5. If the user wants implementation tickets, pass the PRD to `to-issues` and prefer vertical slices that are demoable end to end.

## PRD Template

Use these exact top-level sections for compatibility with the existing `to-prd` and `to-issues` flow.

```markdown
# UI Implementation PRD: <feature or surface name>

## Problem Statement

<The current user-facing UI problem and why the selected design matters.>

## Solution

<The selected design direction and the user experience it should create. Reference the source artifacts and summarize the intended end state.>

Selected design source:

- <Figma/Stitch/design.md/screenshot/link>

## User Stories

1. As a <actor>, I want <feature or UI behavior>, so that <benefit>.
2. As a <actor>, I want <state or responsive behavior>, so that <benefit>.

Include stories for:

- Primary happy path.
- Navigation and core interactions.
- Loading, empty, error, success, disabled, and permission states.
- Desktop and mobile/tablet responsive behavior.
- Keyboard, focus, readability, and accessibility behavior.
- Any visual comparison or design review needs.

## Implementation Decisions

Design source of truth:

- <Which artifact wins when sources conflict.>

Component mapping:

| Design element | Existing/new component | Required behavior | Notes                    |
| -------------- | ---------------------- | ----------------- | ------------------------ |
| <element>      | <component>            | <behavior>        | <constraints/deviations> |

Design tokens:

- Color:
- Typography:
- Spacing:
- Radius:
- Elevation/shadow:
- Motion:

Layout and responsive rules:

- Desktop:
- Tablet:
- Mobile:
- Overflow/scrolling:

State and interaction rules:

- Loading:
- Empty:
- Error:
- Success:
- Disabled/permission:
- Hover/focus/active:
- Form validation:

Data and content rules:

- Required data:
- Example copy:
- Formatting:
- Localization considerations:

Assets:

- Required assets:
- Source/licensing notes:
- Fallbacks:

Acceptable deviations from design:

- <Deviation and rationale.>

Open implementation decisions:

- <Decision needing user/design/engineering input.>

## Testing Decisions

Test external behavior, not implementation details.

Modules/surfaces to test:

- <Screen/component/flow>

Required test coverage:

- Happy path interaction.
- Loading, empty, error, disabled, and permission states.
- Desktop and mobile rendering.
- Keyboard navigation and focus visibility.
- Accessibility checks for semantics, labels, contrast, and reduced motion where relevant.
- Screenshot or visual regression checks when visual fidelity is central to the request.

Prior art:

- <Existing tests or similar flows in the repo, if known.>

## Out of Scope

- <Explicit non-goal, such as backend changes, redesigning unrelated screens, or replacing the design system.>

## Further Notes

Design artifacts:

- <Links/paths>

Implementation risks:

- <Risk>

Suggested `to-issues` slicing hints:

- <Thin vertical slice that can be demoed independently.>

HITL checkpoints:

- <Design review, unresolved decision, or visual approval point.>
```

## Quality Bar

- Preserve the design intent without blindly copying exported code.
- Convert visual choices into components, tokens, states, and responsive rules.
- Make enough decisions that `to-issues` can produce independent vertical slices.
- Keep unresolved questions explicit instead of hiding them inside vague acceptance language.
- Prefer existing project components and patterns unless the selected design requires a justified extension.
