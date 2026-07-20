# archLoop CLI 视觉重构 · 四版方案索引

四份方案是**同一个问题的不同答案**，不是"四种优化程度"。选哪一版取决于你希望 `archloop` 长成什么形态
—— 命令、工具、仪表盘应用、还是有编辑口吻的产品。

- [Variant A · Minimal Unix / Plumbing Style](./cli-redesign-variant-a.md)
- [Variant B · Rich TUI Dashboard Style](./cli-redesign-variant-b.md)
- [Variant C · Moderate / Balanced Style](./cli-redesign-variant-c.md)
- [Variant D · Editorial / Brand-forward Style](./cli-redesign-variant-d.md)

---

## 一句话辨认

| 版本              | 一句话                                                                   | 类比                                             |
| :---------------- | :----------------------------------------------------------------------- | :----------------------------------------------- |
| **A · Plumbing**  | 像 `git status -s` —— 纯文本列对齐、单字母状态位、`--json` 一等公民      | `git`, `gh`, `kubectl`, `docker ps`              |
| **C · Balanced**  | 一屏 = header + 分隔线 + 段落 + 底部 tip，状态符 + 短 id + 少量颜色      | `pnpm`, `bun`, `astro`, `vite`                   |
| **B · Dashboard** | 一屏 = 多面板 alt-screen 应用，双线外框 + 进度条 + sparkline + hotkey 条 | `lazygit`, `k9s`, `btop`, `tig`                  |
| **D · Editorial** | 输出是被人写出来的句子，`↻` 品牌符 + 大量留白 + 三幕叙事 live view       | `vercel`, `bun install`, `astro dev`, `wrangler` |

---

## 屏幕感受对比（同一屏 · 四种呈现）

### `archloop tasks list` — 默认视图

**A · Plumbing**

```
$ archloop tasks list
ID        S  TITLE                                                            UPDATED
0g4       T  Slice 3 · Add retry backoff to Hub scheduler                     12m ago
2mr       R  Slice 2: Remove TaskOrchestrator and legacy Test Task model…    2m ago
# 1 todo · 1 running · 21 done (hidden) · --all to include done
```

**D · Editorial**

```
$ archloop tasks list

↻  autotuneagent  21 tasks tracked here.

You have 2 tasks in progress and nothing is blocked right now.
21 tasks have shipped this week — nice pace.

In progress
     AutoTuneAgent-2mr    Remove TaskOrchestrator and legacy Test Task model
     AutoTuneAgent-3aa    Wire archloop run into the new dispatcher

Next up
     AutoTuneAgent-3ab    Backfill regression fixtures for the divergence path
     AutoTuneAgent-3ac    Draft ADR for run-plan versioning

Show everything with archloop tasks list --all, or open one with archloop tasks show <id>.
```

**C · Balanced**

```
  archLoop · autotuneagent                                             8 tasks
  ──────────────────────────────────────────────────────────────────────────
  ● 2 todo       ◐ 1 in_progress       ✓ 5 done

  ●  todo · 2
     AutoTuneAgent-9k3   Slice 5 · Wire config validator into apply pipeline
     AutoTuneAgent-a12   fix(run_task): stop double-registering error handlers    ⚠ prd-warn

  ◐  in_progress · 1
     AutoTuneAgent-2mr   Slice 2 · Remove TaskOrchestrator and legacy Test Task…   yc.bai
  …
  tip   archloop tasks show <id>   ·   archloop tasks pull
```

**B · Dashboard**

```
┌─ archLoop tasks · autotuneagent ────── branch main · 2026-07-20 14:32 ─┐
│  READY 4   IN-PROG 2   BLOCKED 1   DONE 21   Σ 28   activity 7d ▁▂▄▂▇█▄ │
└─────────────────────────────────────────────────────────────────────────┘

active ───────────────────────────────────────────────────────────────────
 ● IN-PROG    AutoTuneAgent-2mr  Slice 2 · Remove TaskOrchestrator …    12m ago
 ● IN-PROG    AutoTuneAgent-4k1  Slice 1 · Divergence fail path         41m ago
 ◐ BLOCKED    AutoTuneAgent-9zx  Awaiting merger review                  3h ago

ready ────────────────────────────────────────────────────────────────────
 ○ READY      AutoTuneAgent-0b7  Slice 2 · Expand Report Fragment columns 2d ago
 …
done ─── 21 items collapsed ─── expand: `archloop tasks list --status done` ─
```

---

### `archloop run` live view — 运行中

**A · Plumbing**（一行一事件，NDJSON 投影）

```
$ archloop run with-review --yes
run  74cc88e3  project=autotuneagent  flow=with-review  logs=~/…/run-74cc88e3/
14:02:11  run    74cc88e3  start
14:02:45  batch  fd3cdf79  start    stage=planning       tasks=1
14:02:46  task   2mr       start    agent=planner
14:03:12  task   2mr       impl     agent=implementer
```

**D · Editorial**（三幕叙事 · 第二幕 Focus）

