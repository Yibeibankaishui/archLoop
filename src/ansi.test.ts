import { afterEach, describe, expect, it } from "vitest";
import {
  createPalette,
  detectPalette,
  isPlainFlag,
  setPlainFlag,
} from "./ansi.js";

describe("detectPalette", () => {
  afterEach(() => {
    setPlainFlag(false);
  });

  it.each([
    {
      name: "FORCE_COLOR=1 forces color even when non-TTY and NO_COLOR",
      env: { FORCE_COLOR: "1", NO_COLOR: "1" },
      tty: false,
      plain: false,
      expected: "color",
    },
    {
      name: "FORCE_COLOR=true forces color",
      env: { FORCE_COLOR: "true" },
      tty: false,
      plain: false,
      expected: "color",
    },
    {
      name: "NO_COLOR=1 disables color on TTY",
      env: { NO_COLOR: "1" },
      tty: true,
      plain: false,
      expected: "plain",
    },
    {
      name: "empty NO_COLOR does not disable color",
      env: { NO_COLOR: "" },
      tty: true,
      plain: false,
      expected: "color",
    },
    {
      name: "--plain flag disables color on TTY",
      env: {},
      tty: true,
      plain: true,
      expected: "plain",
    },
    {
      name: "non-TTY disables color",
      env: {},
      tty: false,
      plain: false,
      expected: "plain",
    },
    {
      name: "TTY with no overrides enables color",
      env: {},
      tty: true,
      plain: false,
      expected: "color",
    },
  ] as const)("$name", ({ env, tty, plain, expected }) => {
    setPlainFlag(plain);
    expect(detectPalette(env, tty)).toBe(expected);
  });
});

describe("createPalette", () => {
  it("returns identity stylers when color is disabled", () => {
    const palette = createPalette(false);
    expect(palette.bold("x")).toBe("x");
    expect(palette.dim("x")).toBe("x");
    expect(palette.green("x")).toBe("x");
    expect(palette.yellow("x")).toBe("x");
    expect(palette.red("x")).toBe("x");
    expect(palette.cyan("x")).toBe("x");
  });

  it("applies ANSI codes when color is enabled", () => {
    const palette = createPalette(true);
    expect(palette.bold("x")).toContain("\u001b[1m");
    expect(palette.dim("x")).toContain("\u001b[2m");
    expect(palette.green("x")).toContain("\u001b[32m");
    expect(palette.yellow("x")).toContain("\u001b[33m");
    expect(palette.red("x")).toContain("\u001b[31m");
    expect(palette.cyan("x")).toContain("\u001b[36m");
  });
});

describe("setPlainFlag", () => {
  afterEach(() => {
    setPlainFlag(false);
  });

  it("tracks the module-level --plain flag", () => {
    expect(isPlainFlag()).toBe(false);
    setPlainFlag(true);
    expect(isPlainFlag()).toBe(true);
  });
});
