export const HUB_DESKTOP_NAV_SECTIONS = [
  "overview",
  "task-board",
  "run-workbench",
  "proposal-session",
] as const;

export type HubDesktopNavSection = (typeof HUB_DESKTOP_NAV_SECTIONS)[number];

export const HUB_DESKTOP_LAYOUT = {
  railWidthPx: 60,
  headerHeightPx: 52,
  inspectorWidthPx: 380,
  narrowBreakpointPx: 960,
  compactBreakpointPx: 720,
} as const;

export const HUB_DESKTOP_FOCUS_RING_CLASS = "hub-focus-ring";

export const HUB_DESKTOP_TOKENS = {
  background: "#f8fafc",
  surface: "#ffffff",
  border: "#e2e8f0",
  text: "#0f172a",
  textMuted: "#64748b",
  accent: "#2563eb",
  ready: "#059669",
  active: "#4f46e5",
  warning: "#d97706",
  danger: "#e11d48",
  terminal: "#020617",
} as const;

export const isHubDesktopNavSection = (
  value: string,
): value is HubDesktopNavSection =>
  (HUB_DESKTOP_NAV_SECTIONS as readonly string[]).includes(value);

export const resolveHubDesktopLayoutMode = (
  viewportWidth: number,
): "desktop" | "tablet" | "compact" => {
  if (viewportWidth < HUB_DESKTOP_LAYOUT.compactBreakpointPx) {
    return "compact";
  }
  if (viewportWidth < HUB_DESKTOP_LAYOUT.narrowBreakpointPx) {
    return "tablet";
  }
  return "desktop";
};

export const shouldCollapseInspector = (viewportWidth: number): boolean =>
  viewportWidth < HUB_DESKTOP_LAYOUT.narrowBreakpointPx;

export const hubDesktopNavLabel = (section: HubDesktopNavSection): string => {
  switch (section) {
    case "overview":
      return "Overview";
    case "task-board":
      return "Task Board";
    case "run-workbench":
      return "Run Workbench";
    case "proposal-session":
      return "Proposal Session";
  }
};

export const hubDesktopShellGridStyle = (
  viewportWidth: number,
): Record<string, string> => {
  const mode = resolveHubDesktopLayoutMode(viewportWidth);
  if (mode === "compact") {
    return {
      gridTemplateColumns: "1fr",
      gridTemplateAreas: '"header" "main"',
    };
  }
  if (mode === "tablet") {
    return {
      gridTemplateColumns: `${HUB_DESKTOP_LAYOUT.railWidthPx}px 1fr`,
      gridTemplateAreas: '"rail header" "rail main"',
    };
  }
  return {
    gridTemplateColumns: `${HUB_DESKTOP_LAYOUT.railWidthPx}px 1fr ${HUB_DESKTOP_LAYOUT.inspectorWidthPx}px`,
    gridTemplateAreas: '"rail header header" "rail main inspector"',
  };
};