```
↻  Implementing AutoTuneAgent-2mr   29 min in

     Now: writing tests for the legacy import cleanup.
     Next: retiring `orchestrator/` and rewiring the run dispatcher.

     Since we started, we've
        edited 12 files, added 240 lines, deleted 118
        added 4 tests, 0 failing so far
        committed 3 checkpoints

Press l for the raw log, or s to send the agent a note.
```

**C · Balanced**

```
  archLoop · autotuneagent · with-review          run 74cc88e3 · 29m30s

  ✓  batch daca6200   1 task                                                 done
  ◐  batch fd3cdf79   1 task                                        planning · impl

     ↳  AutoTuneAgent-2mr   Slice 2 · Remove TaskOrchestrator and legacy Test Task
                            model from the run pipeline
                            implementing · 3m12s in this step

  logs   …/runs/run-74cc88e3/                              press o to open · l to tail
```

**B · Dashboard**

```
╔═ archLoop run · autotuneagent ═══════════════════════════════ elapsed 29:30 ═╗
║  flow with-review   run 74cc88e3   branch archloop/run-a41c   parallel 3/5   ║
╠═ progress ═══════════════════════════════════════════════════════════════════╣
║  ████████████░░░░░░░░  planning 40%    1 done · 1 running · 1 queued          ║
║  eta ≈ 12m  burn ≈ 2.3 tok/s  ▂▃▅▇▆▄▃                                        ║
╠═ batch stack ════════════════════════════════════════════════════════════════╣
║  ┏━━ batch fd3cdf79 · planning ━━━━━━━━━━━━━━━━━━━━━━ 12m ┓                  ║
║  ┃  ● implementing  AutoTuneAgent-2mr  Slice 2 …    00:12:04                 ║
║  ┃    patch ███████████░░░░░░░ 62%  typecheck ✓  test ▶ streaming            ║
║  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛                  ║
╠═ event stream · last 6 ══════════════════════════════════════════════════════╣
║  14:33:44  tool   run_terminal_cmd  `npm run typecheck`  ✓ 4.1s               ║
║  14:35:02  tool   apply_patch  packages/hub/src/tasks/…  +186 -102            ║
╠═ hotkeys ════════════════════════════════════════════════════════════════════╣
║  q quit   l logs   t tasks   b batches   c cancel task   p pause   ? more    ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## 维度对照表

| 维度                           | A · Plumbing                   | C · Balanced                                      | B · Dashboard                                         | D · Editorial                                                        |
| :----------------------------- | :----------------------------- | :------------------------------------------------ | :---------------------------------------------------- | :------------------------------------------------------------------- |
| 主视觉语言                     | 列对齐纯文本                   | header + 分隔线 + 段落                            | 面板 + 双线外框 + 进度条                              | 缩进 + 空行 + 一句人话                                               |
| 边框字符                       | 无                             | 一条 `───` 分隔线                                 | `┌ ┐ └ ┘ ┏ ┓ ╔ ╗` 多层级                              | 无                                                                   |
| 状态表达                       | `T / R / D / B / X` 单字母     | `● ◐ ✓` 三符号                                    | `● ◐ ○ ✓` 符号 + 徽章 + 颜色                          | 品牌符 `↻` 变色（green/yellow/red）+ 段落语气                        |
| 颜色                           | 只在 severity                  | 状态符号 + 数字 + tip                             | 全屏系统性上色                                        | 一种 accent + 灰阶层级                                               |
| 密度                           | 高                             | 中                                                | 高（多面板）                                          | 低（大量留白）                                                       |
| 语气                           | 机械（key=value）              | 中性（label · count）                             | 中性（面板 + metric）                                 | 人格化（句子 + CTA）                                                 |
| `--json`                       | 一等公民（等价投影）           | opt-in 兜底                                       | opt-in 兜底                                           | 必须提供（否则不 pipe）                                              |
| 管道友好                       | ★★★★★                          | ★★★☆☆                                             | ★★☆☆☆                                                 | ★☆☆☆☆                                                                |
| 上镜（截图/发布说明）          | ★★☆☆☆                          | ★★★★☆                                             | ★★★★★                                                 | ★★★★★                                                                |
| 首次运行的引导感               | ★★☆☆☆（要看 --help）           | ★★★★☆（有 tip / next）                            | ★★★★★（有 pre-flight + hotkey）                       | ★★★★★（本身即引导）                                                  |
| NO_COLOR 兜底难度              | 极低（本身近乎纯文本）         | 低（去色即可）                                    | 中（依赖颜色区分层级）                                | 中（品牌符 + prose 仍可读，但失色感明显）                            |
| 窄终端（≤ 80 列）健壮性        | ★★★★★                          | ★★★★☆                                             | ★★☆☆☆（外框会碎）                                     | ★★★★☆                                                                |
| 实现复杂度                     | 中（要绕开 clack.note）        | 中（要绕开 clack.note + 新增 board/runCard 原语） | 高（需 alt-screen + layout 引擎，接近重写 live view） | 中–高（无 alt-screen，但需 `messages.ts` + 语气规范 + 终端能力探测） |
| 与现有 `@clack/prompts` 契合度 | 低（大部分自写 stdout）        | 中（保留 spinner/select/confirm，去掉 note）      | 低（live view 基本不用 clack）                        | 低（clack 的 `◇` prompt 语气与叙事口吻冲突）                         |
| 测试迁移成本                   | 大（要重定 stdout 格式）       | 中（`toContain("Hub task board")` 类断言要改）    | 大（多面板 layout 难 snapshot 稳定）                  | 大（文案改一次全线断言要跟）                                         |
| 文案维护成本                   | 无                             | 低（个位数标题）                                  | 低（面板 label 复用）                                 | 高（每条 code path 都要一句人话）                                    |
| i18n 成本                      | 极低（几乎无文案）             | 低                                                | 低                                                    | 高（口吻直译会失真，需要重写）                                       |
| 品牌记忆点                     | 无（有意的）                   | 弱                                                | 中（面板/进度条视觉）                                 | 强（品牌符 + 语气）                                                  |
| 长期演进天花板                 | 低（就是 plumbing 该有的样子） | 中（可后期升级为 B）                              | 高（本身即终局形态）                                  | 高（本身即终局形态）                                                 |

---

## 我该选哪一版

四种典型情况：

**你想让 `archloop` 被写进别人的 Makefile / CI / shell alias / cron** → **A**。plumbing 派的核心赌注是
"命令行首先是**接口**，然后才是**界面**"；把 `--json` 抬到一等，人读输出是它的投影，就能拿到 `git` /
`kubectl` 那种"自然被拼进生态"的收益。代价：截图不上镜、首次使用不亲切、要认字母表。

**你想让 `archloop` 一眼看着舒服 · 但不想付重构 live view 的成本** → **C**。C 是"最小改动最大回报"的
中间点，两周落地、旧测试改动可控、旧交互（clack spinner / select / confirm）大部分能留，只是把
`clack.note` 的框去掉、新增两个高层原语（`board()` / `runCard()`），其它都是**排版和文案**。

**你想让 `archloop` 成为一款可以"盯屏"的运行时应用** → **B**。B 的核心赌注是"用户会在真实终端里长时
间盯着 archloop 跑"，值得一次 alt-screen + 面板刷新的架构级投资。它带来一屏一目了然的运行时全景、任
务级 sub-progress、事件流 + hotkey bar 的应用感。代价：≤ 80 列终端会碎、pipe / grep 场景基本得走
`--plain`、live view 是独立一次重写。

**你想让 `archloop` 成为一款有品牌记忆点、被截图分享的产品** → **D**。D 的核心赌注是"CLI 输出即产品的
声音"。品牌符 `↻` + 大量留白 + 三幕叙事 live view，效果类似 `bun install` / `vercel deploy`。代价：文
案维护成本永久性升高（`messages.ts` + code review 语气把关）、i18n 从"字符串替换"变成"重写文案"、pipe
场景必须走 `--json`/`--plain`、power user 会抱怨"太慢"。

**渐进路径**（我的默认推荐）：先做 **C** 落地一到两个 release，观察真实使用后再决定：

- 用户想更多脚本化 / 集成 → 补齐 A 的 `--json` + `--plain` 契约，把 C 的人读输出改成 A 的投影
- 用户想更多"盯屏"体验 → 把 `runCard()` 原语替换为 B 的 dashboard 实现，其它命令留在 C
- 你决定投资品牌 → 把 C 的输出层替换为 D 的文案层 + `↻`，其它排版原语保持不变

C 是**唯一一个能顺势演进到 A / B / D** 的起点。A、B、D 三者之间没有平滑路径 —— 互相演进都近乎重写。

如果你已经很确定"就想要那种感觉"、不需要渐进过渡：

- 极度想要工具感 → 直接选 **A**
- 极度想要 dashboard 感 → 直接选 **B**
- 极度想要品牌感 → 直接选 **D**

---

## 四份文档的位置

- `/home/bai/code/sandcastle/docs/cli-redesign-index.md` —— 本文件（对比索引）
- `/home/bai/code/sandcastle/docs/cli-redesign-variant-a.md` —— A · Plumbing 详细提案
- `/home/bai/code/sandcastle/docs/cli-redesign-variant-b.md` —— B · Dashboard 详细提案
- `/home/bai/code/sandcastle/docs/cli-redesign-variant-c.md` —— C · Balanced 详细提案
- `/home/bai/code/sandcastle/docs/cli-redesign-variant-d.md` —— D · Editorial 详细提案（含品牌符提案 + 语气示例）

每份文档都包含 5 屏（`tasks list` / `tasks pull` / `run 交互` / `run live view` / `tasks show`）的
Before + After 原型 + 设计说明 + 取舍代价。D 版额外包含 `品牌符提案` 与 `语气示例` 两节。
