# archLoop CLI Variant C · 视觉重构实施方案

> 落地文档 · 对应 mockup [`docs/cli-redesign-variant-c.md`](./cli-redesign-variant-c.md) 与三份 ADR
> ([0030](./adr/0030-terminal-section-display-primitive.md) /
> [0031](./adr/0031-cli-task-selectors-drop-ordinal-input.md) /
> [0032](./adr/0032-hub-run-card-append-only-rendering.md))。
> 代码与 CLI 文本用英文，说明用中文；所有代码段可直接搬进 PR。

> **实施前提** — 本文档的所有 `src/hubRunLiveDisplay.ts` / `src/hubRunDisplay.ts` 引用，指的是
> `main` 分支上由 commit `19e2615` 引入的实际源文件。本文档撰写时的工作分支
> (`feature/optimize-cli`) 恰好在这两个文件加入 main 之前从 main 分出，因此这条分支的 `src/` 里
> 找不到它们，只有 `dist/` 里保留了编译产物。**Phase 3 开工前必须先把工作分支 rebase 到最新的
> main**（或从最新 main 重新起支），否则 Phase 3 会误以为 live display 是新造的模块，实际是重写
> 已有 500 行代码。

---

## 1. Executive summary

**Goal.** Variant C 是"在 Variant A 的 plumbing 派与 Variant B 的 dashboard 派之间"的折中：保留
`clack.spinner` / `clack.select` 等交互原语，但去掉 `clack.note` 的 `│` gutter；引入统一的四段结构
（header + divider + 段落 + footer）；用状态符号 + 颜色 + 短 id 表达信息层级。它**不**承诺 A 的
`--porcelain` grep-friendly 输出，也**不**承诺 B 的仪表盘 alt-screen 刷新。选它是因为一次落地能把当前
`clack.note` 的粗糙输出提升到"看着舒服 · 认知负担明显下降"的水平，同时向 B 演进的口子不堵死。

**Delivery shape.**

- Display 服务增加 **一个** 新原语 `section(title, blocks)`（ADR-0030），`SectionBlock` 是 8 种
  block 的 discriminated union，不引入 `progress` / `sparkline` / `table`。
- 三种 Display 实现（`ClackDisplay` / `SilentDisplay` / `FileDisplay`）都得实现 `section`；
  `ClackDisplay` 用 `console.log` 直接写 stdout，绕开 `clack.note`。
- 宽度自适应：min 40 / target 100 / max `Math.min(terminal, 120)`；title 尾截断（`…`），
  path 头截断（`…/`）；右对齐字段用 `terminal_width - left_content_length` 补空格。
- **Hub 任务板视图**（Hub task board view）与 **Hub 运行卡片**（Hub run card）都通过 `section` 输出；
  运行卡片按 ADR-0032 走 append-only + 单行 `clack.spinner` heartbeat，**不**使用 alt-screen。
- `archloop run` 交互流程用 3 秒 debounce 替代 `confirmRunPlan()` 的二次 `clack.confirm`；
  非-TTY / `--yes` / `--dry-run` 跳过 debounce。
- 序号 `1..N` 从 `formatHubTaskBoardLines` 与 CLI 输入契约中一起删除（ADR-0031）；
  Beads id 全长展示；运行/批次 UUID 只显示 8-char 前缀，输入端接受前缀，二义时报错列候选。

**Order of work.** 四个 phase，每个可独立发 PR、独立评审、独立回滚：

1. **Foundation** — `section` 原语 + block 联合类型 + 共享 renderer + 颜色检测 + 单元测试。
2. **Static screens** — `tasks list` / `tasks pull` / `tasks show` 迁移到 `section`，`taskBoard.ts`
   改为吐 model，测试从字符串断言改为 model 结构断言。
3. **Hub run card + run 交互** — `hubRunLiveDisplay` 重写为 append-only；`confirmRunPlan` 删除并换成
   debounce；`run.started` … `run.completed` 每个转换都发一个 `section`。
4. **Cleanup + docs** — 更新 `skills/archloop-usage/SKILL.md` / `README.md` / `readme_cn.md` /
   `user_guide.md`；删除 legacy code path；发 changeset。

Phase 1 上线后，其余 screen 仍走旧路径，视觉不变；Phase 2 上线后，除 run live 外全部换新；
Phase 3 上线才动 live view；Phase 4 是收尾。任何一步中断都能停在一个自洽的状态。

---

## 2. Model layer — TypeScript types

所有 model 都是纯数据，只 `readonly` 字段，无方法；渲染逻辑不在这里。放在
新文件 `src/section.ts`（block 联合 + 渲染器）与 `src/taskBoard.ts` / 新文件 `src/hubRunCard.ts`
（model 构造函数）。

### 2.1 `SectionBlock` 联合类型 (`src/section.ts`)

