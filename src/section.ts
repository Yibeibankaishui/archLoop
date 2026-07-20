import {
  alignLeftRight,
  createPalette,
  resolveSectionWidth,
  severityColor,
  truncateTail,
  visibleLength,
  type Palette,
} from "./ansi.js";

// ---------------------------------------------------------------------------
// SectionBlock discriminated union (ADR-0030 / implementation plan §2)
// ---------------------------------------------------------------------------

/** Bold title + optional dim subtitle + optional right-aligned field. At most one per section. */
export interface SectionHeaderBlock {
  readonly kind: "header";
  readonly title: string;
  readonly subtitle?: string;
  readonly right?: string;
}

/** Dim horizontal rule at terminal width. */
export interface SectionDividerBlock {
  readonly kind: "divider";
}

/** One line of {symbol,count,label} pills separated by three spaces. */
export interface SectionBadgesBlock {
  readonly kind: "badges";
  readonly badges: readonly {
    readonly symbol: "●" | "◐" | "✓" | "✗" | "!" | "↓" | "↑";
    readonly count: number;
    readonly label: string;
    readonly severity: "info" | "success" | "warn" | "error" | "muted";
  }[];
}

/**
 * Group heading (symbol · name · count) followed by an indented flat list.
 * Nested detail is a separate `indented-block`, not a nested group item.
 */
export interface SectionGroupBlock {
  readonly kind: "group";
  readonly symbol: "●" | "◐" | "✓" | "✗" | "!";
  readonly severity: "info" | "success" | "warn" | "error" | "muted";
  readonly name: string;
  readonly count: number;
  readonly rightHint?: string;
  readonly items: readonly {
    readonly id: string;
    readonly title: string;
    readonly trailingDim?: string;
  }[];
  readonly footerDim?: string;
}

/** Left-aligned key/value block. Keys share a fixed gutter width. */
export interface SectionKvBlock {
  readonly kind: "kv";
  readonly gutter: number;
  readonly rows: readonly {
    readonly key: string;
    readonly value: string;
    readonly secondary?: string;
  }[];
}

/** Free-flowing paragraph. Renderer only soft-wraps. */
export interface SectionProseBlock {
  readonly kind: "prose";
  readonly title?: string;
  readonly body: string;
}

/**
 * Deeply-indented composite block (active Hub run card task).
 * Leading glyph + main line + N dim sub-lines.
 */
export interface SectionIndentedBlock {
  readonly kind: "indented-block";
  readonly leading: "↳" | "✓" | "✗" | "◐";
  readonly leadingSeverity: "info" | "success" | "warn" | "error" | "muted";
  readonly id?: string;
  readonly title: string;
  readonly subLines: readonly string[];
}

/**
 * Footer: closed three-label set.
 * `tip` accepts multiple commands; `next` / `fix` accept exactly one.
 */
export type SectionFooterBlock =
  | {
      readonly kind: "footer";
      readonly label: "tip";
      readonly commands: readonly string[];
    }
  | {
      readonly kind: "footer";
      readonly label: "next" | "fix";
      readonly command: string;
    };

export type SectionBlock =
  | SectionHeaderBlock
  | SectionDividerBlock
  | SectionBadgesBlock
  | SectionGroupBlock
  | SectionKvBlock
  | SectionProseBlock
  | SectionIndentedBlock
  | SectionFooterBlock;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderSectionOptions {
  readonly width?: number;
  readonly colorEnabled?: boolean;
}

const MARGIN = "  ";

const idColumnWidth = (cols: number): number => (cols >= 100 ? 18 : 14);

/** Soft word-wrap that ignores ANSI for width but keeps escapes intact. */
export const wrapText = (text: string, width: number): string[] => {
  let max = width;
  if (max <= 0) {
    max = 20;
  }
  const words = String(text).split(/(\s+)/);
  const lines: string[] = [];
  let cur = "";
  let curVL = 0;
  for (const tok of words) {
    const tokVL = visibleLength(tok);
    if (curVL + tokVL <= max) {
      cur += tok;
      curVL += tokVL;
    } else {
      if (cur.length > 0) {
        lines.push(cur.replace(/\s+$/, ""));
      }
      if (tokVL > max) {
        const chars = [...tok];
        let piece = "";
        let pieceVL = 0;
        for (const ch of chars) {
          if (pieceVL + 1 > max) {
            lines.push(piece);
            piece = ch;
            pieceVL = 1;
          } else {
            piece += ch;
            pieceVL += 1;
          }
        }
        cur = piece;
        curVL = pieceVL;
      } else if (/^\s+$/.test(tok)) {
        cur = "";
        curVL = 0;
      } else {
        cur = tok;
        curVL = tokVL;
      }
    }
  }
  if (cur.length > 0) {
    lines.push(cur);
  }
  if (lines.length === 0) {
    lines.push("");
  }
  return lines;
};

