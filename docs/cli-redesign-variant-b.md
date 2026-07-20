# Variant B · Rich TUI Dashboard Style

本方案将 `archloop` CLI 视作**一个单屏运行时仪表盘**，而不是一串日志。灵感来自 `lazygit` / `k9s` /
`btop` / `tig` / `gh dash`。每一条命令的输出都是一块"卡片式面板"，用 Unicode 框线切分承载不同信息
的区域，用颜色和 glyph 表达状态，用 sparkline / progress bar 表达时间维度。

配色标注约定（供读者对照，实际实现层由主题决定）：

- `[cyan]…[/]` 主色：品牌、面板标题、Task-ID、外部资源引用
- `[green]…[/]` 成功 / 完成 / 通过
- `[yellow]…[/]` 进行中 / 需要注意 / warning
- `[red]…[/]` 阻塞 / 错误 / 冲突
- `[dim]…[/]` 元信息、时间戳、被折叠的次要内容
- `[bold]…[/]` 强调（数字、当前焦点行）
- `[bg=cyan]…[/]` 反白徽章 / 高亮当前批次
- 所有色彩在 `NO_COLOR=1` 时降级为纯 ASCII + 前缀符号（`!`、`?`、`✓`、`x`）。

## 设计哲学

- **屏即仪表盘**：即使是一次性命令，也用 header / body / footer 三段结构，让眼睛可以直接跳到需要
  的区域，而不是从上到下顺序阅读。
- **框线只承载分组**：`─ ═ ┌ ┐ ┏ ┓ ├ ┤ ╞ ╡` 只出现在真正需要"切一刀"的地方——分组、状态切换、活跃
  批次的强调。**不为装饰画外框**；如果去掉一根线不损失信息，就删掉。
- **状态优先于顺序**：用状态列 + glyph（`● ◐ ○ ✓ ⋯`）代替 `1..N` 序号；用户眼睛先扫状态列，再决定
  是否读标题。
- **密度优先于留白**：`tasks list` 一屏塞下 28 个任务的分组结构 + 活动直方图；`run live view` 同时
  展示进度条、批次栈、事件流、快捷键——但每个区块都用横线明确切分。
- **代价我们认**：这不是 pipe-friendly 输出，也不是低对比度终端友好的输出。它是给"人坐在真实终端
  前主动看"的输出，`--json` / `--plain` 是 opt-in 兜底。

---

## 屏 1 · archloop tasks list

### Before

```
bai@LUOBO-56FI1MA:~/code$ archloop tasks list
│
│  Hub task board
│  Total tasks: 21
│  done (21)
│    1. AutoTuneAgent-0b7: Slice 2: Expand Report Fragment columns …
│    2. AutoTuneAgent-0g4: Slice 1 · Divergence fail path — Runaway detection tracer bullet
│    …
```

### After · 默认视图（隐藏 done）

```
[cyan]┌─[/] [bold]archLoop tasks[/] [dim]·[/] [cyan]autotuneagent[/] [dim]───────────── branch main · 2026-07-20 14:32 ─[/][cyan]┐[/]
[cyan]│[/]  [cyan]READY[/] [bold]4[/]   [yellow]IN-PROG[/] [bold]2[/]   [red]BLOCKED[/] [bold]1[/]   [green]DONE[/] [bold]21[/]   [dim]Σ 28[/]   [dim]activity 7d[/] [green]▁▂▄▂▇█▄[/]        [cyan]│[/]
[cyan]└────────────────────────────────────────────────────────────────────────────────────────────────┘[/]

[yellow]active[/] [dim]────────────────────────────────────────────────────────────────────────────────────────[/]
 [yellow]●[/] [yellow]IN-PROG [/]  [cyan]AutoTuneAgent-2mr[/]  Slice 2 · Remove TaskOrchestrator + legacy model  [dim]12m ago[/]
 [yellow]●[/] [yellow]IN-PROG [/]  [cyan]AutoTuneAgent-4k1[/]  Slice 1 · Divergence fail path                    [dim]41m ago[/]
 [red]◐[/] [red]BLOCKED [/]   [cyan]AutoTuneAgent-9zx[/]  Awaiting merger review                            [dim] 3h ago[/]

[cyan]ready[/] [dim]─────────────────────────────────────────────────────────────────────────────────────────[/]
 [cyan]○[/] [cyan]READY   [/]  [cyan]AutoTuneAgent-0b7[/]  Slice 2 · Expand Report Fragment columns          [dim]2d ago[/]
 [cyan]○[/] [cyan]READY   [/]  [cyan]AutoTuneAgent-0g4[/]  Slice 1 · Runaway detection tracer bullet         [dim]2d ago[/]
 [cyan]○[/] [cyan]READY   [/]  [cyan]AutoTuneAgent-0h2[/]  Slice 3 · Wire new reporter into digest           [dim]3d ago[/]
 [cyan]○[/] [cyan]READY   [/]  [cyan]AutoTuneAgent-0m9[/]  Slice 4 · Sandbox teardown retry logic            [dim]3d ago[/]

[dim]done ─── 21 items collapsed ─── expand: `archloop tasks list --status done` ────────────────────────[/]

[dim]tip:[/] `archloop tasks show <id>`   [dim]sort:[/] `--sort -updated`   [dim]filter:[/] `--label slice-2`
```