```ts
// One line: bold title + optional dim subtitle + optional right-aligned field.
// At most one `header` per section.
export interface SectionHeaderBlock {
  readonly kind: "header";
  readonly title: string; // bold, left
  readonly subtitle?: string; // dim, follows title after " · "
  readonly right?: string; // dim, right-aligned to terminal width
}

// Dim horizontal rule at terminal width.
export interface SectionDividerBlock {
  readonly kind: "divider";
}

// One line of {symbol,count,label} pills separated by three spaces.
// Palette: symbol takes severity color, count takes bold, label takes default.
export interface SectionBadgesBlock {
  readonly kind: "badges";
  readonly badges: readonly {
    readonly symbol: "●" | "◐" | "✓" | "✗" | "!" | "↓" | "↑";
    readonly count: number;
    readonly label: string;
    readonly severity: "info" | "success" | "warn" | "error" | "muted";
  }[];
}

// Group heading (symbol · name · count) followed by an indented flat list.
// A `group` item does NOT nest sub-items — nested detail is a separate `indented-block`.
export interface SectionGroupBlock {
  readonly kind: "group";
  readonly symbol: "●" | "◐" | "✓" | "✗" | "!";
  readonly severity: "info" | "success" | "warn" | "error" | "muted";
  readonly name: string; // e.g. "todo" / "in_progress" / "done"
  readonly count: number; // total in this group, may exceed items.length
  readonly rightHint?: string; // e.g. "showing 5 · archloop tasks list --all"
  readonly items: readonly {
    readonly id: string; // cyan, fixed 18-char left-pad, e.g. AutoTuneAgent-2mr
    readonly title: string; // default color, tail-truncated with …
    readonly trailingDim?: string; // right-side dim badge (owner, prd-warn, remote ref)
  }[];
  readonly footerDim?: string; // e.g. "… 16 more"
}

// Left-aligned key/value block. Keys share a fixed gutter width (max 12 chars).
// Values wrap onto continuation lines aligned to the gutter.
export interface SectionKvBlock {
  readonly kind: "kv";
  readonly gutter: number; // fixed left column width (typ. 12)
  readonly rows: readonly {
    readonly key: string; // bold
    readonly value: string; // may wrap
    readonly secondary?: string; // dim, appended after value (e.g. "(beads: in_progress)")
  }[];
}

// Free-flowing paragraph. Renderer only soft-wraps; no reformatting.
export interface SectionProseBlock {
  readonly kind: "prose";
  readonly title?: string; // bold, one line above the body
  readonly body: string;
}

// Deeply-indented composite block. Used for the currently active task in a Hub run card.
// Leading glyph + main line + N dim sub-lines. Not nested inside `group`.
export interface SectionIndentedBlock {
  readonly kind: "indented-block";
  readonly leading: "↳" | "✓" | "✗" | "◐";
  readonly leadingSeverity: "info" | "success" | "warn" | "error" | "muted";
  readonly id?: string; // cyan, follows leading glyph
  readonly title: string; // wraps at column budget without truncation
  readonly subLines: readonly string[]; // dim, indented one level below title
}

// One line: dim label + one or more command hints separated by "   ·   ".
// `tip` accepts multiple; `next` / `fix` accept exactly one.
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
```

### 2.2 `TaskBoardModel` — drives Hub task board view (`src/taskBoard.ts`)

```ts
export interface TaskBoardModel {
  readonly header: SectionHeaderBlock; // "archLoop · <project>" + right="21 tasks"
  readonly divider: SectionDividerBlock;
  readonly badges: SectionBadgesBlock; // ● todo · ◐ in_progress · ✓ done
  readonly groups: readonly SectionGroupBlock[]; // one per non-empty status
  readonly footer: SectionFooterBlock; // tip: show <id> · pull
  readonly warningSummary?: SectionProseBlock; // rendered only when PRD warnings exist
}

export interface BuildTaskBoardModelInput {
  readonly projectName: string;
  readonly board: HubTaskBoard;
  readonly warningFilter?: PrdWarningSeverity;
  readonly showAll: boolean; // maps to --all flag
  readonly perGroupLimit?: number; // default 5 when !showAll
}

export const buildHubTaskBoardModel: (
  input: BuildTaskBoardModelInput,
) => TaskBoardModel;
```

### 2.3 `RunCardSectionModel` — one per state transition (`src/hubRunCard.ts`)

Each `section` snapshot emitted during a Hub run:

```ts
export type RunCardTransitionKind =
  | "run.started"
  | "batch.started"
  | "task.started"
  | "task.phase-changed" // only on cross-phase (implementing → reviewing)
  | "task.completed"
  | "task.failed"
  | "batch.completed"
  | "run.completed"
  | "run.failed";

export interface RunCardSectionModel {
  readonly kind: RunCardTransitionKind;
  readonly header: SectionHeaderBlock; // project · flow · run <short> · elapsed
  readonly batches: readonly (
    | { readonly kind: "collapsed"; readonly summary: string } // "✓  batch daca6200   1 task   done"
    | {
        readonly kind: "current";
        readonly line: SectionGroupBlock;
        readonly current: SectionIndentedBlock;
      }
  )[];
  readonly footer: SectionFooterBlock; // logs path + tip / next / fix
  readonly spinnerText?: string; // e.g. "◐ AutoTuneAgent-2mr · implementing · 3m12s · run 74cc88e3"
}
```

Convention: exactly one batch is `current` at any time; earlier batches are `collapsed`.

### 2.4 `TaskDetailModel` — drives `archloop tasks show`

```ts
export interface TaskDetailModel {
  readonly header: SectionHeaderBlock; // "archLoop · task · <id>" + right=<status> · <owner>
  readonly identity: SectionKvBlock; // title / status / labels / origin / kind / remote
  readonly description: SectionProseBlock;
  readonly comments?: SectionProseBlock; // rendered as prose with "author · date  body" lines
  readonly footer: SectionFooterBlock; // next: update <id> · gh pr view N
}

export const buildHubTaskDetailModel: (
  task: HubTaskProjection,
) => TaskDetailModel;
```

### 2.5 `SyncResultModel` — drives `archloop tasks pull`

