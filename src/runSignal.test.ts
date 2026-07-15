import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  createRunSignalController,
  getRunCancellationExitCode,
} from "./runSignal.js";

describe("createRunSignalController", () => {
  it("turns SIGINT into an AbortError with exit code 130", () => {
    const source = new EventEmitter();
    const runSignal = createRunSignalController(source);

    source.emit("SIGINT");

    expect(runSignal.signal.aborted).toBe(true);
    expect((runSignal.signal.reason as Error).name).toBe("AbortError");
    expect(getRunCancellationExitCode(runSignal.signal.reason)).toBe(130);
    runSignal.dispose();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });

  it("preserves the conventional SIGTERM exit code", () => {
    const source = new EventEmitter();
    const runSignal = createRunSignalController(source);

    source.emit("SIGTERM");

    expect(runSignal.signal.aborted).toBe(true);
    expect(getRunCancellationExitCode(runSignal.signal.reason)).toBe(143);
    runSignal.dispose();
  });
});