### After · Mixed-status 视图（`--status all`）

```
[cyan]┌─[/] [bold]archLoop tasks[/] [dim]·[/] [cyan]autotuneagent[/] [dim]· --status all ────────── branch main · 2026-07-20 14:32 ─[/][cyan]┐[/]
[cyan]│[/]  [cyan]READY[/] [bold]4[/]   [yellow]IN-PROG[/] [bold]2[/]   [red]BLOCKED[/] [bold]1[/]   [green]DONE[/] [bold]21[/]   [dim]Σ 28[/]   [dim]burn 7d[/] [green]▁▂▄▂▇█▄[/] [dim]≈ 3.0/d[/]  [cyan]│[/]
[cyan]└────────────────────────────────────────────────────────────────────────────────────────────────┘[/]

[yellow]active · 3[/] [dim]────────────────────────────────────────────────────────────────────────────────────[/]
 [yellow]●[/] [yellow]IN-PROG [/]  [cyan]AutoTuneAgent-2mr[/]  Slice 2 · Remove TaskOrchestrator + legacy model  [dim]12m ago[/]
 [yellow]●[/] [yellow]IN-PROG [/]  [cyan]AutoTuneAgent-4k1[/]  Slice 1 · Divergence fail path                    [dim]41m ago[/]
 [red]◐[/] [red]BLOCKED [/]   [cyan]AutoTuneAgent-9zx[/]  Awaiting merger review                            [dim] 3h ago[/]

[cyan]ready · 4[/] [dim]──────────────────────────────────────────────────────────────────────────────────────[/]
 [cyan]○[/] [cyan]READY   [/]  [cyan]AutoTuneAgent-0b7[/]  Slice 2 · Expand Report Fragment columns          [dim]2d ago[/]
 [cyan]○[/] [cyan]READY   [/]  [cyan]AutoTuneAgent-0g4[/]  Slice 1 · Runaway detection tracer bullet         [dim]2d ago[/]
 [cyan]○[/] [cyan]READY   [/]  [cyan]AutoTuneAgent-0h2[/]  Slice 3 · Wire new reporter into digest           [dim]3d ago[/]
 [cyan]○[/] [cyan]READY   [/]  [cyan]AutoTuneAgent-0m9[/]  Slice 4 · Sandbox teardown retry logic            [dim]3d ago[/]

[green]done · 21[/] [dim]───────── merged since 2026-07-13 · newest first ──────────────────────────────────────[/]
 [green]✓[/] [dim]DONE    [/]  [cyan]AutoTuneAgent-5xy[/]  Slice 1 · Introduce new pipeline scheduler        [dim]1h ago[/]
 [green]✓[/] [dim]DONE    [/]  [cyan]AutoTuneAgent-5rt[/]  Slice 1 · Wire Hub to sandbox provider factory    [dim]4h ago[/]
 [green]✓[/] [dim]DONE    [/]  [cyan]AutoTuneAgent-4vv[/]  Slice 0 · Bootstrap AutoTune project profile      [dim]1d ago[/]
 [dim]· 18 more, oldest 2026-07-13 — press[/] `?` [dim]to page[/]

[dim]tip:[/] `archloop tasks show <id>`   [dim]narrow:[/] `--label slice-2 --assignee me`
```

