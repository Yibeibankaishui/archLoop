import { describe, expect, it, vi } from "vitest";
import {
  SHOW_CURSOR,
  makeTerminalCleanupHandler,
  setupTerminalCleanup,
} from "./terminalCleanup.js";

describe("makeTerminalCleanupHandler", () => {
  it("calls setRawMode(false) and writes show-cursor when stdin is a TTY", () => {
    const setRawMode = vi.fn();
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true, setRawMode },
      { write },
    );
    handler();

    expect(setRawMode).toHaveBeenCalledOnce();
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("skips setRawMode when stdin is not a TTY", () => {
    const setRawMode = vi.fn();
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: false, setRawMode },
      { write },
    );
    handler();

    expect(setRawMode).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("skips setRawMode when stdin has no setRawMode (non-TTY pipe)", () => {
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true }, // isTTY true but no setRawMode
      { write },
    );
    handler();

    // No error thrown, cursor still shown
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("does not throw when setRawMode throws", () => {
    const setRawMode = vi.fn(() => {
      throw new Error("setRawMode failed");
    });
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true, setRawMode },
      { write },
    );

    expect(() => handler()).not.toThrow();
    // cursor is still shown even after setRawMode failure
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });
});

describe("setupTerminalCleanup", () => {
  it("registers cleanup against the diagnostic stream instead of stdout", () => {
    const write = vi.fn(() => true);
    let registered: (() => void) | undefined;

    setupTerminalCleanup({
      stdin: { isTTY: false },
      output: { write },
      registerExit: (handler) => {
        registered = handler;
      },
    });
    registered?.();

    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });
});
