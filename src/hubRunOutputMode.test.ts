import { describe, expect, it } from "vitest";

import {
  resolveHubRunOutputMode,
  supportsHubRunCursorControl,
} from "./hubRunOutputMode.js";

describe("supportsHubRunCursorControl", () => {
  it("accepts known cursor-capable terminals and rejects missing or unknown TERM values", () => {
    expect(supportsHubRunCursorControl({ TERM: "xterm-256color" })).toBe(true);
    expect(supportsHubRunCursorControl({ TERM: "screen-256color" })).toBe(true);
    expect(
      supportsHubRunCursorControl({
        TERM: "unknown",
        TERM_PROGRAM: "Apple_Terminal",
      }),
    ).toBe(true);
    expect(supportsHubRunCursorControl({ TERM: "unknown" })).toBe(false);
    expect(supportsHubRunCursorControl({})).toBe(false);
  });
});

describe("resolveHubRunOutputMode", () => {
  it("selects a wide live view for a capable interactive terminal", () => {
    expect(
      resolveHubRunOutputMode({
        isTTY: true,
        columns: 120,
        rows: 24,
        colorEnabled: true,
        cursorControl: true,
        env: {},
      }),
    ).toEqual({ mode: "live", layout: "wide", color: true });
  });

  it("falls back to plain output when stdout is redirected", () => {
    expect(
      resolveHubRunOutputMode({
        isTTY: false,
        columns: 120,
        colorEnabled: true,
        env: {},
      }),
    ).toEqual({ mode: "plain", reason: "not_tty" });
  });

  it("reports why a terminal cannot safely host a live view", () => {
    const common = {
      isTTY: true,
      columns: 120,
      rows: 24,
      colorEnabled: true,
      cursorControl: true,
    } as const;

    expect(resolveHubRunOutputMode({ ...common, env: { CI: "true" } })).toEqual(
      { mode: "plain", reason: "ci" },
    );
    expect(
      resolveHubRunOutputMode({ ...common, env: { TERM: "dumb" } }),
    ).toEqual({ mode: "plain", reason: "dumb_terminal" });
    expect(
      resolveHubRunOutputMode({ ...common, columns: 39, env: {} }),
    ).toEqual({ mode: "plain", reason: "unsafe_width" });
    expect(
      resolveHubRunOutputMode({ ...common, columns: undefined, env: {} }),
    ).toEqual({ mode: "plain", reason: "unsafe_width" });
    expect(resolveHubRunOutputMode({ ...common, rows: 7, env: {} })).toEqual({
      mode: "plain",
      reason: "unsafe_height",
    });
    expect(
      resolveHubRunOutputMode({ ...common, rows: undefined, env: {} }),
    ).toEqual({ mode: "plain", reason: "unsafe_height" });
  });

  it("uses a stacked live layout at safe narrow widths", () => {
    expect(
      resolveHubRunOutputMode({
        isTTY: true,
        columns: 72,
        rows: 24,
        colorEnabled: true,
        cursorControl: true,
        env: {},
      }),
    ).toEqual({ mode: "live", layout: "stacked", color: true });
  });

  it("keeps live rendering available when color is disabled", () => {
    const terminal = {
      isTTY: true,
      columns: 120,
      rows: 24,
      cursorControl: true,
    } as const;

    expect(
      resolveHubRunOutputMode({
        ...terminal,
        colorEnabled: true,
        env: { NO_COLOR: "" },
      }),
    ).toEqual({ mode: "live", layout: "wide", color: false });
    expect(
      resolveHubRunOutputMode({
        ...terminal,
        colorEnabled: false,
        env: {},
      }),
    ).toEqual({ mode: "live", layout: "wide", color: false });
  });

  it("falls back when cursor-region control is unsupported", () => {
    expect(
      resolveHubRunOutputMode({
        isTTY: true,
        columns: 120,
        colorEnabled: true,
        cursorControl: false,
        env: {},
      }),
    ).toEqual({ mode: "plain", reason: "unsupported_terminal" });
  });

  it("falls back unless cursor-region control is explicitly supported", () => {
    expect(
      resolveHubRunOutputMode({
        isTTY: true,
        columns: 120,
        colorEnabled: true,
        env: { TERM: "xterm-256color" },
      }),
    ).toEqual({ mode: "plain", reason: "unsupported_terminal" });
  });
});