### 设计要点

- **头部面板承担 KPI**：一屏一眼看到 `READY / IN-PROG / BLOCKED / DONE / Σ`，配 7-day 活动 sparkline
  (`▁▂▄▂▇█▄`)——把"总量 21"这种孤立数字变成"最近趋势"。
- **status 用词而非序号**：删掉 `1..N`，改成三列 `glyph · STATUS-CAP · task-id`；扫视时先看颜色列。
- **默认折叠 done**：底部一条 dim 提示线明确交互路径 `--status done`；避免 21 条 done 淹没 3 条 active。
- **分组标题内联总数**：`active · 3`、`ready · 4`、`done · 21` 直接写在分区分隔线上，省一行 header。
- **横线是"分组"而非"外框"**：只有顶部 KPI panel 用了 `┌ ┐ └ ┘`，因为它跨列聚合真正的多值 KPI；下方
  分组只用一根细横线切分，不画外框。

---

## 屏 2 · archloop tasks pull

### Before

```
bai@LUOBO-56FI1MA:~/code$ archloop tasks pull
│  Synced Hub tasks with GitHub Issues
│  Pulled: 4 created, 0 updated, 0 conflicts, 0 duplicate candidates
│  Pushed: 0 synced, 0 closed, 0 push pending
```

### After

```
[cyan]┌─[/] [bold]archLoop tasks pull[/] [dim]·[/] [cyan]autotuneagent[/] [dim]· remote[/] [cyan]Yibeibankaishui/AutoTuneAgent[/] [dim]───────[/][cyan]┐[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]│[/]   [green]↓ PULL[/]  [dim]from GitHub Issues[/]              [yellow]↑ PUSH[/]  [dim]to GitHub Issues[/]                    [cyan]│[/]
[cyan]│[/]   [dim]────────────────────────────────[/]      [dim]────────────────────────────────[/]              [cyan]│[/]
[cyan]│[/]    [bold]4[/]  created         [green]████[/]                 [bold]0[/]  synced                                  [cyan]│[/]
[cyan]│[/]    [bold]0[/]  updated         [dim]·[/]                    [bold]0[/]  closed                                  [cyan]│[/]
[cyan]│[/]    [bold]0[/]  conflicts       [dim]·[/]                    [bold]0[/]  push pending                            [cyan]│[/]
[cyan]│[/]    [bold]0[/]  dup candidates  [dim]·[/]                                                                [cyan]│[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]│[/]   [dim]new task ids[/]  [cyan]AutoTuneAgent-3ab[/] [dim],[/] [cyan]-3ac[/] [dim],[/] [cyan]-3ad[/] [dim],[/] [cyan]-3ae[/]                                    [cyan]│[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]└────────────────────────────────────────────────────────────────────────────────────────────────┘[/]
[green]✓ sync clean[/] [dim]· 1.4s ·[/] `archloop tasks list`  [dim]to browse pulled tasks[/]
```

### 冲突场景（说明性变体）

```
[cyan]┌─[/] [bold]archLoop tasks pull[/] [dim]·[/] [cyan]autotuneagent[/] [dim]· remote[/] [cyan]Yibeibankaishui/AutoTuneAgent[/] [dim]───────[/][cyan]┐[/]
[cyan]│[/]   [green]↓ PULL[/]                              [yellow]↑ PUSH[/]                                            [cyan]│[/]
[cyan]│[/]    [bold]2[/]  created         [green]██[/]                    [bold]0[/]  synced                                  [cyan]│[/]
[cyan]│[/]    [bold]1[/]  updated         [green]█[/]                     [bold]0[/]  closed                                  [cyan]│[/]
[cyan]│[/]    [red][bold]2[/]  conflicts       ██[/]                    [bold]0[/]  push pending                            [cyan]│[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]│[/]   [red]conflicts require review:[/]                                                                  [cyan]│[/]
[cyan]│[/]     [red]![/] [cyan]AutoTuneAgent-1kk[/]  title diverged   [dim]local[/] "Introduce X"  [dim]remote[/] "Add X"       [cyan]│[/]
[cyan]│[/]     [red]![/] [cyan]AutoTuneAgent-1mv[/]  status diverged  [dim]local[/] blocked         [dim]remote[/] open          [cyan]│[/]
[cyan]└────────────────────────────────────────────────────────────────────────────────────────────────┘[/]
[yellow]! 2 conflicts pending[/] [dim]· resolve:[/] `archloop tasks resolve <id>`
```

