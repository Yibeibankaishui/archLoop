---
name: to-ui-brief
description: Generate a design-agent-ready UI brief from current codebase, PRD, product docs, screenshots, or conversation context. Use when preparing input for a UI or design agent such as Google Stitch, Figma, or image/design tools before frontend implementation, especially when the user asks for ui_brief.md, a design prompt, a UI redesign brief, visual exploration brief, or design-agent handoff.
---

# To UI Brief

Create `ui_brief.md`: a compact, structured handoff for a design agent. Optimize for design quality, UX focus, information architecture, implementation fidelity, and easy comparison of multiple design directions.

## Boundaries

- Do not implement frontend code.
- Do not create issues.
- Do not convert the request into an engineering PRD; use `to-ui-implementation-prd` after design artifacts exist.
- Treat missing context as an assumption and list it explicitly.
- Prefer the project's product terminology, existing docs, design system, routes, and component names over generic wording.
- Make any pasteable prompt self-contained. A design tool such as Google Stitch cannot see local files, URLs, screenshots, PRDs, issues, or "reference" sections unless their relevant contents are summarized or embedded in the pasted text.
- Do not produce a feature inventory dump. Force a primary user job, priority ladder, screen narrative, and explicit deferred content so the design agent composes an experience instead of stacking every element.

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
4. Define the UX strategy before visual style:
   - Primary user job, primary decision/action, and what should be visually dominant.
   - What belongs above the fold, what is secondary, and what should be deferred.
   - The reading/action order for each primary screen.
   - The design concept or composition thesis that organizes the screen.
5. Resolve references into usable context:
   - Read or inspect referenced local files, docs, screenshots, PRDs, issues, and existing UI surfaces when available.
   - Distill each relevant reference into concrete facts the design agent must know.
   - Do not rely on "see reference" wording for information needed by the design agent.
6. Produce `ui_brief.md` using the template below.
7. If the user is about to use Stitch, Figma, or another design agent, include a self-contained prompt block that can be pasted into that tool.

## Template

````markdown
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

## UX Strategy

- Primary user job:
- Moment this UI must improve:
- Desired user decision/action:
- Success metric or quality signal:
- Primary CTA:
- Secondary actions:
- Explicitly deferred actions/content:
- What must be understood in the first 5 seconds:

## Design Concept

- Named concept:
- Composition principle:
- Visual anchor:
- Rhythm:
- Density strategy:
- Trust/clarity cues:
- Anti-patterns to avoid:

## Priority Ladder

1. Hero/primary information:
2. Supporting context:
3. Secondary controls:
4. Advanced or rare actions:
5. Hidden/deferred content:

## Information Architecture

- Navigation model:
- Main screen regions:
- Above-the-fold content:
- Grouping rules:
- Progressive disclosure:
- What should not appear together:

## Screen Narrative

For each primary screen, describe the intended reading/action order.

| Screen   | First glance                      | Scan path        | Decision point     | Primary action    | Feedback/next state |
| -------- | --------------------------------- | ---------------- | ------------------ | ----------------- | ------------------- |
| <screen> | <what the user understands first> | <ordered groups> | <what they decide> | <dominant action> | <resulting state>   |

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

- How this supports the design concept:
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

## Prompt Constraints

- Design one primary screen or one short flow at a time unless the user explicitly asks for a full app.
- Do not display every requirement, state, filter, and action simultaneously.
- Loading, empty, error, disabled, permission, and success states should be separate variants, not all visible in the default screen.
- Give one action or decision clear visual dominance.
- Use progressive disclosure for secondary or advanced controls.
- Avoid card grids unless the product model is actually a collection of peer items.
- Do not mix multiple design directions into one screen.
- Avoid stacked cards, equal-weight panels, decorative sections, and visible controls that are not needed for the primary user job.

## Design Agent Instructions

If exploring multiple directions, produce them as separate named alternatives. Each direction must have one concept, one primary screen composition, and a clear priority ladder. Do not merge alternatives into a single layout.

Preserve the functional requirements and information hierarchy. Prefer reusable UI patterns over decorative novelty. Compose the experience around the primary user job; do not simply render every requirement as a visible component.

Output:

- A `design.md` or equivalent design specification.
- Desktop and mobile reference screens.
- Design tokens: color, typography, spacing, radii, shadows, motion.
- Component mapping and interaction notes.
- State coverage for loading, empty, error, disabled, and success states.
- Asset list and source notes.
- Any tradeoffs, assumptions, and implementation risks.

## Pasteable Design-Agent Prompt

Use this structure for Stitch/Figma/etc. Keep it self-contained and include the necessary reference digest inline. Do not say "see ui_brief.md", "see screenshot", "see PRD", "use the attached file", or similar unless the user will actually attach that artifact to the design tool.

```markdown
Design a focused UI direction for <product/surface>.

Product context:
<1-3 sentences about what the product does and why this screen matters.>

Primary user:
<Who uses it, their expertise level, frequency, and environment.>

Primary UX job:
The screen must help the user <do one concrete job>. The most important outcome is <decision/action/result>.

Design concept:
Use the concept "<named concept>". The layout should feel like <composition metaphor, e.g. "a focused review console with one dominant work area and a compact decision rail">.

Priority ladder:

1. Most important: <content/action that must dominate>
2. Supporting: <context needed to make the decision>
3. Secondary: <tools/actions available but visually quieter>
4. Deferred: <advanced/rare items hidden behind tabs, drawer, menu, or secondary screen>

Information architecture:

- Primary region: <main content/work area>
- Secondary region: <context, summary, metadata, or controls>
- Navigation: <tabs/sidebar/topbar/etc.>
- Above the fold: show only <specific content>
- Do not show <things that should not appear together>

Screen narrative:
First glance: user understands <main status/value>.
Then they scan <ordered groups>.
Then they choose <primary action>.
After action, show <feedback/next state>.

Required content:

- <realistic data/content examples>
- <required fields>
- <required actions>

States:
Design the default state first. Include loading, empty, error, disabled, permission, and success as separate variants or notes, not visible in the default screen.

Visual direction:

- Density: <quiet/dense/spacious/etc.>
- Typography: <specific direction>
- Color: <role-based guidance, not just palette>
- Components: <preferred components/patterns>
- Avoid: stacked cards, equal-weight panels, decorative sections, showing all controls at once.

Output:
Create one desktop screen and one mobile adaptation for this single direction. Include concise notes explaining hierarchy, layout regions, and why secondary elements are deferred.
```
````

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
- Verify the brief says what the user should do first.
- Verify the brief says what is less important and should be deferred.
- Verify the brief defines screen regions and reading order.
- Verify the default screen does not include every state at once.
- Verify the design concept is more specific than a visual mood.
- Verify the pasteable prompt can produce a composed screen, not an inventory dump.
```
