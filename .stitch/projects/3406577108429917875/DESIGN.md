---
name: Autonomous Engineering Control Plane
colors:
  surface: "#f8f9ff"
  surface-dim: "#cbdbf5"
  surface-bright: "#f8f9ff"
  surface-container-lowest: "#ffffff"
  surface-container-low: "#eff4ff"
  surface-container: "#e5eeff"
  surface-container-high: "#dce9ff"
  surface-container-highest: "#d3e4fe"
  on-surface: "#0b1c30"
  on-surface-variant: "#45464d"
  inverse-surface: "#213145"
  inverse-on-surface: "#eaf1ff"
  outline: "#76777d"
  outline-variant: "#c6c6cd"
  surface-tint: "#565e74"
  primary: "#000000"
  on-primary: "#ffffff"
  primary-container: "#131b2e"
  on-primary-container: "#7c839b"
  inverse-primary: "#bec6e0"
  secondary: "#0058be"
  on-secondary: "#ffffff"
  secondary-container: "#2170e4"
  on-secondary-container: "#fefcff"
  tertiary: "#000000"
  on-tertiary: "#ffffff"
  tertiary-container: "#271901"
  on-tertiary-container: "#98805d"
  error: "#ba1a1a"
  on-error: "#ffffff"
  error-container: "#ffdad6"
  on-error-container: "#93000a"
  primary-fixed: "#dae2fd"
  primary-fixed-dim: "#bec6e0"
  on-primary-fixed: "#131b2e"
  on-primary-fixed-variant: "#3f465c"
  secondary-fixed: "#d8e2ff"
  secondary-fixed-dim: "#adc6ff"
  on-secondary-fixed: "#001a42"
  on-secondary-fixed-variant: "#004395"
  tertiary-fixed: "#fcdeb5"
  tertiary-fixed-dim: "#dec29a"
  on-tertiary-fixed: "#271901"
  on-tertiary-fixed-variant: "#574425"
  background: "#f8f9ff"
  on-background: "#0b1c30"
  surface-variant: "#d3e4fe"
typography:
  display-sm:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: "600"
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: "600"
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: "400"
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: "400"
    lineHeight: 16px
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: "450"
    lineHeight: 18px
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: "450"
    lineHeight: 14px
  label-caps:
    fontFamily: Geist
    fontSize: 10px
    fontWeight: "700"
    lineHeight: 12px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  stack-xs: 4px
  stack-sm: 8px
  stack-md: 16px
  panel-padding: 12px
  gutter: 1px
  container-max: 100%
---

## Brand & Style

The design system for this developer tool is rooted in the "Reliable
Automated Engineer" persona. It prioritizes clarity, auditability, and
operational stability over decorative aesthetics. The visual language is
**Corporate/Modern** with a heavy influence from **Minimalism** to manage high
information density.

The UI should feel like a high-precision instrument. It avoids "AI" tropes
(gradients, sparkles, chat bubbles) in favor of a structural, multi-pane
architecture reminiscent of modern IDEs and industrial control systems. The
emotional response is one of calm control: the user is an overseer of complex
automated workflows, not a casual participant in a conversation.

## Colors

The palette is a disciplined scale of Slate and Gray. The background uses
high-value grays (`#F8FAFC`) to provide a clean canvas for dense data.

**Semantic Color Roles:**

- **Primary:** Slate-900 for text and structural borders to anchor the layout.
- **Ready/Agent:** Emerald-500/600 for available resources and ready states.
- **Active/Implementing:** Indigo-500 for ongoing "Flows" and "Worktree
  Leases."
- **Blocked/Needs Info:** Amber-500 for tasks requiring manual intervention.
- **Failed/Conflict:** Rose-500 for runtime errors or merge conflicts.
- **Done:** Slate-900/Neutral-Dark to indicate a completed, non-active state.
- **Terminal:** Deep Midnight (`#020617`) with high-contrast Slate-50 text for
  monospaced event streams and logs.

## Typography

The system uses a dual-font approach to distinguish between UI controls and
technical data.

- **UI Sans (Geist/Inter):** Used for navigation, panel titles, and descriptive
  text. Geist is used for headlines to provide a sharp, modern engineering
  feel.
- **Technical Mono (JetBrains Mono):** Used for all "Local Task Store" IDs,
  "Remote Task Source" URLs, file paths in the "Run Directory," and event logs.
- **Information Density:** Body text is set at 14px (md) and 12px (sm) to allow
  for the display of complex information without excessive scrolling. Use
  `label-caps` for table headers and section metadata.

## Layout & Spacing

This is a **fluid, multi-pane layout** optimized for large desktop displays. It
utilizes a systematic 4px grid.

- **Split Panes:** The core interface consists of a persistent left sidebar for
  "Hub Projects," a main operational center (Task Board/Timeline), and a
  collapsible right "Inspector Drawer" for details on specific "Worktree
  Leases."
- **Borders as Dividers:** Use 1px Slate-200 borders instead of heavy margins
  to separate panels, maximizing usable screen real estate.
- **Density:** Padding within list items and table cells is kept tight (8px
  horizontal, 4px vertical) to facilitate rapid scanning of large task volumes.

## Elevation & Depth

The design system utilizes **Low-contrast outlines** and **Tonal Layers** to
establish hierarchy, rather than traditional shadows.

- **Level 0 (Background):** Slate-50.
- **Level 1 (Panels/Cards):** White with 1px Slate-200 border.
- **Level 2 (Drawers/Popovers):** White with a subtle 1px Slate-300 border and
  a very soft, functional shadow (0 4px 12px rgba(0,0,0,0.05)).
- **Active State:** A 2px Indigo-500 left-border accent on a selected list item
  or card indicates focus within a "Flow."

## Shapes

The shape language is precise and geometric.

- **Standard Radius:** 4px for most UI components (buttons, inputs, cards) to
  maintain a crisp, professional aesthetic.
- **Large Radius:** 6px (rounded-lg) is reserved for primary outer containers or
  the main Task Board canvas.
- **Terminal:** Square corners (0px) are acceptable for code blocks and
  monospaced log streams to reinforce the "raw data" feel.

## Components

### Buttons & Inputs

- **Action Buttons:** Small (28px height) or Medium (32px height) with 4px
  radius. Primary buttons use Slate-900; secondary use a White/Slate-200 border
  combo.
- **Terminal Inputs:** Monospaced text inside a Slate-900 background for "Remote
  Task Source" filtering or CLI-style command entry.

### Status Chips

- **Compact Chips:** Used for "Ready," "Active," "Blocked," and "Failed." These
  consist of a small 6px solid dot indicator and a label in `mono-sm`
  typography.
- **Backgrounds:** Use very light tinted backgrounds (e.g., Emerald-50) with
  high-contrast text for visibility.

### Tables & Lists

- **Compact Tables:** For the "Local Task Store." Row hover states use Slate-50.
  No vertical grid lines, only subtle horizontal separators.
- **Timeline:** A vertical monospaced event stream using `mono-sm`. Connection
  lines between events should be 1px Slate-300.

### Inspector Drawers

- **Contextual Detail:** Slides from the right. Contains "Run Directory" file
  trees and "Worktree Lease" metadata. Header must include a "Done" status
  indicator and a unique ID in monospaced font.

### Panes

- **Resizable Dividers:** 1px borders that change to Indigo-500 on hover to
  indicate interactivity.