### 设计要点

- **双列反向表**：`↓ PULL` 与 `↑ PUSH` 并置，颜色配对（下入用 green，上推用 yellow），让"这次同步谁
  动得多"一眼可见。
- **迷你数据条**：数字后接 `████` block bar，把"4 created / 0 conflicts"变成条形对比；`0` 用 `·`
  折叠掉，减少视觉噪声。
- **new ids 内联**：把创建的 Task ID 直接列在面板底部，避免用户再敲一次 `tasks list` 才看到。
- **冲突场景另起 red section**：panel 内嵌一个 `red` 子块，直接列出冲突任务、diff-summary 和解决
  命令——把"你还有事没做"从退出码提升到显眼的红色徽章。

---

## 屏 3 · archloop run 交互流程

### Before

```
bai@LUOBO-56FI1MA:~/code$ archloop run
◇  Select a Hub flow:  with-review
◇  Hub run plan
│  Repository root: /home/bai/code/AutoTuneAgent
│  Hub flow: with-review
│  Hub project: autotuneagent
◇  Run this Hub flow now?  Yes
```

### After

```
[cyan]?[/] [bold]Hub flow[/]         [cyan]›[/] [bold]with-review[/]     [dim](default · Enter to accept, ↑↓ to switch)[/]
[cyan]?[/] [bold]Task pick[/]        [cyan]›[/] [bold]auto (1 ready)[/]  [dim](or a,b,c to pick multiple)[/]

[cyan]┌─[/] [bold]Hub run plan[/] [dim]·[/] [cyan]autotuneagent[/] [dim]─────────────────────────── pre-flight ✓ 4 / 4 ─[/][cyan]┐[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]│[/]   [dim]flow      [/]  [bold]with-review[/]                [dim]reviewers[/]   agent-a [cyan]→[/] agent-b                     [cyan]│[/]
[cyan]│[/]   [dim]project   [/]  [cyan]autotuneagent[/]              [dim]sandbox  [/]   dev-container                        [cyan]│[/]
[cyan]│[/]   [dim]repo root [/]  ~/code/AutoTuneAgent           [dim]branch   [/]   [cyan]archloop/run-a41c[/]                    [cyan]│[/]
[cyan]│[/]   [dim]tasks     [/]  [cyan]AutoTuneAgent-2mr[/]          [dim]provider [/]   claude-code [dim]·[/] sonnet-4.5           [cyan]│[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]├─[/] [dim]pre-flight[/] [cyan]───────────────────────────────────────────────────────────────────────────────[/][cyan]┤[/]
[cyan]│[/]   [green]✓[/] credentials       [green]✓[/] git clean       [green]✓[/] sandbox image       [green]✓[/] .archloop/config      [cyan]│[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]└────────────────────────────────────────────────────────────────────────────────────────────────┘[/]

[cyan]?[/] [bold]Start run now?[/]   [green][Y]es[/]   [yellow][e]dit plan[/]   [dim][n]o[/]     [dim](Enter = Y)[/]
```

如果某项 pre-flight 失败：

```
[cyan]├─[/] [dim]pre-flight[/] [cyan]───────────────────────────────────────────────────────────────────────────────[/][cyan]┤[/]
[cyan]│[/]   [green]✓[/] credentials       [red]x[/] git dirty       [green]✓[/] sandbox image       [green]✓[/] .archloop/config      [cyan]│[/]
[cyan]│[/]   [red]![/] [red]git dirty:[/] 3 modified files in packages/hub — commit / stash before run                [cyan]│[/]
```

### 设计要点

- **只保留必要 prompt**：把原本 3 段 clack 步骤压缩为两个 `?` prompt（flow / task），其余全部预填并
  在面板中呈现，让用户"看着确认"而不是"被逐条问"。
- **plan panel = 单一视觉锚点**：所有关键决策（flow / project / repo / branch / provider / reviewers /
  sandbox）用两列 key-value 铺开；一屏就是一份可核对的 dispatch 表。