const renderHeader = (
  block: SectionHeaderBlock,
  cols: number,
  palette: Palette,
): string[] => {
  const usable = cols - MARGIN.length;
  let left = palette.bold(block.title);
  if (block.subtitle) {
    left +=
      " " + palette.dim("·") + " " + palette.cyan(block.subtitle);
  }
  const right = block.right ? palette.dim(block.right) : "";
  if (!right) {
    return [MARGIN + left];
  }
  if (
    visibleLength(left) + visibleLength(right) + 2 > usable &&
    block.subtitle
  ) {
    left = palette.bold(block.title);
  }
  if (visibleLength(left) + visibleLength(right) + 2 > usable) {
    return [MARGIN + left];
  }
  return [MARGIN + alignLeftRight(left, right, usable)];
};

const renderDivider = (
  cols: number,
  palette: Palette,
  colorEnabled: boolean,
): string[] => {
  if (!colorEnabled) {
    return [];
  }
  const width = Math.max(1, cols - MARGIN.length);
  return [MARGIN + palette.dim("─".repeat(width))];
};

const renderBadges = (
  block: SectionBadgesBlock,
  cols: number,
  palette: Palette,
): string[] => {
  const parts = block.badges.map((badge) => {
    const color = severityColor(palette, badge.severity);
    return `${color(badge.symbol)} ${palette.bold(String(badge.count))} ${badge.label}`;
  });
  const joined = parts.join("   ");
  if (visibleLength(MARGIN + joined) <= cols) {
    return [MARGIN + joined];
  }
  const tight = parts.join(" ");
  if (visibleLength(MARGIN + tight) <= cols) {
    return [MARGIN + tight];
  }
  // Wrap with hanging indent of 2 beyond margin
  const lines: string[] = [];
  let cur = MARGIN;
  let curVL = MARGIN.length;
  const hang = MARGIN + "  ";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const sep = i === 0 ? "" : " ";
    const piece = sep + part;
    const pieceVL = visibleLength(piece);
    if (curVL + pieceVL > cols && cur !== MARGIN && cur !== hang) {
      lines.push(cur);
      cur = hang + part;
      curVL = visibleLength(cur);
    } else {
      cur += piece;
      curVL += pieceVL;
    }
  }
  if (cur.length > 0) {
    lines.push(cur);
  }
  return lines;
};

const renderGroup = (
  block: SectionGroupBlock,
  cols: number,
  palette: Palette,
): string[] => {
  const usable = cols - MARGIN.length;
  const lines: string[] = [];
  const color = severityColor(palette, block.severity);
  const heading = `${color(block.symbol)}  ${palette.bold(`${block.name} · ${block.count}`)}`;
  if (block.rightHint) {
    const right = palette.dim(block.rightHint);
    if (visibleLength(heading) + visibleLength(right) + 1 <= usable) {
      lines.push(MARGIN + alignLeftRight(heading, right, usable));
    } else {
      lines.push(MARGIN + heading);
    }
  } else {
    lines.push(MARGIN + heading);
  }

  // Prefer full id; shrink column on narrow terminals so title+trailing fit.
  let idWidth = idColumnWidth(cols);
  const indent = MARGIN + "   ";
  const longestId = block.items.reduce(
    (max, item) => Math.max(max, visibleLength(item.id)),
    0,
  );
  idWidth = Math.min(idWidth, Math.max(longestId, 8));

  for (const item of block.items) {
    const idColored = palette.cyan(item.id);
    const idPad =
      idColored + " ".repeat(Math.max(0, idWidth - visibleLength(item.id)));
    const titleGap = "  ";
    const prefix = indent + idPad + titleGap;
    const prefixVL = visibleLength(prefix);
    const trailing = item.trailingDim ?? "";
    const trailingRendered = trailing ? palette.dim(trailing) : "";
    const trailingVL = trailing ? visibleLength(trailingRendered) + 1 : 0;

    let titleBudget = cols - prefixVL - trailingVL;
    let useTrailing = Boolean(trailing);
    if (titleBudget < 8 && useTrailing) {
      // Drop trailing so the title can breathe.
      useTrailing = false;
      titleBudget = cols - prefixVL - 1;
    }
    if (titleBudget < 4) {
      // Extreme narrow: collapse to id-only + hard-truncated title
      titleBudget = Math.max(4, cols - visibleLength(indent) - 1);
      const title = truncateTail(
        `${item.id}  ${item.title}`,
        titleBudget,
      );
      lines.push(indent + title);
      continue;
    }

    const title = truncateTail(item.title, titleBudget);
    if (useTrailing) {
      const left = prefix + title;
      if (visibleLength(left) + trailingVL <= cols) {
        lines.push(alignLeftRight(left, trailingRendered, cols));
      } else {
        lines.push(prefix + title);
      }
    } else {
      lines.push(prefix + title);
    }
  }
  if (block.footerDim) {
    const footer = truncateTail(
      block.footerDim,
      Math.max(4, cols - visibleLength(indent)),
    );
    lines.push(indent + palette.dim(footer));
  }
  return lines;
};

