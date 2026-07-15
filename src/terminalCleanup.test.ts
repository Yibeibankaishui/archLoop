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
      { isTTY: true, write },
      () => true,
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
      { isTTY: true, write },
      () => true,
    );
    handler();

    expect(setRawMode).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("skips setRawMode when stdin has no setRawMode (non-TTY pipe)", () => {
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true }, // isTTY true but no setRawMode
      { isTTY: true, write },
      () => true,
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
      { isTTY: true, write },
      () => true,
    );

    expect(() => handler()).not.toThrow();
    // cursor is still shown even after setRawMode failure
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("does not write cursor control when the output is not a TTY", () => {
    const setRawMode = vi.fn();
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: false, setRawMode },
      { isTTY: false, write },
      () => true,
    );
    handler();

    expect(setRawMode).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write cursor control when no live renderer hid it", () => {
    const write = vi.fn(() => true);
    const handler = makeTerminalCleanupHandler(
      { isTTY: true },
      { isTTY: true, write },
      () => false,
    );

    handler();

    expect(write).not.toHaveBeenCalled();
  });
});

describe("setupTerminalCleanup", () => {
  it("registers cleanup against the TTY output stream", () => {
    const write = vi.fn(() => true);
    let registered: (() => void) | undefined;

    setupTerminalCleanup({
      stdin: { isTTY: false },
      output: { isTTY: true, write },
      shouldRestoreCursor: () => true,
      registerExit: (handler) => {
        registered = handler;
      },
    });
    registered?.();

    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });
});
