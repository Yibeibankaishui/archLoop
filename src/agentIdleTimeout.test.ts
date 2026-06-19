import { describe, expect, it } from "vitest";
import { isAgentIdleTimeoutError } from "./agentIdleTimeout.js";
import { AgentError, AgentIdleTimeoutError } from "./errors.js";

describe("isAgentIdleTimeoutError", () => {
  it("returns true for a direct AgentIdleTimeoutError instance", () => {
    const err = new AgentIdleTimeoutError({
      message: "idle for 100ms; bump --idle-timeout",
      timeoutMs: 100,
    });
    expect(isAgentIdleTimeoutError(err)).toBe(true);
  });

  it("returns true for an Effect FiberFailure-shaped wrapper whose cause chain holds the error", () => {
    const inner = new AgentIdleTimeoutError({
      message: "idle",
      timeoutMs: 100,
    });
    const wrapper = new Error("FiberFailure");
    (wrapper as Error & { cause?: unknown }).cause = inner;
    expect(isAgentIdleTimeoutError(wrapper)).toBe(true);
  });

  it("returns true for a duck-typed _tag object (cross-realm safety)", () => {
    const duck = { _tag: "AgentIdleTimeoutError", message: "idle" };
    expect(isAgentIdleTimeoutError(duck)).toBe(true);
  });

  it("returns true when the duck-typed tag is nested in a cause chain", () => {
    const inner = { _tag: "AgentIdleTimeoutError", message: "idle" };
    const middle = new Error("middle");
    (middle as Error & { cause?: unknown }).cause = inner;
    const outer = new Error("outer");
    (outer as Error & { cause?: unknown }).cause = middle;
    expect(isAgentIdleTimeoutError(outer)).toBe(true);
  });

  it("returns false for a different tagged error", () => {
    const err = new AgentError({ message: "agent boom" });
    expect(isAgentIdleTimeoutError(err)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isAgentIdleTimeoutError(new Error("nope"))).toBe(false);
  });

  it("returns false for non-error inputs", () => {
    expect(isAgentIdleTimeoutError(undefined)).toBe(false);
    expect(isAgentIdleTimeoutError(null)).toBe(false);
    expect(isAgentIdleTimeoutError("string error")).toBe(false);
    expect(isAgentIdleTimeoutError(42)).toBe(false);
    expect(isAgentIdleTimeoutError({})).toBe(false);
  });

  it("handles a cause chain with a cycle without hanging", () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(isAgentIdleTimeoutError(a)).toBe(false);
  });
});