```ts
export interface SyncResultModel {
  readonly header: SectionHeaderBlock; // "archLoop · sync · <project>" + right=<remote/repo>
  readonly pullLine: SectionKvBlock; // "↓ pulled  4 created  (0 updated · 0 conflicts · 0 dup)"
  readonly pushLine: SectionKvBlock;
  readonly duration: SectionProseBlock; // "done in 1.4s"
  readonly conflicts?: SectionGroupBlock; // shown only when conflicts.length > 0
  readonly footer: SectionFooterBlock; // next: list / resolve <id>
}
```

Note: pull/push lines use `kv` (not `badges`) because the value is a mixed color/dim compound
string, easier to represent as one kv row than to invent a new pill palette.

### 2.6 `RunPlanModel` — drives the pre-run confirmation section

```ts
export interface RunPlanModel {
  readonly header: SectionHeaderBlock; // "archLoop · run"
  readonly plan: SectionKvBlock; // flow / project / ready (3 rows, gutter 10)
  readonly footer: SectionFooterBlock; // tip: "starting in 3s · Ctrl+C to cancel · e to edit flow"
}
```

The `flow` row uses `secondary: "(last used · Enter to accept)"`; `project` uses
`secondary` = the resolved repo path (Variant C's `←` indicator lives in `secondary`).

---

## 3. Display service surface change

### 3.1 Diff shape (`src/Display.ts`)

```diff
 export type DisplayEntry =
   | { readonly _tag: "intro"; readonly title: string }
   | { readonly _tag: "status"; readonly message: string; readonly severity: Severity }
   | { readonly _tag: "spinner"; readonly message: string }
   | { readonly _tag: "summary"; readonly title: string; readonly rows: Record<string, string> }
   | { readonly _tag: "taskLog"; readonly title: string; readonly messages: ReadonlyArray<string> }
   | { readonly _tag: "text"; readonly message: string }
-  | { readonly _tag: "toolCall"; readonly name: string; readonly formattedArgs: string };
+  | { readonly _tag: "toolCall"; readonly name: string; readonly formattedArgs: string }
+  | { readonly _tag: "section"; readonly title: string; readonly blocks: ReadonlyArray<SectionBlock> };

 export interface DisplayService {
   readonly intro: (title: string) => Effect.Effect<void>;
   readonly status: (message: string, severity: Severity) => Effect.Effect<void>;
   readonly spinner: <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
   readonly summary: (title: string, rows: Record<string, string>) => Effect.Effect<void>;
   readonly taskLog: <A, E, R>(title: string, effect: (message: (msg: string) => void) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
   readonly text: (message: string) => Effect.Effect<void>;
   readonly toolCall: (name: string, formattedArgs: string) => Effect.Effect<void>;
+  readonly section: (title: string, blocks: ReadonlyArray<SectionBlock>) => Effect.Effect<void>;
 }
```

Existing methods (`summary` etc.) remain — Phase 1 does **not** delete them. They will migrate to
`section` in Phase 2 and Phase 3; some (`taskLog`, `spinner`) stay forever because they wrap effects.

### 3.2 `SilentDisplay.section` — records blocks verbatim

```ts
section: (title, blocks) =>
  Ref.update(ref, (entries) => [
    ...entries,
    { _tag: "section" as const, title, blocks },
  ]),
```

Tests assert on the structure: `expect(entries).toContainEqual({ _tag: "section", title: ..., blocks: expect.arrayContaining([...]) })`.
This replaces `toContain("Hub task board")` on stdout strings.

### 3.3 `FileDisplay.section` — flatten blocks to plain paragraphs

```ts
section: (title, blocks) =>
  appendToLog([title, "", ...flattenSectionForLog(blocks), ""].join("\n")),
```

Rules for `flattenSectionForLog`:

- `header` → `title · subtitle    right` (single line, spaces instead of ANSI right-align).
- `divider` → omit (the log's own line separator is enough).
- `badges` → `● 2 todo   ◐ 1 in_progress   ✓ 5 done` (symbols preserved, no color).
- `group` → heading line then two-space-indented `id  title  trailingDim`.
- `kv` → `key: value` per row (secondary appended after value with `  `).
- `prose` → `title` on its own line (if present), then body.
- `indented-block` → `↳ id  title` and 4-space-indented sub-lines.
- `footer` → `tip   cmd1   ·   cmd2`.

Preserves grep-ability: `grep "AutoTuneAgent-2mr"` still hits.

### 3.4 `ClackDisplay.section` — direct `console.log`

Uses `console.log` (not `clack.note` — the whole point is to escape the `│` gutter). Still framed by
`clack.intro` / `clack.outro` from the surrounding command:

```ts
section: (title, blocks) =>
  Effect.sync(() => {
    const cols = terminalColumns();       // process.stdout.columns ?? 100
    const palette = detectPalette();      // see §5
    for (const line of renderSection(title, blocks, { cols, palette })) {
      console.log(line);
    }
    console.log("");                      // one blank line after every section
  }),
```

`renderSection` lives in `src/section.ts` and is pure (blocks + config → `string[]`).

---

## 4. Rendering algorithms — one per block kind

Every algorithm below assumes a resolved `cols` and `palette`. Common helpers:
`padRight`, `truncateTail(s, n) → s.slice(0, n-1) + "…"`, `truncateHead(s, n) → "…" + s.slice(-(n-1))`,
`rightAlign(left, right, cols) → left + " ".repeat(cols - w(left) - w(right)) + right`.

**Width adaptation policy** (applies to every block):

- Terminal < 40 cols → linear un-aligned output (no right-align, no `divider`; groups collapse to one line each).
- 40 ≤ cols ≤ 100 → target layout; `id` column shrinks to 14 chars, title truncates hard.
- 100 < cols ≤ 120 → target layout at full 18-char id column.
- cols > 120 → clamp to 120 (never spread further; extra whitespace on the right).

### 4.1 `header`

At 100 cols:

```
archLoop · autotuneagent                                                21 tasks
```

- Left: `bold("archLoop")` + `dim(" · ")` + `cyan(title)` + (subtitle ? dim(` · ${subtitle}`) : "").
- Right: `dim(right)`, right-aligned via `rightAlign`.
- If left width + right width + 2 > cols → drop `subtitle`; still won't fit → drop `right` and just print left.

At 80 cols: identical layout, less padding. At 120 cols: identical layout, more padding.

**NO_COLOR**: `archLoop · autotuneagent                                                21 tasks` — symbols kept, styling stripped.

Used by: every screen.

### 4.2 `divider`

`dim("─".repeat(cols))`. Under `--plain` / non-TTY: skipped entirely (a blank line is enough).
Never truncates; always exactly one row.

Used by: task board (below header), sync result (optional).

### 4.3 `badges`

```
●  0 todo       ◐  0 in_progress       ✓ 21 done
```

- Each badge: `severityColor(symbol) + " " + bold(count) + " " + label` (no coloring on label).
- Separator: three spaces.
- If overflow at cols: separator shrinks to one space; still overflow → wrap onto next line with
  hanging indent 2 (this is an unusual case at 40-cols min).

**NO_COLOR**: `●  0 todo       ◐  0 in_progress       ✓ 21 done` — same, no colors.

Used by: task board.

### 4.4 `group`

At 100 cols (18-char id column):

```
✓  done · 21                                       showing 5 · archloop tasks list --all
   AutoTuneAgent-0b7   Slice 2 · Expand Report Fragment columns (drift + latenc…
   AutoTuneAgent-0g4   Slice 1 · Divergence fail path — Runaway detection tracer…
   … 16 more
```

- Heading: `severityColor(symbol) + "  " + bold(name + " · " + count)` left + `dim(rightHint)` right.
- Items: `"   " + cyan(padRight(id, idWidth)) + "  " + truncateTail(title, titleBudget) + trailingDim`.
  - `idWidth = min(18, longestIdInGroup)`.
  - `titleBudget = cols - 3 - idWidth - 2 - trailingDimWidth - 1`.
  - `trailingDim` right-shifted by remaining spaces; if title + trailing don't both fit,
    truncate title first, drop trailing last.
- Footer: `"   " + dim(footerDim)`.

At 80 cols: `idWidth` shrinks to 14 (drops last four id chars? — no; ids stay full length, we
truncate the title column harder instead). At 120: budget expands; titles rarely truncate.

**NO_COLOR**: `✓  done · 21` + plain rows. Symbols kept.

Used by: task board (multi-status), sync result (conflicts sub-section).

### 4.5 `kv`

At 100 cols (gutter 12):

```
title       Slice 2 · Remove TaskOrchestrator and legacy Test Task model from
            the run pipeline
status      in_progress   (beads: in_progress)
labels      slice-2, refactor, hub
origin      inbox         kind slice
remote      github#182    Yibeibankaishui/archLoop
```

- Each row: `bold(padRight(key, gutter)) + value + (secondary ? "  " + dim(secondary) : "")`.
- Value wraps at `cols - gutter`; continuation lines get `" ".repeat(gutter)`.
- `severity` colors on `value` come from the caller-supplied string (e.g. `yellow("in_progress")`
  is pre-baked before the block is built). The renderer does not re-parse status.

At 40 cols: reduce gutter to 6; still wrap. At 120: identical.

**NO_COLOR**: same layout, styling stripped.

Used by: task detail, run plan, sync result (pull/push lines).

### 4.6 `prose`

```
description
  We still keep a shadow TaskOrchestrator alongside the new HubRunner. Slice 2
  deletes it and rewires the two remaining call sites in the CLI.
```

- `title` (if present) on its own line, bold.
- Body soft-wrapped at cols - 2 (2-space hanging indent). No reformatting — trims trailing
  whitespace only.

**NO_COLOR**: same layout.

Used by: task detail (description, comments), warning summary, sync result (duration).

### 4.7 `indented-block`

```
   ↳  AutoTuneAgent-2mr   Slice 2 · Remove TaskOrchestrator and legacy Test Task
                          model from the run pipeline
                          implementing · 3m12s in this step
```

- Line 1: `"   " + severityColor(leading) + "  " + cyan(id) + "   " + title` (soft-wrapped to
  continuation column at `w("   ↳  " + id + "   ")`).
- Sub-lines: same continuation indent, `dim(subLine)`.
- Title **wraps**, does not truncate (this is the "spotlight" block; user needs to read the whole
  title).

At 40 cols: still wraps; if a single word longer than the budget, hard-break with `…`.

**NO_COLOR**: symbol + text preserved.

Used by: Hub run card (current task), task board (never — flat groups only).

### 4.8 `footer`

```
tip   archloop tasks show <id>   ·   archloop tasks pull
next  archloop tasks list
fix   archloop run --resume 74cc88e3 --only-failed
```

- `dim(padRight(label, 6)) + commands.join("   ·   ")` where `commands` is `[command]` for `next` /
  `fix` and the array as-given for `tip`.
- If overflow: wrap subsequent commands to a new line with a 6-space indent.

**NO_COLOR**: same layout.

Used by: every screen.

---

## 5. Color detection & palette

### 5.1 Decision matrix

Implemented in a new file `src/ansi.ts`:

```ts
export type Palette = "color" | "plain";

export const detectPalette = (
  env = process.env,
  tty = process.stdout.isTTY,
): Palette => {
  if (env.FORCE_COLOR === "1" || env.FORCE_COLOR === "true") return "color";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "plain";
  if (globalPlainFlag()) return "plain"; // --plain CLI flag; module-level state, set in cli.ts main
  if (!tty) return "plain";
  return "color";
};
```

`FORCE_COLOR=1` wins even on non-TTY (this matches the `chalk` / `picocolors` convention and lets
CI produce colored logs when desired).

### 5.2 Palette table

| role   | ANSI (via `picocolors`) | example                                                        |
| :----- | :---------------------- | :------------------------------------------------------------- |
| bold   | `\e[1m`                 | headers, key names, primary counts                             |
| dim    | `\e[2m`                 | subtitles, timestamps, footer labels, elided paths, `… N more` |
| green  | `\e[32m`                | ✓ done, success counts, ↓ pulled counts                        |
| yellow | `\e[33m`                | ◐ in_progress, warnings, ⚠ prd-warn badges                     |
| red    | `\e[31m`                | ✗ failed, blocked, error counts, footer `fix` label            |
| cyan   | `\e[36m`                | Beads ids, run short-ids, external refs (`github#182`)         |

**Recommendation: adopt `picocolors`** (already indirectly present as a transitive dep of clack).

- 4 KB, zero deps, honors `NO_COLOR` / `FORCE_COLOR` natively — same knobs we already require.
- `styleText` from `node:util` (currently used in `Display.ts`) also works and needs no dep add;
  it's fine to keep it, but `picocolors` gives us `pc.dim(pc.bold(x))` composition that reads
  cleaner in `renderSection`. Given `styleText` is already vendored, we'll use it exclusively —
  no new dep. Justification: one fewer dep bump beats syntactic sugar. Decision: **use
  `node:util#styleText` for Phase 1 & 2**; revisit if it turns out slow (it's not).

Under `palette === "plain"`, every `style(x)` call short-circuits to `x` — implement with a small
helper `style(text, ...ansi): string` that inspects the current palette.

---

## 6. Hub run card state machine

Every transition below emits `d.section(title, blocks)` **once** and (in TTY color mode) restarts
the bottom-of-screen spinner with the new `spinnerText`. `title` is always the empty string — the
`header` block carries the visible title; `title` is only used by `SilentDisplay` for keying.

### 6.1 Transition table

| Transition           | Section blocks                                                                                                                                                         | Diff vs. previous section                                                                          | Spinner text                                           |
| :------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| `run.started`        | `header(project · flow · run <short> · 0m00s)` · `footer(logs …/runs/<short>/)`                                                                                        | first section — nothing prior                                                                      | `◐ waiting · plan · 0s · run <short>`                  |
| `batch.started`      | header · one `group` per completed batch (collapsed) · one `group` for the new active batch (empty items)                                                              | previous active batch → collapsed row                                                              | `◐ batch <short> · planning · 0s · run <short>`        |
| `task.started`       | header · collapsed batches · active batch `group` · `indented-block` for the current task                                                                              | current batch body replaced by the new task's `indented-block`                                     | `◐ <task-id> · implementing · 0s · run <short>`        |
| `task.phase-changed` | header · collapsed batches · active batch `group` · `indented-block` (updated `subLines`)                                                                              | `indented-block.subLines[0]` changes phase name & elapsed                                          | `◐ <task-id> · <new-phase> · 0s · run <short>`         |
| `task.completed`     | header · collapsed batches · active batch `group` · `indented-block` (leading=`✓`, subLines shows duration)                                                            | leading glyph `↳` → `✓`; subLines now `done · <duration>`                                          | (spinner stops; new one starts on next `task.started`) |
| `task.failed`        | header · collapsed batches · active batch `group` · `indented-block` (leading=`✗`, subLines shows reason)                                                              | leading glyph → `✗`; subLines dim red with `! <reason>`                                            | (spinner stops)                                        |
| `batch.completed`    | header · every batch collapsed (including this one) · footer(logs)                                                                                                     | active batch → collapsed row `✓ batch <short> ... done` or `✗ batch <short> ... failed at <phase>` | (spinner stops if no next batch pending)               |
| `run.completed`      | header (right becomes `✓ <total>`) · collapsed batches · footer(logs + `summary  N merged · M failed`) · `footer(next  archloop tasks list)`                           | header right field switches to a green ✓ + total elapsed; extra footer line appended               | (spinner terminated)                                   |
| `run.failed`         | header (right becomes `✗ <elapsed>`) · collapsed batches · `indented-block(leading=✗, subLines=[reason])` · `footer(fix  archloop run --resume <short> --only-failed)` | header right red; final failing task's block preserved                                             | (spinner terminated)                                   |

### 6.2 Sub-phase policy

Cross-phase transitions (`implementing → reviewing`, `reviewing → merging`, etc.) emit a **new
section**. Sub-phase ticks inside the same phase (e.g. `implementing → running tests → committing`
inside `implementing`) update **only the spinner text** — no new section. Reason: the value of
scrollback timeline is capturing phase boundaries; sub-phase ticks are heartbeat noise.

### 6.3 Spinner text template

Per ADR-0032:

```
◐ <task-id> · <phase> · <phase-elapsed> · run <run-short-id>
```

`<phase-elapsed>` updates every **1000 ms** via a `setInterval` inside `createHubRunSpinner`.
Faster than 1000 ms would flicker; slower loses heartbeat feel. If the run has no active task
(between batches), template becomes `◐ batch <short> · <batch-phase> · <elapsed> · run <short>`.

### 6.4 Non-TTY behavior

When `detectPalette() === "plain"` **or** `!process.stdout.isTTY`:

- Spinner is a no-op (never starts).
- Sections still get appended (via `console.log`), so the log stream is complete.
- Phase-elapsed on the spinner line disappears entirely; users tailing a log get the section
  timestamps which are already in each `header`.

### 6.5 Pseudo-code sketch

```ts
export const createHubRunCard = (d: DisplayService) => {
  let spinner: clack.Spinner | undefined;

  const onTransition = (t: RunCardTransitionKind, model: RunCardSectionModel) =>
    Effect.gen(function* () {
      if (spinner) {
        spinner.stop(spinner.lastText, /* preserve line */ true);
        spinner = undefined;
      }
      yield* d.section("", modelToBlocks(model));
      if (
        model.spinnerText !== undefined &&
        process.stdout.isTTY &&
        detectPalette() === "color"
      ) {
        spinner = clack.spinner();
        spinner.start(model.spinnerText);
        startPhaseElapsedTicker(spinner, model);
      }
    });

  return { onTransition, dispose: () => spinner?.stop() };
};
```

The dispatcher lives at whatever call site emits `HubBatchStartedEvent` / `HubTaskEvent` today
(inside `hubFlowExecution.ts`) — reuse the existing event stream; do **not** invent a new one.

---

## 7. `archloop run` interactive flow rewrite

### 7.1 New flow (pseudocode)

```ts
export const RUN_START_DEBOUNCE_MS = 3_000; // named export, tuneable

const interactiveRunFlow = (input: RunInputs) => Effect.gen(function* () {
  const d = yield* Display;

  // 1. Existing flow-selection prompt at cli.ts:3656 STAYS.
  const flowId = input.flow ?? (yield* resolveInteractiveRunFlowSelection(...));

  // 2. Build the plan model and render one section.
  const model = buildRunPlanModel({
    projectName: input.targetProjectName,
    repoRoot: input.repoRoot,
    flowId,
    validatedInput: input.validatedInput,
    readyCount: input.readyCount,
  });
  yield* d.section("", modelToBlocks(model));

  // 3. Debounce loop (only in TTY-color mode; short-circuit otherwise).
  if (input.yes || input.dryRun || !process.stdin.isTTY || !process.stdout.isTTY) {
    return; // start immediately
  }

  const outcome = yield* waitForKeypress({
    timeoutMs: RUN_START_DEBOUNCE_MS,
    keyMap: {
      "": "cancel",   // Ctrl+C
      "e":      "edit",     // return to flow selection
      "E":      "edit",
    },
    defaultOnAny: "start",
    defaultOnTimeout: "start",
  });

  if (outcome === "cancel") yield* Effect.fail(new HubFlowError({ message: "Run cancelled." }));
  if (outcome === "edit")   yield* interactiveRunFlow({ ...input, flow: undefined }); // recurse
  // outcome === "start" → fall through
});
```

### 7.2 `waitForKeypress` helper

Lives in `src/keypress.ts` (new). Sets stdin to raw mode, listens for a single byte, cleans up on
exit / timeout. Returns `"start" | "edit" | "cancel"`. Does **not** import `readline` — direct
`data` event on `process.stdin` is enough. Signals SIGINT via `process.emit("SIGINT")` when
`` is received, so parent Effect stack unwinds correctly.

### 7.3 Delete list

- `confirmRunPlan` (`cli.ts:3841-3858`).
- The `if (isInteractive) { yield* confirmRunPlan(); }` block at `cli.ts:4379-4381`.
- The old `d.summary("Hub run plan", buildRunPlanSummaryRows(...))` call at `cli.ts:4368-4377`
  (replaced by `d.section("", modelToBlocks(model))` inline).

### 7.4 Behavior guarantees

- **`--yes` / `ARCHLOOP_RUN_YES=1`** — same as before: skip prompt, run immediately.
- **`--dry-run`** — skip debounce, print the section, exit before starting the flow.
- **Non-TTY** — always skip debounce.
- **`e` → return to flow selection** — recurses into `interactiveRunFlow` with
  `flow: undefined`, which re-triggers `resolveInteractiveRunFlowSelection`.

---

## 8. Test migration strategy (Q9 verdict)

**Verdict: hybrid.** Characterization tests migrate to model-layer assertions (the durable contract);
e2e string assertions in `cli.test.ts` update to the new UI text (fragile but necessary for
end-to-end sanity); unit tests in `taskBoard.test.ts` migrate to model.

### 8.1 Migration table

| Test                                                                      | Current shape                              | New shape                                                                                                                               |
| :------------------------------------------------------------------------ | :----------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| `taskBoard.test.ts:424 expect(lines).toContain("Hub task board")`         | string in `formatHubTaskBoardLines` output | delete — string no longer emitted; new: `expect(model.header.title).toBe("archLoop")`                                                   |
| `taskBoard.test.ts:425 expect(lines).toContain("Total tasks: 2")`         | ditto                                      | `expect(model.header.right).toBe("2 tasks")`                                                                                            |
| `taskBoard.test.ts:426-427 group counts`                                  | `inbox (1)` / `ready_for_agent (1)`        | `expect(model.groups.map(g => [g.name, g.count]))`                                                                                      |
| `taskBoard.test.ts:428-429 ordinal rows`                                  | `  1. bd-1: Inbox task`                    | delete ordinal assertion; assert `model.groups[i].items[j] === { id: "bd-1", title: "Inbox task" }`                                     |
| `taskBoard.test.ts:470 PRD warning summary`                               | string                                     | migrate to `warningSummary` prose block on the model                                                                                    |
| `taskBoard.test.ts:502 Total tasks: 1`                                    | string                                     | `expect(model.header.right).toBe("1 task")`                                                                                             |
| `taskBoard.test.ts:504 warning list row with ordinal`                     | `  1. bd-1: High warning [high]`           | drop ordinal; keep `trailingDim: "⚠ prd-warn"` assertion on the item                                                                    |
| `cli.test.ts:1596 stdout toContain "Hub task board"`                      | live stdout                                | change to `toContain("archLoop")` and `toContain("autotuneagent")`                                                                      |
| `cli.test.ts:1667 stdout toContain "Hub task board"`                      | ditto                                      | ditto                                                                                                                                   |
| `cli.test.ts:1668 stdout toContain "Total tasks: 3"`                      | ditto                                      | `toContain("3 tasks")`                                                                                                                  |
| `cli.test.ts:1669-1674 status group + ordinal lines`                      | ordinal-based                              | update to non-ordinal form: `toContain("  bd-1  Inbox task")` etc.                                                                      |
| `cli.test.ts:1730 warning severity suffix`                                | `[high]` suffix                            | switch to `toContain("⚠ prd-warn")` or `toContain("[high]")` if we keep                                                                 |
| `cli.test.ts:2504 stdout toContain "Synced Hub tasks with GitHub Issues"` | live stdout                                | `toContain("sync")` + `toContain("pulled")`                                                                                             |
| `cli.test.ts:2763 stdout toContain "Pushed: 0 synced, 1 closed"`          | live stdout                                | `toContain("1 closed")` (the "0 synced" is now dim)                                                                                     |
| `cliRunProjectCentric.test.ts:197,227,244,268,358 title: "Hub run plan"`  | SilentDisplay summary entry                | switch to `expect.objectContaining({ _tag: "section", title: "" })` + assert `.blocks[0]` header                                        |
| `cliRunProjectCentric.test.ts:308,353 confirm "Run this Hub flow now?"`   | clack.confirm mock                         | delete; new: assert absence of `mockConfirm` call, and — where TTY — assert `waitForKeypress` was called with `RUN_START_DEBOUNCE_MS`   |
| `Display.test.ts` (existing)                                              | asserts existing methods                   | add a new suite for `section`: `SilentDisplay` records blocks verbatim; `FileDisplay` flattens; `ClackDisplay` prints per fixture width |

### 8.2 Non-test occurrences to leave alone

- `hubPrdDecomposition.ts:542-545` — `Total tasks: N` inside `formatHubTaskSummaryText`. This is
  **agent prompt content**, not CLI output. Leave untouched.
- `hubTriageProposal.ts:487-490` — same rationale.
- `hubPrdDecomposition.test.ts:522` — asserts the agent prompt contains `Total tasks: 0`. Leave.

---

## 9. Breakage inventory

### 9.1 New files (**Adds**)

| File                     | Reason                                                                                |
| :----------------------- | :------------------------------------------------------------------------------------ |
| `src/section.ts`         | `SectionBlock` union + `renderSection` (block → string[]) + `flattenSectionForLog`    |
| `src/ansi.ts`            | `detectPalette` + `style` helper + `--plain` module flag                              |
| `src/keypress.ts`        | `waitForKeypress` helper for the run debounce loop                                    |
| `src/hubRunCard.ts`      | `buildRunCardSectionModel` + `createHubRunCard` (spinner lifecycle)                   |
| `src/section.test.ts`    | Unit tests for the 8 block renderers at 40 / 80 / 100 / 120 cols with color and plain |
| `src/ansi.test.ts`       | Palette detection matrix                                                              |
| `src/keypress.test.ts`   | Timeout, Ctrl+C, `e`, arbitrary-key cases                                             |
| `src/hubRunCard.test.ts` | Transition table drives fixtures                                                      |

### 9.2 **Modifies**

| File                                      | Change                                                                                                                                                                                                                                                                                |
| :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/Display.ts`                          | Add `section` to `DisplayService`, `DisplayEntry`; implement in all three layers                                                                                                                                                                                                      |
| `src/taskBoard.ts` (~lines 1880-2000)     | Replace `formatHubTaskBoardLines` return with `buildHubTaskBoardModel` (retain a thin string wrapper only until Phase 4 removal); replace `formatHubTaskDetailsRows` with `buildHubTaskDetailModel`; `formatHubTaskCommentLines` folds into the detail model's `comments` prose block |
| `src/hubTaskSync.ts` (~line 737)          | Add `buildSyncResultModel` alongside legacy `formatHubTaskSyncSummaryLines`                                                                                                                                                                                                           |
| `src/cli.ts` (~1975-2050)                 | `tasksListCommand` / `tasksShowCommand` / `tasksSyncCommand` switch from `d.text(line)` loop to a single `d.section("", modelToBlocks(model))`                                                                                                                                        |
| `src/cli.ts` (~3800-4382)                 | Delete `confirmRunPlan` + `buildRunPlanSummaryRows`; replace with `buildRunPlanModel` + `interactiveRunFlow` debounce                                                                                                                                                                 |
| `src/cli.ts` main                         | Wire `--plain` flag → set module-level flag consumed by `detectPalette`                                                                                                                                                                                                               |
| `dist/hubRunLiveDisplay.js`-shaped source | See 实施前提：after rebasing on latest main, this file exists as `src/hubRunLiveDisplay.ts` (~500 lines). Rewrite it to emit `RunCardSectionModel` per transition instead of full in-place refresh with `CURSOR_UP`; shrinks to ~200 lines.                                           |
| `src/hubExecution.ts`                     | No structural change; the transition dispatcher reuses existing events                                                                                                                                                                                                                |
| `src/taskSelectorsArg` description        | Change wording per ADR-0031: `"Beads id, or exact task title."`                                                                                                                                                                                                                       |

### 9.3 **Deletes**

| Symbol                                                                      | Reason                                                       |
| :-------------------------------------------------------------------------- | :----------------------------------------------------------- |
| `confirmRunPlan` (cli.ts:3841-3858)                                         | Replaced by 3-second keypress debounce                       |
| `buildRunPlanSummaryRows` (cli.ts:3812-3839)                                | Replaced by `buildRunPlanModel`                              |
| Ordinal computation in `formatHubTaskBoardLines` (taskBoard.ts:1912-1917)   | ADR-0031                                                     |
| `HIDE_CURSOR` / `CURSOR_UP` / `clearRenderedRegion` in the live-view module | ADR-0032 — no more cursor-up outside the single spinner line |

### 9.4 **Doc updates**

| File                             | What changes                                                                                                                |
| :------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `skills/archloop-usage/SKILL.md` | Any mention of `Hub task board` output format; new failure-mode note about `--plain` / `NO_COLOR`; run debounce explanation |
| `README.md`                      | `archloop tasks list` sample output block (currently shows `Total tasks:`); the `archloop run` interactive flow section     |
| `readme_cn.md`                   | Mirror of `README.md` changes                                                                                               |
| `user_guide.md`                  | Sample outputs for tasks list / show / pull / run                                                                           |
| `docs/roadmap.md`                | Add "CLI Variant C visual overhaul" phase with `Status` / `Deliverables`                                                    |
| `docs/adr/0030-*.md`             | (no change — already authoritative for Phase 1)                                                                             |

### 9.5 **Changesets to add**

- `visual-overhaul-variant-c.md` — patch — describes the new `section` primitive, new output style,
  new run debounce; calls out `--plain` / `NO_COLOR` / `FORCE_COLOR`.
- `drop-ordinal-task-selector.md` — **already exists per prompt note**; verify no duplicate before
  adding. If Phase 3 lands after Phase 2, we may need `run-card-append-only.md` — a separate
  patch changeset for the ADR-0032 behavior. Keep changesets one per user-visible slice, not one
  per PR.

---

## 10. Phased rollout

Each phase is one PR (or a very small stack). Each phase leaves `main` in a shippable state.

### Phase 1 · Foundation (~2 days)

**Adds**: `src/section.ts`, `src/ansi.ts`, `src/section.test.ts`, `src/ansi.test.ts`.
**Modifies**: `src/Display.ts` (add `section` on all three layers).
**Untouched**: every existing screen. `clack.note` calls all still in place.

Ship gate: `npm run typecheck` clean; every block kind has a unit test at 40 / 100 / 120 cols in
color and plain modes.

Why first: nothing depends on it, but every later phase does. Zero user-visible change.

### Phase 2 · Static screens (`tasks list` / `tasks pull` / `tasks show`) (~2 days)

**Modifies**: `src/taskBoard.ts`, `src/hubTaskSync.ts`, `src/cli.ts` (tasks subcommands only).
**Test migration**: `taskBoard.test.ts` → model assertions; `cli.test.ts:1596/1667/1668/2504/2763` → new substrings.
**Behavior change (breaking)**: ordinal removed from list output; `taskSelectorsArg` description
updated. Add `drop-ordinal-task-selector.md` changeset if not already present.

Ship gate: `npm run typecheck` clean; `npm test -- taskBoard cli` green; visual smoke test:
`archloop tasks list` in a real repo matches Variant C mockup ± minor whitespace.

Why second: 3 static screens are 80% of the visual gain, 20% of the risk. `hubRunLiveDisplay` stays
on legacy path — a run's live view is unchanged. This buys observation time before Phase 3.

### Phase 3 · Hub run card + run interactive flow (~3 days)

**Adds**: `src/hubRunCard.ts`, `src/keypress.ts`, related tests.
**Modifies**: the live-view module (heavy rewrite: alt-screen-style refresh → append-only sections + single spinner); `src/cli.ts` run command (delete `confirmRunPlan`; add debounce).
**Test migration**: `cliRunProjectCentric.test.ts:308/353` etc.

Ship gate: dogfood a real Hub run end-to-end; verify scrollback is clean (no cursor-up artifacts,
no residual escape sequences); verify Ctrl+C during debounce cancels cleanly; verify
`--yes` still short-circuits.

Why third: biggest surface, needs Phase 2 lessons on model shape before locking the run card model
signature.

### Phase 4 · Cleanup + docs (~1 day)

- Update `skills/archloop-usage/SKILL.md`, `README.md`, `readme_cn.md`, `user_guide.md` sample
  outputs.
- Delete legacy `formatHubTaskBoardLines` string API (keeping wrapper was only for Phase 2
  compatibility).
- Delete unused `d.summary(...)` call sites that got fully replaced.
- Publish changesets, cut a release.

Ship gate: `docs/roadmap.md` marks the phase Done with a version stamp.

---

## 11. Open questions / deferred

- **Spinner lifecycle across `d.spinner` and `createHubRunCard`** — both wrap `clack.spinner()`.
  Decision (subordinate): the run card owns its spinner directly; `d.spinner` is for one-shot
  effects and stays as-is. No shared abstraction — the coupling would cost more than it saves.
- **Whether `tasks list` default should show `done` group** — mockup shows it dim by default; I'm
  keeping current behavior (show up to 5 done items with `… N more` footer). Revisit if users ask.
- **Interactive `e` key vs. Enter default** — mockup's Enter-to-accept survives only when there
  IS a "last used" flow. If it's the first run, Enter still starts (from the flow selector). No
  separate default-first-run wording; the debounce hint covers it.

---