const renderKv = (
  block: SectionKvBlock,
  cols: number,
  palette: Palette,
): string[] => {
  const gutter = Math.max(1, block.gutter);
  const lines: string[] = [];
  for (const row of block.rows) {
    const key = palette.bold(row.key);
    const keyPad = Math.max(1, gutter - visibleLength(row.key));
    const keyPadded = key + " ".repeat(keyPad);
    const valueBudget = Math.max(10, cols - MARGIN.length - gutter);
    let value = row.value;
    if (row.secondary) {
      value = `${row.value}  ${palette.dim(row.secondary)}`;
    }
    const wrapped = wrapText(value, valueBudget);
    lines.push(MARGIN + keyPadded + wrapped[0]!);
    const contIndent = MARGIN + " ".repeat(gutter);
    for (let i = 1; i < wrapped.length; i++) {
      lines.push(contIndent + wrapped[i]!);
    }
  }
  return lines;
};

const renderProse = (
  block: SectionProseBlock,
  cols: number,
  palette: Palette,
): string[] => {
  const lines: string[] = [];
  if (block.title) {
    lines.push(MARGIN + palette.bold(block.title));
  }
  const indent = MARGIN + "  ";
  const usable = Math.max(10, cols - indent.length);
  const wrapped = wrapText(block.body.trimEnd(), usable);
  for (const line of wrapped) {
    lines.push(indent + line);
  }
  return lines;
};

const renderIndentedBlock = (
  block: SectionIndentedBlock,
  cols: number,
  palette: Palette,
): string[] => {
  const color = severityColor(palette, block.leadingSeverity);
  const leadIndent = MARGIN + "   ";
  const arrow = color(block.leading);
  const headerPrefix = `${leadIndent}${arrow}  `;
  const lines: string[] = [];

  let titleStart = visibleLength(headerPrefix);
  let first = headerPrefix;
  if (block.id) {
    // Never pad the id past the remaining column budget.
    const idBudget = Math.max(
      8,
      cols - visibleLength(headerPrefix) - 4,
    );
    const idText =
      visibleLength(block.id) > idBudget
        ? truncateTail(block.id, idBudget)
        : block.id;
    const idColored = palette.cyan(idText);
    const titleGap = "   ";
    first = headerPrefix + idColored + titleGap;
    titleStart = visibleLength(first);
  }

  // If the prefix alone eats the line, put the title on the next line.
  if (titleStart >= cols - 4) {
    lines.push(first.trimEnd());
    titleStart = visibleLength(leadIndent) + 2;
    first = " ".repeat(titleStart);
  }

  const titleWidth = Math.max(4, cols - titleStart);
  const wrapped = wrapText(block.title, titleWidth);
  lines.push(first + wrapped[0]!);
  const contIndent = " ".repeat(titleStart);
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(contIndent + wrapped[i]!);
  }
  for (const sub of block.subLines) {
    const subWrapped = wrapText(sub, titleWidth);
    for (const piece of subWrapped) {
      lines.push(contIndent + palette.dim(piece));
    }
  }
  return lines;
};

