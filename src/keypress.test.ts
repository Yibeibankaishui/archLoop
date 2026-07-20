import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForKeypress, type KeypressOutcome } from "./keypress.js";

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode;
    return this;
  });
  resume = vi.fn(() => this);
  pause = vi.fn(() => this);
}

describe("waitForKeypress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns start on timeout when no key is pressed", async () => {
    vi.useFakeTimers();
    const stdin = new FakeStdin();
    const pending = waitForKeypress({
      timeoutMs: 3000,
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toBe("start");
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  it("returns cancel on Ctrl+C and invokes onCancel", async () => {
    const stdin = new FakeStdin();
    const onCancel = vi.fn();
    const pending = waitForKeypress({
      timeoutMs: 3000,
      stdin: stdin as unknown as NodeJS.ReadStream,
      onCancel,
    });

    stdin.emit("data", Buffer.from("\u0003"));
    await expect(pending).resolves.toBe("cancel");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("returns edit on e / E", async () => {
    for (const key of ["e", "E"] as const) {
      const stdin = new FakeStdin();
      const pending = waitForKeypress({
        timeoutMs: 3000,
        stdin: stdin as unknown as NodeJS.ReadStream,
      });
      stdin.emit("data", Buffer.from(key));
      await expect(pending).resolves.toBe("edit");
    }
  });

  it("ignores unrelated keys until timeout", async () => {
    vi.useFakeTimers();
    const stdin = new FakeStdin();
    const pending = waitForKeypress({
      timeoutMs: 1000,
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    stdin.emit("data", Buffer.from("x"));
    stdin.emit("data", Buffer.from("\r"));
    await vi.advanceTimersByTimeAsync(999);
    let settled: KeypressOutcome | undefined;
    void pending.then((outcome) => {
      settled = outcome;
    });
    await Promise.resolve();
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("start");
  });

  it("resolves immediately with start when stdin is not a TTY", async () => {
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    await expect(
      waitForKeypress({
        timeoutMs: 3000,
        stdin: stdin as unknown as NodeJS.ReadStream,
      }),
    ).resolves.toBe("start");
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });
});