- **pre-flight 内嵌**：4 项检查横向排列在 panel 下段，失败时红叉 + 一行解释；避免"先跑一半再报错"。
- **最终确认三选一**：`Y / e / n` 显式表达"编辑计划"这条路径——用户不必取消再重来。

---

## 屏 4 · run live view

这是本方案的 showcase 屏。目标是让终端里的 `archloop run` 感觉像在看 `k9s` 或 `htop`：一屏之内，
状态、批次、事件、快捷键各就各位。

### Before

```
✓ Batch batch-daca6200-3d0a-4e48-86b4-4253a24b4056 completed | 1 task
archLoop run | Project autotuneagent
Flow with-review | Run run-74cc88e3-6757-4472-b152-f5cf151be9d3
Batch batch-fd3cdf79-1786-4647-8899-d5f80fd8255b | Planning | 1 task
  ● Implementing
    AutoTuneAgent-2mr - Slice 2: Remove TaskOrchestrator and legacy Test Task model fro...
Elapsed 29:30
Logs /home/bai/.local/share/archloop/hub/projects/8b382f29c45d/runs/run-74cc88e3-6...
```

### After

```
[cyan]╔═[/] [bold]archLoop run[/] [dim]·[/] [cyan]autotuneagent[/] [dim]═══════════════════════════════════════ elapsed[/] [bold]29:30[/] [cyan]═╗[/]
[cyan]║[/]  [dim]flow[/]  [bold]with-review[/]     [dim]run[/]  [cyan]74cc88e3[/]     [dim]branch[/]  [cyan]archloop/run-a41c[/]     [dim]parallel[/] [bold]3/5[/]  [cyan]║[/]
[cyan]║[/]  [dim]provider[/]  claude-code [dim]·[/] sonnet-4.5      [dim]sandbox[/]  dev-container [dim]·[/] 2 warm             [cyan]║[/]
[cyan]╠═[/] [dim]progress[/] [cyan]════════════════════════════════════════════════════════════════════════════════[/][cyan]╣[/]
[cyan]║[/]  [green]████████████[/][dim]░░░░░░░░░░░░░░░░░░[/]  [bold]planning[/]  40%    [green]1[/] done [dim]·[/] [yellow]1[/] running [dim]·[/] [dim]1 queued[/]         [cyan]║[/]
[cyan]║[/]  [dim]eta[/] ≈ [bold]12m[/]  [dim]burn[/] ≈ 2.3 tok/s  [green]▂▃▅▇▆▄▃[/]                                                [cyan]║[/]
[cyan]╠═[/] [dim]batch stack[/] [cyan]═════════════════════════════════════════════════════════════════════════════[/][cyan]╣[/]
[cyan]║[/]                                                                                                [cyan]║[/]
[cyan]║[/]  [yellow]┏━━[/] [bg=yellow][bold]batch fd3cdf79[/][/] [dim]·[/] [yellow]planning[/] [yellow]━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 12m[/] [yellow]┓[/]         [cyan]║[/]
[cyan]║[/]  [yellow]┃[/]  [yellow]●[/] [yellow]implementing[/]  [cyan]AutoTuneAgent-2mr[/]  Slice 2 · Remove TaskOrchestrator   [bold]00:12:04[/]  [cyan]║[/]
[cyan]║[/]  [yellow]┃[/]    [dim]└─ agent[/] claude-code [dim]·[/] [dim]sandbox[/] archloop-2mr-4f [dim]·[/] +214 files touched          [cyan]║[/]
[cyan]║[/]  [yellow]┃[/]    [dim]patch[/] [green]███████████[/][dim]░░░░░░░[/] 62%   [dim]typecheck[/] [green]✓[/]  [dim]test[/] [yellow]▶ streaming[/]              [cyan]║[/]
[cyan]║[/]  [yellow]┃[/]    [dim]log[/]   [cyan]…/runs/run-74cc88e3/tasks/2mr.log[/]                                       [cyan]║[/]
[cyan]║[/]  [yellow]┃[/]                                                                                       [cyan]║[/]
[cyan]║[/]  [yellow]┃[/]  [dim]⋯[/] [dim]queued      [/]  [cyan]AutoTuneAgent-3nk[/]  Slice 3 · Wire new reporter into digest        [cyan]║[/]
[cyan]║[/]  [yellow]┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛[/]  [cyan]║[/]
[cyan]║[/]                                                                                                [cyan]║[/]
[cyan]║[/]  [dim]┌── batch daca6200 · completed ──────────────────────────────────────────── ✓ 17m 26s ─┐[/] [cyan]║[/]
[cyan]║[/]  [dim]│[/]  [green]✓[/] [dim]merged      [/]  [cyan]AutoTuneAgent-5xy[/]  Slice 1 · Introduce new pipeline scheduler     [cyan]║[/]
[cyan]║[/]  [dim]└──────────────────────────────────────────────────────────────────────────────────────┘[/] [cyan]║[/]
[cyan]║[/]                                                                                                [cyan]║[/]
[cyan]╠═[/] [dim]event stream · last 6[/] [cyan]══════════════════════════════════════════════════════════════════════[/][cyan]╣[/]
[cyan]║[/]  [dim]14:32:07[/]  [cyan]batch [/]  batch-fd3cdf79  [cyan]→[/] planning                                          [cyan]║[/]
[cyan]║[/]  [dim]14:32:11[/]  [cyan]task  [/]  AutoTuneAgent-2mr  [cyan]→[/] implementing                                    [cyan]║[/]
[cyan]║[/]  [dim]14:33:44[/]  [cyan]tool  [/]  run_terminal_cmd  `npm run typecheck`  [green]✓ 4.1s[/]                       [cyan]║[/]
[cyan]║[/]  [dim]14:35:02[/]  [cyan]tool  [/]  apply_patch  packages/hub/src/tasks/…  [green]+186[/] [red]-102[/]                [cyan]║[/]
[cyan]║[/]  [dim]14:39:14[/]  [cyan]agent [/]  claude-code  token budget 68%  [yellow]▓▓▓▓▓▓▓░░░[/]                          [cyan]║[/]
[cyan]║[/]  [dim]14:41:20[/]  [cyan]tool  [/]  run_terminal_cmd  `npm test hub/tasks`  [yellow]▶ streaming[/]                 [cyan]║[/]
[cyan]╠═[/] [dim]hotkeys[/] [cyan]═════════════════════════════════════════════════════════════════════════════════[/][cyan]╣[/]
[cyan]║[/]  [bold]q[/] quit   [bold]l[/] logs   [bold]t[/] tasks   [bold]b[/] batches   [bold]c[/] cancel task   [bold]p[/] pause   [bold]?[/] more    [cyan]║[/]
[cyan]╚════════════════════════════════════════════════════════════════════════════════════════════════╝[/]
```