const renderFooter = (
  block: SectionFooterBlock,
  cols: number,
  palette: Palette,
): string[] => {
  const commands =
    block.label === "tip" ? [...block.commands] : [block.command];
  const labelStr =
    block.label === "fix"
      ? palette.red(block.label)
      : palette.dim(block.label);
  const labelPadded = labelStr + " ".repeat(Math.max(1, 6 - block.label.length));
  const sep = "   " + palette.dim("·") + "   ";
  const joined = commands.join(sep);
  const first = MARGIN + labelPadded + joined;
  if (visibleLength(first) <= cols) {
    return [first];
  }
  // Wrap subsequent commands under a 6-space label indent
  const lines: string[] = [];
  const hang = MARGIN + " ".repeat(6);
  let cur = MARGIN + labelPadded;
  let curVL = visibleLength(cur);
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    const piece = i === 0 ? cmd : sep + cmd;
    const pieceVL = visibleLength(piece);
    if (curVL + pieceVL > cols && i > 0) {
      lines.push(cur);
      cur = hang + cmd;
      curVL = visibleLength(cur);
    } else {
      cur += piece;
      curVL += pieceVL;
    }
  }
  if (cur.length > 0) {
    lines.push(cur);
  }
  return lines;
};

const renderBlock = (
  block: SectionBlock,
  cols: number,
  palette: Palette,
  colorEnabled: boolean,
): string[] => {
  switch (block.kind) {
    case "header":
      return renderHeader(block, cols, palette);
    case "divider":
      return renderDivider(cols, palette, colorEnabled);
    case "badges":
      return renderBadges(block, cols, palette);
    case "group":
      return renderGroup(block, cols, palette);
    case "kv":
      return renderKv(block, cols, palette);
    case "prose":
      return renderProse(block, cols, palette);
    case "indented-block":
      return renderIndentedBlock(block, cols, palette);
    case "footer":
      return renderFooter(block, cols, palette);
  }
};

/**
 * Pure section renderer. No side effects, no process.stdout writes.
 * Returns one string per output line (including two-space left margin).
 */
export const renderSection = (
  title: string,
  blocks: ReadonlyArray<SectionBlock>,
  options: RenderSectionOptions = {},
): string[] => {
  const cols = resolveSectionWidth(options.width);
  const colorEnabled = options.colorEnabled ?? false;
  const palette = createPalette(colorEnabled);
  const lines: string[] = [];
  if (title.length > 0) {
    lines.push(MARGIN + palette.bold(title));
  }
  for (const block of blocks) {
    lines.push(...renderBlock(block, cols, palette, colorEnabled));
  }
  return lines;
};

/**
 * Flatten blocks to plain text for FileDisplay / run logs.
 * No color, no dividers; preserves symbols and ids for grep-ability.
 */
export const flattenSectionForLog = (
  blocks: ReadonlyArray<SectionBlock>,
): string[] => {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "header": {
        const parts = [block.title];
        if (block.subtitle) {
          parts.push(block.subtitle);
        }
        const left = parts.join(" · ");
        lines.push(block.right ? `${left}    ${block.right}` : left);
        break;
      }
      case "divider":
        break;
      case "badges":
        lines.push(
          block.badges
            .map((b) => `${b.symbol} ${b.count} ${b.label}`)
            .join("   "),
        );
        break;
      case "group": {
        lines.push(`${block.symbol}  ${block.name} · ${block.count}`);
        for (const item of block.items) {
          const trailing = item.trailingDim ? `  ${item.trailingDim}` : "";
          lines.push(`  ${item.id}  ${item.title}${trailing}`);
        }
        if (block.footerDim) {
          lines.push(`  ${block.footerDim}`);
        }
        break;
      }
      case "kv":
        for (const row of block.rows) {
          const secondary = row.secondary ? `  ${row.secondary}` : "";
          lines.push(`${row.key}: ${row.value}${secondary}`);
        }
        break;
      case "prose":
        if (block.title) {
          lines.push(block.title);
        }
        lines.push(block.body);
        break;
      case "indented-block": {
        const id = block.id ? `${block.id}  ` : "";
        lines.push(`${block.leading} ${id}${block.title}`);
        for (const sub of block.subLines) {
          lines.push(`    ${sub}`);
        }
        break;
      }
      case "footer": {
        const commands =
          block.label === "tip" ? block.commands : [block.command];
        lines.push(`${block.label}   ${commands.join("   ·   ")}`);
        break;
      }
    }
  }
  return lines;
};
