import { describe, expect, it } from "vitest";
import { visibleLength } from "./ansi.js";
import {
  flattenSectionForLog,
  renderSection,
  type SectionBlock,
} from "./section.js";

const WIDTHS = [40, 80, 100, 120] as const;
const COLOR_MODES = [true, false] as const;

const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

const sampleBlocks: Record<string, SectionBlock> = {
  header: {
    kind: "header",
    title: "archLoop",
    subtitle: "autotuneagent",
    right: "21 tasks",
  },
  divider: { kind: "divider" },
  badges: {
    kind: "badges",
    badges: [
      { symbol: "●", count: 2, label: "todo", severity: "info" },
      { symbol: "◐", count: 1, label: "in_progress", severity: "warn" },
      { symbol: "✓", count: 5, label: "done", severity: "success" },
    ],
  },
  group: {
    kind: "group",
    symbol: "✓",
    severity: "success",
    name: "done",
    count: 21,
    rightHint: "showing 5 · archloop tasks list --all",
    items: [
      {
        id: "AutoTuneAgent-0b7",
        title:
          "Slice 2 · Expand Report Fragment columns (drift + latency metrics)",
        trailingDim: "⚠ prd-warn",
      },
      {
        id: "AutoTuneAgent-0g4",
        title: "Slice 1 · Divergence fail path",
      },
    ],
    footerDim: "… 16 more",
  },
  kv: {
    kind: "kv",
    gutter: 12,
    rows: [
      {
        key: "title",
        value:
          "Slice 2 · Remove TaskOrchestrator and legacy Test Task model from the run pipeline",
      },
      {
        key: "status",
        value: "in_progress",
        secondary: "(beads: in_progress)",
      },
      { key: "remote", value: "github#182" },
    ],
  },
  prose: {
    kind: "prose",
    title: "description",
    body: "We still keep a shadow TaskOrchestrator alongside the new HubRunner. Slice 2 deletes it and rewires the two remaining call sites in the CLI.",
  },
  "indented-block": {
    kind: "indented-block",
    leading: "↳",
    leadingSeverity: "info",
    id: "AutoTuneAgent-2mr",
    title:
      "Slice 2 · Remove TaskOrchestrator and legacy Test Task model from the run pipeline",
    subLines: ["implementing · 3m12s in this step"],
  },
  footer: {
    kind: "footer",
    label: "tip",
    commands: ["archloop tasks show <id>", "archloop tasks pull"],
  },
};

