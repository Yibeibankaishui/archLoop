/**
 * Helper for detecting AgentIdleTimeoutError at template / consumer call sites.
 *
 * `sandcastle.run()` is implemented on top of Effect, and its rejection shape
 * varies: the rejected value may be an `AgentIdleTimeoutError` instance, an
 * Effect `FiberFailure` whose `cause` holds the typed error, or any object
 * with the `_tag: "AgentIdleTimeoutError"` discriminator. Templates calling
 * `sandcastle.run()` would otherwise have to know all of those shapes — this
 * helper centralises the duck-typing in one place.
 *
 * See sandcastle issue #97.
 */
import { AgentIdleTimeoutError } from "./errors.js";

const TAG = "AgentIdleTimeoutError";

/** Walk an error's `.cause` chain, capped to avoid pathological cycles. */
function* causeChain(err: unknown): Generator<unknown> {
  let current: unknown = err;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 16) {
    yield current;
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
    depth++;
  }
}

function hasIdleTimeoutTag(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "_tag" in err &&
    (err as { _tag?: unknown })._tag === TAG
  );
}

/**
 * Returns true if `err` is — or wraps — an `AgentIdleTimeoutError`.
 *
 * Accepts:
 *   - direct `AgentIdleTimeoutError` instances (the common case for typed
 *     consumers and tests),
 *   - any object whose `_tag` is `"AgentIdleTimeoutError"` (Effect-tagged
 *     errors across realm boundaries),
 *   - an Effect `FiberFailure` whose `.cause` chain transitively contains
 *     either of the above.
 */
export function isAgentIdleTimeoutError(err: unknown): boolean {
  if (err instanceof AgentIdleTimeoutError) return true;
  for (const node of causeChain(err)) {
    if (node instanceof AgentIdleTimeoutError) return true;
    if (hasIdleTimeoutTag(node)) return true;
  }
  return false;
}
