export type HubRunLiveLayout = "wide" | "stacked";

export type HubRunPlainFallbackReason =
  | "not_tty"
  | "ci"
  | "dumb_terminal"
  | "unsupported_terminal"
  | "unsafe_width"
  | "unsafe_height";

export type HubRunOutputModeResolution =
  | {
      readonly mode: "live";
      readonly layout: HubRunLiveLayout;
      readonly color: boolean;
    }
  | {
      readonly mode: "plain";
      readonly reason: HubRunPlainFallbackReason;
    };

export interface HubRunOutputModeInput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly colorEnabled?: boolean;
  readonly cursorControl?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const HUB_RUN_MIN_LIVE_COLUMNS = 40;
export const HUB_RUN_MIN_LIVE_ROWS = 8;
export const HUB_RUN_WIDE_COLUMNS = 100;

const isTruthyEnvironmentFlag = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "0" && value !== "false";

const CURSOR_CAPABLE_TERM =
  /^(?:ansi|alacritty|contour|cygwin|eterm|foot|ghostty|kitty|konsole|linux|putty|rio|rxvt|screen|st|tmux|vt\d+|wezterm|xterm)(?:[-.]|$)/;

const CURSOR_CAPABLE_TERM_PROGRAMS = new Set([
  "apple_terminal",
  "ghostty",
  "hyper",
  "iterm.app",
  "tabby",
  "vscode",
  "warpterminal",
  "wezterm",
]);

export const supportsHubRunCursorControl = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  const term = env.TERM?.trim().toLowerCase();
  const termProgram = env.TERM_PROGRAM?.trim().toLowerCase();
  return (
    (term !== undefined && CURSOR_CAPABLE_TERM.test(term)) ||
    (termProgram !== undefined && CURSOR_CAPABLE_TERM_PROGRAMS.has(termProgram))
  );
};

export const resolveHubRunOutputMode = (
  input: HubRunOutputModeInput,
): HubRunOutputModeResolution => {
  if (!input.isTTY) {
    return { mode: "plain", reason: "not_tty" };
  }

  const env = input.env ?? {};
  if (isTruthyEnvironmentFlag(env.CI)) {
    return { mode: "plain", reason: "ci" };
  }
  if (env.TERM?.toLowerCase() === "dumb") {
    return { mode: "plain", reason: "dumb_terminal" };
  }
  if (input.cursorControl !== true) {
    return { mode: "plain", reason: "unsupported_terminal" };
  }
  if (
    input.columns === undefined ||
    !Number.isFinite(input.columns) ||
    input.columns < HUB_RUN_MIN_LIVE_COLUMNS
  ) {
    return { mode: "plain", reason: "unsafe_width" };
  }
  if (
    input.rows === undefined ||
    !Number.isFinite(input.rows) ||
    input.rows < HUB_RUN_MIN_LIVE_ROWS
  ) {
    return { mode: "plain", reason: "unsafe_height" };
  }
  const color =
    input.colorEnabled !== false &&
    !Object.prototype.hasOwnProperty.call(env, "NO_COLOR");
  return {
    mode: "live",
    layout: input.columns >= HUB_RUN_WIDE_COLUMNS ? "wide" : "stacked",
    color,
  };
};
