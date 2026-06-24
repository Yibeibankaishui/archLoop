import { describe, expect, it } from "vitest";

import {
  HUB_DESKTOP_FOCUS_RING_CLASS,
  HUB_DESKTOP_NAV_SECTIONS,
  HUB_DESKTOP_SHELL_TABS,
  HUB_DESKTOP_TOKENS,
  HUB_DESKTOP_TYPOGRAPHY,
  hubDesktopNavLabel,
  hubDesktopShellGridStyle,
  isHubDesktopNavSection,
  resolveHubDesktopLayoutMode,
  shouldCollapseInspector,
} from "./hubDesktopShell.js";

describe("hubDesktopShell", () => {
  it("exposes Stitch-aligned light console tokens", () => {
    expect(HUB_DESKTOP_TOKENS.background).toBe("#f8fafc");
    expect(HUB_DESKTOP_TOKENS.text).toBe("#0f172a");
    expect(HUB_DESKTOP_TOKENS.terminal).toBe("#020617");
  });

  it("navigates across the four primary Hub sections", () => {
    for (const section of HUB_DESKTOP_NAV_SECTIONS) {
      expect(isHubDesktopNavSection(section)).toBe(true);
      expect(hubDesktopNavLabel(section).length).toBeGreaterThan(0);
    }
    expect(isHubDesktopNavSection("settings")).toBe(false);
  });

  it("collapses the inspector on narrow viewports without changing desktop grid", () => {
    expect(resolveHubDesktopLayoutMode(1440)).toBe("desktop");
    expect(shouldCollapseInspector(1440)).toBe(false);
    expect(hubDesktopShellGridStyle(1440).gridTemplateAreas).toContain(
      "inspector",
    );

    expect(resolveHubDesktopLayoutMode(800)).toBe("tablet");
    expect(shouldCollapseInspector(800)).toBe(true);
    expect(hubDesktopShellGridStyle(800).gridTemplateAreas).not.toContain(
      "inspector",
    );

    expect(resolveHubDesktopLayoutMode(640)).toBe("compact");
    expect(hubDesktopShellGridStyle(640).gridTemplateAreas).toBe(
      '"header" "main"',
    );
  });

  it("defines a shared focus ring class for keyboard navigation", () => {
    expect(HUB_DESKTOP_FOCUS_RING_CLASS).toBe("hub-focus-ring");
  });

  it("publishes shared typography tokens and shell tabs", () => {
    expect(HUB_DESKTOP_TYPOGRAPHY.heading).toContain("Geist");
    expect(HUB_DESKTOP_TYPOGRAPHY.body).toContain("Inter");
    expect(HUB_DESKTOP_TYPOGRAPHY.mono).toContain("JetBrains Mono");
    expect(HUB_DESKTOP_SHELL_TABS.map((tab) => tab.label)).toEqual([
      "Project",
      "Run",
      "Batch",
    ]);
  });
});
