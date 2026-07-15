/**
 * Terminal cleanup for abrupt exits.
 *
 * @clack/prompts' spinner and taskLog call stdin.setRawMode(true) and hide
 * the cursor via escape sequences. When the process is killed by a signal
 * handler that calls process.exit() directly, clack's own cleanup is bypassed
 * and the terminal can be left in raw mode with the cursor hidden.
 *
 * Registering a process 'exit' listener that restores these guarantees the
 * terminal is always left in a usable state.
 */

/** Escape sequence to show the cursor (DECTCEM). */
export const SHOW_CURSOR = "\x1b[?25h";

let terminalCursorHidden = false;

export const setTerminalCursorHidden = (hidden: boolean): void => {
  terminalCursorHidden = hidden;
};

export const isTerminalCursorHidden = (): boolean => terminalCursorHidden;

/**
 * Creates a synchronous exit handler that restores terminal state.
 * Extracted as a pure function so it can be unit-tested without side effects.
 */
export const makeTerminalCleanupHandler =
  (
    stdin: { isTTY?: boolean; setRawMode?: (raw: boolean) => void },
    output: { isTTY?: boolean; write: (data: string) => boolean },
    shouldRestoreCursor: () => boolean = isTerminalCursorHidden,
  ) =>
  (): void => {
    if (stdin.isTTY && stdin.setRawMode) {
      try {
        stdin.setRawMode(false);
      } catch {
        // Best-effort — may fail if stdin is already closed
      }
    }
    if (output.isTTY && shouldRestoreCursor()) {
      output.write(SHOW_CURSOR);
      setTerminalCursorHidden(false);
    }
  };

/**
 * Registers the terminal cleanup handler on process 'exit'.
 * Call once at program startup (main.ts).
 */
export const setupTerminalCleanup = (
  options: {
    readonly stdin?: {
      isTTY?: boolean;
      setRawMode?: (raw: boolean) => void;
    };
    readonly output?: {
      isTTY?: boolean;
      write: (data: string) => boolean;
    };
    readonly registerExit?: (handler: () => void) => void;
    readonly shouldRestoreCursor?: () => boolean;
  } = {},
): void => {
  const handler = makeTerminalCleanupHandler(
    options.stdin ?? process.stdin,
    options.output ?? process.stdout,
    options.shouldRestoreCursor ?? isTerminalCursorHidden,
  );
  (options.registerExit ?? ((onExit) => process.on("exit", onExit)))(handler);
};