### 完成态（run 结束时同一 layout 收敛）

```
[cyan]╔═[/] [bold]archLoop run[/] [dim]·[/] [cyan]autotuneagent[/] [dim]═══════════════════════════════════════[/] [green]✓ completed 34:12[/] [cyan]═╗[/]
[cyan]║[/]  [green]████████████████████████████████[/] [green]done[/] 100%   [green]3[/] merged [dim]·[/] [dim]0 failed[/] [dim]·[/] [dim]0 skipped[/]      [cyan]║[/]
[cyan]║[/]  [dim]typecheck[/] [green]✓[/]   [dim]tests[/] [green]✓ 148/148[/]   [dim]review[/] [green]✓ 1 approved[/]   [dim]merge[/] [green]✓ archloop/run-a41c[/]  [cyan]║[/]
[cyan]║[/]  [dim]log bundle[/] [cyan]~/.local/share/archloop/hub/projects/8b382f29/runs/run-74cc88e3/[/]                    [cyan]║[/]
[cyan]╚════════════════════════════════════════════════════════════════════════════════════════════════╝[/]
[green]✓[/] `archloop tasks list` [dim]shows 3 newly-done tasks · press[/] `l` [dim]to open logs[/]
```

### 设计要点

- **主外框用 `═ ║ ╔ ╗ ╚ ╝`**：整个 live view 是"一个持续刷新的应用"，用双线外框强调它是一整块屏幕
  的持有者，与前后普通命令输出区分。
- **五段横向切割**：`header → progress → batch stack → event stream → hotkeys`，每一段用 `╠═ ═╣` 切
  分并携带段名，用户可以直接跳到关心的区域。
