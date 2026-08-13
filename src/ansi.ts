import { styleText } from "node:util";

export type PaletteMode = "color" | "plain";

export interface Palette {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly red: (text: string) => string;
  readonly cyan: (text: string) => string;
}

let plainFlag = false;

export const setPlainFlag = (value: boolean): void => {
  plainFlag = value;
};

export const isPlainFlag = (): boolean => plainFlag;

/**
 * Color decision matrix for terminal section rendering.
 * FORCE_COLOR=1 wins over everything; otherwise NO_COLOR / --plain / non-TTY → plain.
 */
export const detectPalette = (
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = Boolean(process.stdout.isTTY),
): PaletteMode => {
  if (env.FORCE_COLOR === "1" || env.FORCE_COLOR === "true") {
    return "color";
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return "plain";
  }
  if (plainFlag) {
    return "plain";
  }
  if (!tty) {
    return "plain";
  }
  return "color";
};

const identity = (text: string): string => String(text);

export const createPalette = (colorEnabled: boolean): Palette => {
  if (!colorEnabled) {
    return {
      bold: identity,
      dim: identity,
      green: identity,
      yellow: identity,
      red: identity,
      cyan: identity,
    };
  }
  // validateStream:false — colorEnabled already encodes our decision matrix;
  // do not re-consult stdout.isTTY / env inside styleText.
  const style = (format: Parameters<typeof styleText>[0], text: string) =>
    styleText(format, text, { validateStream: false });
  return {
    bold: (text) => style("bold", text),
    dim: (text) => style("dim", text),
    green: (text) => style("green", text),
    yellow: (text) => style("yellow", text),
    red: (text) => style("red", text),
    cyan: (text) => style("cyan", text),
  };
};

/** Target width: default 100, floor 40, cap 120. */
export const resolveSectionWidth = (width: number | undefined): number => {
  const raw = typeof width === "number" && Number.isFinite(width) && width > 0
    ? width
    : 100;
  return Math.max(40, Math.min(raw, 120));
};

/** Strip CSI sequences for visible-width measurement (counts code points, not UTF-16 units). */
export const visibleLength = (text: string): number => {
  const stripped = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return [...stripped].length;
};

export const truncateTail = (text: string, maxVisible: number): string => {
  const chars = [...String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")];
  if (chars.length <= maxVisible) {
    return text;
  }
  if (maxVisible <= 1) {
    return "…";
  }
  return chars.slice(0, maxVisible - 1).join("") + "…";
};

export const truncateHead = (text: string, maxVisible: number): string => {
  const chars = [...String(text)];
  if (chars.length <= maxVisible) {
    return text;
  }
  if (maxVisible <= 1) {
    return "…";
  }
  return "…" + chars.slice(chars.length - (maxVisible - 1)).join("");
};

export const alignLeftRight = (
  left: string,
  right: string,
  width: number,
): string => {
  const pad = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return left + " ".repeat(pad) + right;
};

/** Shared severity vocabulary for colored section accents (`severityColor`). */
export type SectionSeverity = "info" | "success" | "warn" | "error" | "muted";

export const severityColor = (
  palette: Palette,
  severity: SectionSeverity,
): ((text: string) => string) => {
  switch (severity) {
    case "success":
      return palette.green;
    case "warn":
      return palette.yellow;
    case "error":
      return palette.red;
    case "muted":
      return palette.dim;
    case "info":
    default:
      return palette.cyan;
  }
};
