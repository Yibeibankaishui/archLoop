---
name: to-ui-brief
description: Generate a design-agent-ready UI brief from current codebase, PRD, product docs, screenshots, or conversation context. Use when preparing input for a UI or design agent such as Google Stitch, Figma, or image/design tools before frontend implementation, especially when the user asks for ui_brief.md, a design prompt, a UI redesign brief, visual exploration brief, or design-agent handoff.
---

# To UI Brief

Create `ui_brief.md`: a compact, structured handoff for a design agent. Optimize for design quality, implementation fidelity, and easy comparison of multiple design directions.

## Boundaries

- Do not implement frontend code.
- Do not create issues.
- Do not convert the request into an engineering PRD; use `to-ui-implementation-prd` after design artifacts exist.
- Treat missing context as an assumption and list it explicitly.
- Prefer the project's product terminology, existing docs, design system, routes, and component names over generic wording.
- Make any pasteable prompt self-contained. A design tool such as Google Stitch cannot see local files, URLs, screenshots, PRDs, issues, or "reference" sections unless their relevant contents are summarized or embedded in the pasted text.

## Workflow

1. Gather only the context needed to brief a design agent:
   - User goal and target workflow.
   - Relevant PRD, roadmap, issue, screenshots, docs, or conversation context.
   - Current UI surface in the codebase: routes, pages, components, data fields, and existing design constraints.
   - Brand, domain, audience, and technical constraints.
2. Identify the design scope:
   - New screen, redesign, flow, dashboard, component set, mobile app, website, or marketing page.
   - Which screens/states are in scope and which are not.
3. Define the design intent:
   - User tasks and information hierarchy.
   - Visual direction, density, tone, and anti-goals.
   - Interaction requirements and state coverage.
4. Resolve references into usable context:
   - Read or inspect referenced local files, docs, screenshots, PRDs, issues, and existing UI surfaces when available.
   - Distill each relevant reference into concrete facts the design agent must know.
   - Do not rely on "see reference" wording for information needed by the design agent.
5. Produce `ui_brief.md` using the template below.
6. If the user is about to use Stitch, Figma, or another design agent, include a self-contained prompt block that can be pasted into that tool.

## Template

```markdown
# UI Brief: <feature or surface name>

## Goal

<What the design agent should help improve or create, in user-facing terms.>

## Product Context

<What this product/module does, who uses it, and why this UI matters.>

## Reference Digest

Summarize the relevant facts from files, screenshots, issues, docs, or prior conversation so the design agent does not need access to the originals.

- <Reference name>: <specific facts/design constraints/content/data extracted from it>

## Reference Index

Use this only for human traceability. Do not assume the design agent can access these sources.

- <path, URL, issue, screenshot, or note>

## Audience and Usage Context

- Primary users:
- Usage frequency:
- Environment:
- Constraints:

## Design Scope

In scope:

- <screen, flow, or component>

Out of scope:

- <explicit non-goal>

## Screens and Flow

| Screen   | Purpose         | Primary actions | Data/content     | Required states                       |
| -------- | --------------- | --------------- | ---------------- | ------------------------------------- |
| <screen> | <why it exists> | <actions>       | <fields/content> | loading, empty, error, disabled, etc. |

## Functional Requirements

- <Behavior the UI must preserve or expose.>

## Content and Data

- Key entities:
- Required fields:
- Example content:
- Empty/error copy needs:

## Existing Product and Engineering Constraints

- Existing framework/component patterns:
- Existing design system or UI library:
- Layout, routing, data, auth, or permissions constraints:
- Behaviors that must not change:

## Visual Direction

- Desired feel:
- Information density:
- Typography direction:
- Color direction:
- Motion/interaction tone:
- Anti-goals:

## Responsive and Accessibility Requirements

- Desktop:
- Tablet/mobile:
- Keyboard/focus:
- Contrast/readability:
- Screen reader/semantic needs:

## Interaction and State Requirements

- Navigation:
- Filters/search/sort:
- Forms/validation:
- Loading:
- Empty:
- Error:
- Success:
- Permission/disabled:

## Design Agent Instructions

Create 2-3 distinct design directions before converging. Preserve the functional requirements and information hierarchy. Prefer reusable UI patterns over decorative novelty.

Output:

- A `design.md` or equivalent design specification.
- Desktop and mobile reference screens.
- Design tokens: color, typography, spacing, radii, shadows, motion.
- Component mapping and interaction notes.
- State coverage for loading, empty, error, disabled, and success states.
- Asset list and source notes.
- Any tradeoffs, assumptions, and implementation risks.

## Pasteable Design-Agent Prompt

<Self-contained prompt for Stitch/Figma/etc. based on the sections above. Include the necessary reference digest inline. Do not say "see ui_brief.md", "see screenshot", "see PRD", "use the attached file", or similar unless the user will actually attach that artifact to the design tool.>

## Assumptions and Open Questions

- <Assumption or question>
```

## Quality Bar

- Make the brief specific enough that the design agent does not invent the product model.
- Keep visual direction concrete, but leave room for exploration.
- Include real data/content examples when available.
- Inline the design-critical facts from references into `Reference Digest` and `Pasteable Design-Agent Prompt`.
- Use `Reference Index` only for traceability, not as required context for the design agent.
- Ask for structured design artifacts, not only screenshots.
- Preserve implementation constraints so the chosen design can be built without reinterpreting the product.