- **活跃批次高亮**：当前 batch 用 `┏ ┓ ┗ ┛` 粗边框 + yellow，历史完成 batch 用 `┌ ┐ └ ┘` 细边框 + dim。
  没有装饰，只表达"哪个 batch 正在动"。
- **任务级 sub-progress**：每个 running task 单独有 `patch ███░░░ 62%`、`typecheck ✓`、`test ▶ streaming`
  三格微状态，把"正在做什么"从日志抽出来。
- **短 ID 全线使用**：所有 UUID 显示为前 8 字符（`fd3cdf79`、`74cc88e3`）；full UUID 只出现在日志 URL
  的路径末尾，且用 `…` 折叠。
- **event stream 是"降级日志"**：不是完整 stdout，是结构化事件——`batch / task / tool / agent`——每条
  一行，眼睛跳过速度快。
- **hotkey 条永远在底**：即便非交互模式（一次性运行），也保留该栏作为"这个屏幕能做什么"的自解释。
- **sparkline 表达时间**：`activity ▁▂▄▂▇█▄` 表 7 日节奏，`burn ▂▃▅▇▆▄▃` 表最近 7 段窗口的 token 速率
  ——都是 1 行 7 字符成本极低但语义丰富。
- **完成态复用同一 layout**：run 结束时把 5 段收敛成 3 行 header + summary，不切换到"新的一段输出"
  ——保留视觉锚点。

---

## 屏 5 · archloop tasks show

### Before

```
$ archloop tasks show AutoTuneAgent-2mr
│  AutoTuneAgent-2mr
│  Title: Slice 2: Remove TaskOrchestrator and legacy Test Task model from Hub
│  Status: in_progress
│  Priority: 2
│  Assignee: -
│  Created: 2026-07-15T09:12:03Z
│  Updated: 2026-07-20T14:32:11Z
│  Labels: hub, slice-2, refactor
│  Description: We need to remove …
│  Dependencies: AutoTuneAgent-1kk, AutoTuneAgent-1mv
```

### After

```
[cyan]┌─[/] [cyan][bold]AutoTuneAgent-2mr[/][/] [dim]·[/] Slice 2 [dim]·[/] Remove TaskOrchestrator + legacy Test Task model [dim]────[/][cyan]┐[/]
[cyan]│[/]  [yellow]●[/] [yellow][bold]IN-PROG[/][/]  [dim]p2[/]  [cyan]hub[/] [dim]·[/] [cyan]slice-2[/] [dim]·[/] [cyan]refactor[/]       [dim]created[/] 5d ago  [dim]updated[/] 12m ago    [cyan]│[/]
[cyan]├─[/] [dim]description[/] [cyan]───────────────────────────────────────────────────────────────────────────────[/][cyan]┤[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]│[/]  We need to remove `TaskOrchestrator` and the legacy `TestTask` Zod model from Hub. All        [cyan]│[/]
[cyan]│[/]  consumers migrated to the flow-based scheduler in slice 1. This slice deletes the shim,       [cyan]│[/]
[cyan]│[/]  simplifies [cyan]hub/src/tasks/index.ts[/], and updates `docs/roadmap.md`.                          [cyan]│[/]
[cyan]│[/]                                                                                                [cyan]│[/]
[cyan]├─[/] [dim]deps[/] [cyan]────────────────────────────────┬─[/] [dim]blocks[/] [cyan]────────────────────────────────────────[/][cyan]┤[/]
[cyan]│[/]  [green]✓[/] [cyan]AutoTuneAgent-1kk[/]  merged 4d ago    [cyan]│[/]  [cyan]○[/] [cyan]AutoTuneAgent-3nk[/]  ready              [cyan]│[/]
[cyan]│[/]  [green]✓[/] [cyan]AutoTuneAgent-1mv[/]  merged 4d ago    [cyan]│[/]  [cyan]○[/] [cyan]AutoTuneAgent-4jp[/]  ready              [cyan]│[/]
[cyan]├─[/] [dim]activity[/] [cyan]──────────────────────────────────────────────────────────────────────────────────[/][cyan]┤[/]
[cyan]│[/]  [dim]2026-07-15  09:12[/]  filed         by yucheng.bai                                              [cyan]│[/]
[cyan]│[/]  [dim]2026-07-20  14:20[/]  claimed       by run-74cc88e3                                              [cyan]│[/]
[cyan]│[/]  [dim]2026-07-20  14:32[/]  implementing  branch [cyan]archloop/run-a41c-2mr[/]                              [cyan]│[/]
[cyan]├─[/] [dim]artifacts[/] [cyan]─────────────────────────────────────────────────────────────────────────────────[/][cyan]┤[/]
[cyan]│[/]  [dim]log   [/]  [cyan]~/.local/share/archloop/hub/projects/8b382f29/runs/run-74cc88e3/tasks/2mr.log[/]     [cyan]│[/]
[cyan]│[/]  [dim]branch[/]  [cyan]archloop/run-a41c-2mr[/]                                                              [cyan]│[/]
[cyan]│[/]  [dim]PR    [/]  [dim](none — will open on review handoff)[/]                                                [cyan]│[/]
[cyan]└────────────────────────────────────────────────────────────────────────────────────────────────┘[/]

[dim]next:[/] `archloop tasks show AutoTuneAgent-3nk`   [dim]close:[/] `bd close AutoTuneAgent-2mr`
```