describe("renderSection", () => {
  it("is a pure function returning string[] with no stdout side effects", () => {
    const lines = renderSection("", [sampleBlocks.header!], {
      width: 80,
      colorEnabled: false,
    });
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.every((l) => typeof l === "string")).toBe(true);
  });

  it("defaults width to 100 when undefined and floors/caps via resolve", () => {
    const atDefault = renderSection("", [{ kind: "divider" }], {
      colorEnabled: true,
    });
    const at100 = renderSection("", [{ kind: "divider" }], {
      width: 100,
      colorEnabled: true,
    });
    expect(atDefault).toEqual(at100);

    const atOver = renderSection("", [{ kind: "divider" }], {
      width: 200,
      colorEnabled: true,
    });
    const at120 = renderSection("", [{ kind: "divider" }], {
      width: 120,
      colorEnabled: true,
    });
    expect(atOver).toEqual(at120);
  });

  it("applies a two-space left margin on content lines", () => {
    const lines = renderSection(
      "",
      [{ kind: "header", title: "archLoop" }],
      { width: 80, colorEnabled: false },
    );
    expect(lines[0]!.startsWith("  ")).toBe(true);
  });

  it("emits an optional title line when title is non-empty", () => {
    const lines = renderSection("board", [{ kind: "header", title: "x" }], {
      width: 80,
      colorEnabled: false,
    });
    expect(stripAnsi(lines[0]!)).toBe("  board");
  });

  describe.each(
    Object.entries(sampleBlocks).map(([kind, block]) => ({ kind, block })),
  )("$kind", ({ kind, block }) => {
    it.each(
      WIDTHS.flatMap((width) =>
        COLOR_MODES.map((colorEnabled) => ({ width, colorEnabled })),
      ),
    )(
      "renders at width=$width colorEnabled=$colorEnabled",
      ({ width, colorEnabled }) => {
        const lines = renderSection("", [block], { width, colorEnabled });

        // divider is omitted entirely under plain / no-color
        if (kind === "divider" && !colorEnabled) {
          expect(lines).toEqual([]);
          return;
        }

        expect(lines.length).toBeGreaterThan(0);

        for (const line of lines) {
          // Visible width must not exceed the resolved column budget
          expect(visibleLength(line)).toBeLessThanOrEqual(width);
        }

        const plain = lines.map(stripAnsi).join("\n");

        if (colorEnabled) {
          // At least one ANSI sequence for colored kinds that use styling
          if (kind !== "divider") {
            const joined = lines.join("\n");
            expect(joined).toMatch(/\x1b\[/);
          }
        } else {
          // No color/bold/dim escapes; symbols and indentation survive
          expect(lines.join("\n")).not.toMatch(/\x1b\[/);
        }

        // Kind-specific content anchors (symbols / labels survive all modes)
        switch (kind) {
          case "header":
            expect(plain).toContain("archLoop");
            expect(plain).toContain("21 tasks");
            break;
          case "divider":
            expect(plain).toMatch(/─+/);
            break;
          case "badges":
            expect(plain).toContain("●");
            expect(plain).toContain("todo");
            expect(plain).toContain("◐");
            expect(plain).toContain("✓");
            break;
          case "group":
            expect(plain).toContain("✓");
            expect(plain).toContain("done · 21");
            expect(plain).toContain("AutoTuneAgent-0b7");
            expect(plain).toContain("… 16 more");
            break;
          case "kv":
            expect(plain).toContain("title");
            expect(plain).toContain("status");
            expect(plain).toContain("in_progress");
            break;
          case "prose":
            expect(plain).toContain("description");
            expect(plain).toContain("TaskOrchestrator");
            break;
          case "indented-block":
            expect(plain).toContain("↳");
            expect(plain).toContain("AutoTuneAgent-2mr");
            expect(plain).toContain("implementing");
            expect(plain).toContain("3m12s");
            break;
          case "footer":
            expect(plain).toContain("tip");
            expect(plain).toContain("archloop tasks show <id>");
            expect(plain).toContain("archloop tasks pull");
            break;
        }
      },
    );
  });

  it("tail-truncates long group titles with …", () => {
    const lines = renderSection(
      "",
      [
        {
          kind: "group",
          symbol: "●",
          severity: "info",
          name: "todo",
          count: 1,
          items: [
            {
              id: "short-id",
              title:
                "This is an extremely long task title that must be truncated at narrow widths so the line does not overflow the terminal",
            },
          ],
        },
      ],
      { width: 40, colorEnabled: false },
    );
    const body = lines.slice(1).join("\n");
    expect(body).toContain("…");
    expect(visibleLength(lines[1]!)).toBeLessThanOrEqual(40);
  });

  it("rejects a fourth footer label at the type level via closed union", () => {
    const tip: SectionBlock = {
      kind: "footer",
      label: "tip",
      commands: ["a"],
    };
    const next: SectionBlock = {
      kind: "footer",
      label: "next",
      command: "archloop tasks list",
    };
    const fix: SectionBlock = {
      kind: "footer",
      label: "fix",
      command: "archloop run --resume x --only-failed",
    };
    expect(tip.kind).toBe("footer");
    expect(next.kind).toBe("footer");
    expect(fix.kind).toBe("footer");
    // @ts-expect-error — fourth label is not in the closed set
    const bad: SectionBlock = { kind: "footer", label: "summary", command: "x" };
    void bad;
  });
});

describe("flattenSectionForLog", () => {
  it("flattens all 8 kinds to plain grep-friendly text without dividers", () => {
    const blocks = Object.values(sampleBlocks);
    const lines = flattenSectionForLog(blocks);
    const text = lines.join("\n");

    expect(text).not.toMatch(/─/);
    expect(text).not.toMatch(/\x1b\[/);
    expect(text).toContain("archLoop · autotuneagent    21 tasks");
    expect(text).toContain("● 2 todo");
    expect(text).toContain("AutoTuneAgent-0b7");
    expect(text).toContain("title: Slice 2");
    expect(text).toContain("description");
    expect(text).toContain("↳ AutoTuneAgent-2mr");
    expect(text).toContain("tip   archloop tasks show <id>   ·   archloop tasks pull");
  });
});
