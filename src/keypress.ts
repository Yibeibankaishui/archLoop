export type KeypressOutcome = "start" | "edit" | "cancel";

export interface WaitForKeypressOptions {
  readonly timeoutMs: number;
  readonly stdin?: NodeJS.ReadStream;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  /** Invoked when Ctrl+C is received (before resolving `"cancel"`). */
  readonly onCancel?: () => void;
  readonly keyMap?: Readonly<Record<string, KeypressOutcome>>;
  readonly defaultOnTimeout?: KeypressOutcome;
}

const DEFAULT_KEY_MAP: Readonly<Record<string, KeypressOutcome>> = {
  "\u0003": "cancel",
  e: "edit",
  E: "edit",
};

const SHOW_CURSOR = "\x1b[?25h";

const writeShowCursor = (): void => {
  try {
    if (process.stdout.isTTY) {
      process.stdout.write(SHOW_CURSOR);
    }
  } catch {
    // Best-effort cursor restore during teardown.
  }
};

/**
 * Wait for a mapped keypress or timeout. Unmapped keys are ignored.
 * Puts stdin into raw mode while waiting; always restores raw mode + cursor.
 */
export const waitForKeypress = (
  options: WaitForKeypressOptions,
): Promise<KeypressOutcome> => {
  const stdin = options.stdin ?? process.stdin;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const keyMap = options.keyMap ?? DEFAULT_KEY_MAP;
  const defaultOnTimeout = options.defaultOnTimeout ?? "start";

  if (!stdin.isTTY) {
    return Promise.resolve(defaultOnTimeout);
  }

  return new Promise<KeypressOutcome>((resolve) => {
    let settled = false;
    const previousRawMode =
      typeof stdin.isRaw === "boolean" ? stdin.isRaw : false;

    const cleanup = (): void => {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(previousRawMode);
        } catch {
          // Ignore restore failures (stdin may already be closed).
        }
      }
      writeShowCursor();
    };

    const finish = (outcome: KeypressOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeoutFn(timer);
      cleanup();
      if (outcome === "cancel") {
        options.onCancel?.();
      }
      resolve(outcome);
    };

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        const mapped = keyMap[char];
        if (mapped) {
          finish(mapped);
          return;
        }
      }
    };

    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    if (typeof stdin.resume === "function") {
      stdin.resume();
    }
    stdin.on("data", onData);

    const timer = setTimeoutFn(() => {
      finish(defaultOnTimeout);
    }, options.timeoutMs);
  });
};