### 设计要点

- **卡片式详情**：description / deps / activity / artifacts 用同一张卡内的 `├─ title ─┤` 分区，让眼睛
  沿垂直方向扫描 4 个明确的区块。
- **deps 与 blocks 并排**：任务的"上下游"用 `┬` 一根中缝拆成左右两列，直接呈现"我在等谁 · 谁在等我"
  的图结构，而不是两段独立列表。
- **activity = 时间轴**：把 `filed / claimed / implementing` 排成时间序，附带 branch / actor，让
  `tasks show` 变成"这个任务的迷你历史"。
- **artifacts 收纳外部资源**：log 路径、branch、PR 三个"任务的外部指针"集中在最下端，方便复制。
- **badge 三件套**：`● IN-PROG` glyph + `p2` 优先级 + label 三种彩色徽章挂在标题下面，同屏内与
  `tasks list` 保持一致视觉语言。

---

## 取舍与代价

- **窄终端会碎**：≤ 80 列时右侧框线会被截断；本方案会在 `stdout.columns < 100` 时降级为"面板不画外
  框、只保留分组横线"，但视觉冲击会明显减弱。这是刻意取舍——我们不为了 80 列牺牲 120 列体验。
- **对 pipe / grep 不友好**：框线字符、颜色转义、多列对齐在 `| grep` / `| less -R` 场景下都可能碎。
  必须把 `--json` / `--plain` 作为一等 opt-in（不是残次品的兜底）；文档中每一条 `tasks list` /
  `tasks pull` 示例都要给出对应的 `--json` snippet。
- **实现成本高**：需要引入一个轻量 layout 引擎（宽度测量、面板对齐、颜色转义），或选择 `ink` /
  `blessed` 类库。`@clack/prompts` 提供的原语显然不够。
- **可访问性负担**：色盲不可靠（yellow / red 差异），需要 `NO_COLOR` 全兜底 + 前缀符号；屏幕阅读器
  对 Unicode 框线不友好，需要提供 `--reader-friendly` 变体。
- **live view 复杂度**：屏 4 的多面板刷新意味着我们必须持有整块屏幕（alt screen buffer），不能只是
  追加输出——对现有基于 append-only 的 `run` 是重写而非改造。这是一次架构级投资。
- **一致性维护成本**：五个屏共用同一套配色与 glyph 表；任何一次改动都必须同步到 `skills/archloop-usage/
SKILL.md`、`README.md` 与 `user_guide.md`，否则用户会看到与文档不一致的截图。
- **对老用户的迁移**：习惯 clack 单栏输出的用户会觉得"信息太挤"；建议以 `--layout=dashboard` /
  `--layout=lite` 两档做 3 – 4 个版本的过渡，让 dashboard 默认开启但可回退。

本方案的核心赌注是：**用户在真实终端里用 `archloop` 的时间足够长，值得一次真正的 TUI 投资**。
如果 archLoop 是"跑一下就关掉"的 batch 工具，Variant C 的克制方案更合适；如果 archLoop 是"边跑边
盯"的运行时，那 Variant B 的仪表盘才是它应有的形态。
