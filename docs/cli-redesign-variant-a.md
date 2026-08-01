# Variant A · Minimal Unix / Plumbing Style

> archLoop CLI 视觉重构方案 · A 案。
> 目标：让 `archloop` 用起来像 `git`、`gh`、`docker`、`kubectl` —— 纯文本、列对齐、可管道、可 `grep`，
> 没有装饰性边框或多字符符号；`--json` 与人读输出是同一份数据的两种呈现。

---

## 设计哲学

- **Plumbing 优先，porcelain 次之**。所有列表、状态、事件流默认可 `grep / awk / wc -l / cut`；人读输出等价于 `--json` 的一次美化投影。
- **不画框、不画竖线、不使用装饰性 Unicode**。行首没有 `│` gutter，没有 `● ◐ ✓ ↳` 等状态符号；对齐依赖空格与固定列宽。
- **单色为主，颜色只用于严重程度**。green = 成功/done，yellow = 进行中/pending，red = 错误/blocked；`NO_COLOR=1` 下必须信息完整。
- **状态用单字母标志位**。仿 `git status -s`：`T` todo、`R` running、`D` done、`B` blocked、`X` failed。列头带 `S` 一个字符宽即可。
- **稳定列 > 花哨排版**。ID 8 字符、状态 1 字符、标题剩余宽度并 tail-truncate；相同命令多次调用列宽结构不变，方便 diff。
- **每条命令都能塞进 shell 脚本**。`archloop tasks list --status=running --json | jq ...` 是一等公民，人类视图是 pretty-print 版。

放弃的东西：不再有明显的"品牌感"边框、不再有卡片化 hero 区、单个屏幕承载的信息密度上限比 Variant C 更高，视觉呼吸感更少。

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

### After · 默认视图（隐藏 done，只显示未完成 + 汇总行）

```
$ archloop tasks list
[dim]ID        S  TITLE                                                            UPDATED[/]
[dim]# no active tasks · 21 done · run `archloop tasks list --all` to show all[/]
[dim]# machine output: `archloop tasks list --json` · filter: `--status=todo,in_progress`[/]
```

当有活跃任务时的样子（同一份布局，只是行不为空）：

```
$ archloop tasks list
[dim]ID        S  TITLE                                                            UPDATED[/]
0g4       [yellow]T[/]  Slice 3 · Add retry backoff to Hub scheduler                     12m ago
2mr       [yellow]R[/]  Slice 2: Remove TaskOrchestrator and legacy Test Task model…    2m ago
[dim]# 1 todo · 1 running · 21 done (hidden) · --all to include done[/]
```

### After · 混合状态视图 `archloop tasks list --all`

```
$ archloop tasks list --all
[dim]ID        S  TITLE                                                            UPDATED[/]
0g4       [yellow]T[/]  Slice 3 · Add retry backoff to Hub scheduler                     12m ago
2mr       [yellow]R[/]  Slice 2: Remove TaskOrchestrator and legacy Test Task model…    2m ago
0b7       [green]D[/]  Slice 2: Expand Report Fragment columns to include token cost   2h ago
0g4prev   [green]D[/]  Slice 1 · Divergence fail path — Runaway detection tracer bul…  3h ago
1a2       [green]D[/]  Slice 3 · Wire batch cancellation through Hub scheduler         4h ago
1a3       [green]D[/]  Slice 4 · Persist run-level cost aggregates                     5h ago
1a4       [red]B[/]  Slice 5 · Migrate legacy report writer to new schema             6h ago
…
[dim]# 1 todo · 1 running · 20 done · 1 blocked · showing 25/23 · pipe to `less` for full[/]
[dim]# tip: `archloop tasks list --status=running --json | jq '.[].id'`[/]
```

### 设计说明

- **状态列 `S`**：单字符标志位，`T` todo / `R` running / `D` done / `B` blocked / `X` failed。列宽 1 字符，扫读时视线只需扫一列。
- **ID 列固定 8 字符左对齐**。这里直接采用 Beads 短 id（去掉 `AutoTuneAgent-` 前缀），保留全 id 只在 `--json` 与 `tasks show` 中呈现。删除了原来的 `1. 2. 3.` 序号——它对脚本无意义，且与 Beads id 重复。
- **默认隐藏 done**。当前 21 done 淹没活跃条目的问题从根源解决；末行 comment 显式提示 `--all`，且始终打印列头，保证 `archloop tasks list | head -1` 拿到的是可预测的表头字符串。
- **末尾 `#` 开头的汇总/提示行**。仿 shell 注释语法，`grep -v '^#'` 一步剥离，脚本消费时永远拿到干净数据。
- **标题 tail-truncate 以 `…` 结尾**，剩余列宽自适应但表头永远居左；宽终端下多列不加宽 title 后面的空白（避免"看似漂亮实则难 diff"）。
- **`UPDATED` 用相对时间**，与 `gh pr list` 一致；`--json` 输出改为 ISO-8601。
- **颜色**：`T` yellow、`R` yellow（可加粗）、`D` green、`B/X` red；`NO_COLOR=1` 时全部退化为纯字符，语义仍在。

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
$ archloop tasks pull
[dim]remote: Yibeibankaishui/archLoop · direction=both · ref=refs/heads/main[/]
pull  created=[green]4[/]  updated=0  conflicts=0  duplicates=0
push  synced=0            closed=0    pending=0
[dim]# 4 tasks created locally · run `archloop tasks list --all` to inspect[/]
```

冲突时的样子（把 severity 用 red 抬出来即可）：

```
$ archloop tasks pull
[dim]remote: Yibeibankaishui/archLoop · direction=both · ref=refs/heads/main[/]
pull  created=1  updated=2  conflicts=[red]3[/]  duplicates=[yellow]1[/]
push  synced=0   closed=0   pending=[yellow]2[/]
[dim]# 3 conflicts pending review:[/]
2mr   remote.title differs from local (bd resolve 2mr --keep=local|remote)
2mp   remote closed but local in_progress
2mq   remote.labels differs; local labels: [tracer-bullet backend]
[dim]# run `archloop tasks pull --json` for structured output[/]
```

### 设计说明

- **`key=value` 分列结构**。`awk` / `cut` / `grep 'conflicts=[^0]'` 都能直接用。总量指标全在一行，无需读多行才能拿到 conflicts 数字。
- **`remote: …` 头信息前缀 `#` 或 `[dim]`**，与真正数据行区分开；仿 `git fetch` 的 `remote: Counting objects …`。
- **冲突详情走 `id  reason(machine-friendly)  suggestion` 三列**，一行一条，便于人 + 机同时消费。
- **数字染色规则**：>0 的 warning/error 计数才上色；0 全部保持默认，避免视野被 0 拉走。
- **等号列**用固定 4 个空格分隔，不做花式对齐；这样 CI 里两次运行的 diff 就是纯数字差异。

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

### After · 首选：非交互（脚本首选路径）

```
$ archloop run with-review
[dim]resolve: project=autotuneagent  root=/home/bai/code/AutoTuneAgent  flow=with-review[/]
[dim]# use `--yes` to skip confirmation; `--json` to stream events as JSON[/]
Run flow 'with-review' on project 'autotuneagent'? [Y/n] _
```

`archloop run <flow> --yes` 完全跳过确认，直接进入 live view；这就是脚本要用的入口。

### After · 无参数时：单屏 `select` 菜单

```
$ archloop run
[dim]# select flow (enter number, or type name; ^C to abort)[/]
  1  with-review     planning + review + implementation                (default)
  2  no-review       planning + implementation
  3  bug-fix         single-task issue-driven fix
  4  spike           throwaway experiment; no auto-merge
Flow [1]: _
```

选完后与非交互路径合流，只保留**一次**确认：

```
Flow [1]: 1
[dim]resolve: project=autotuneagent  root=/home/bai/code/AutoTuneAgent  flow=with-review[/]
Run? [Y/n] _
```

或者用户想跳过：`archloop run --yes` / `Flow [1]: 1<enter>` + 已配置 `run.autoConfirm=true` 直接进入 live view。

### 设计说明

- **删除中间那个 clack "Hub run plan" 卡片**。它只是把三个 key=value 装进一个框，plumbing 视角下直接 dim 显示 `resolve: …` 一行即可，信息密度反而更高。
- **合并两次确认为一次**。原流程是"选 flow → 展示计划 → 再确认"三步；新流程是"选 flow → 一句 `resolve:` + 一个 `[Y/n]`"两步。`resolve:` 行本身就是那个"plan"。
- **`select` 菜单形如 `git rebase -i` 的 pick 列表**：编号 + 名字 + 一行注释；宽度控制在 100 列内，超长注释 tail-truncate。
- **首选路径是非交互**。文档与 `--help` 优先示范 `archloop run <flow>`，交互只是 fallback，这与 `gh pr create --title … --body …` 的取向一致。
- **`[Y/n]` 首字母大写表示默认 Yes**，仿 `apt` / `dpkg`；用户按 Enter 即确认。
- **`--json`（在文档 hint 中显式提示）**：进入 live view 后逐行输出 NDJSON 事件，人读版本是它的美化投影（见屏 4）。

---

## 屏 4 · run live view

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

### After · 非 TTY / 管道：纯事件流（默认）

```
$ archloop run with-review --yes
[dim]run  74cc88e3  project=autotuneagent  flow=with-review  logs=~/.local/share/archloop/…/run-74cc88e3/[/]
14:02:11  run    74cc88e3  start
14:02:11  batch  daca6200  start    stage=discovery      tasks=1
14:02:44  batch  daca6200  [green]done[/]     stage=discovery      tasks=1/1  elapsed=00:33
14:02:45  batch  fd3cdf79  start    stage=planning       tasks=1
14:02:46  task   2mr       start    agent=planner
14:03:12  task   2mr       [yellow]impl[/]     agent=implementer
14:31:41  task   2mr       [green]done[/]     duration=28:29
14:31:42  batch  fd3cdf79  [green]done[/]     stage=planning       tasks=1/1  elapsed=28:57
14:31:43  run    74cc88e3  [green]done[/]     elapsed=29:32        exit=0
```

出错时的样子：

```
14:31:41  task   2mr       [red]fail[/]     duration=28:29  exit=2
14:31:42  batch  fd3cdf79  [red]fail[/]     tasks=0/1
14:31:43  run    74cc88e3  [red]fail[/]     elapsed=29:32  exit=2
[dim]# see full log: less ~/.local/share/archloop/hub/projects/8b382f29c45d/runs/run-74cc88e3/run.log[/]
[dim]# rerun failed tasks only: archloop run --resume 74cc88e3 --only-failed[/]
```

### After · TTY 交互：事件流 + 底部单行状态

事件流照常滚动，终端最后一行钉一条**单行**、in-place 刷新（`\r` 覆写）的进度条，不画框：

```
14:03:12  task   2mr       [yellow]impl[/]     agent=implementer
14:07:55  task   2mr       [yellow]impl[/]     agent=implementer
[bold]run 74cc88e3 · planning · task 2mr impl · 05:44 · logs ~/.local/share/archloop/…/run-74cc88e3/[/]
```

`Ctrl-C` 优雅退出；`--json` 覆写这条底部行为空白，只留纯事件流。

### 设计说明

- **一行一事件**，`grep`、`awk`、`cut -d' '` 都可解析；同时是 `--json` 的等价投影（每行对应一个 JSON 对象）。
- **列顺序固定**：`time  kind  short-id  status  attrs=…`；kind ∈ `{run,batch,task}`，status ∈ `{start,impl,done,fail,skip}`。attrs 段是自由 `key=value`，工具兼容。
- **UUID 一律取前 8 字符**。全 id 走 `--json` / `archloop tasks show`。日志路径用 `~/.local/share/archloop/…/run-<id>/` 折叠中段，仅头 dim 打印一次完整前缀，且提供 `archloop run logs <id>` 别名。
- **不做卡片**、不做双层 `│`。TTY 下的底部状态是**一行**（1 line）in-place 更新，没有 ANSI 复杂控制块；`tput cols` 变化时截断即可。
- **颜色只在 status 字段**：`done` green，`impl` / `pending` yellow，`fail` red。其余全部保持默认前景色。
- **失败时不弹卡片**，跟一行 `# …` 提示如何看日志、如何重跑；仍然可 `grep '^#'` 或 `grep -v '^#'`。

---

## 屏 5 · archloop tasks show

### Before (推测当前实现)

```
│  Task: AutoTuneAgent-2mr
│  Slice 2: Remove TaskOrchestrator and legacy Test Task model from Hub
│  Status: in_progress
│  …
│  Description
│    Remove the deprecated TaskOrchestrator …
```

### After

```
$ archloop tasks show 2mr
id           AutoTuneAgent-2mr
title        Slice 2: Remove TaskOrchestrator and legacy Test Task model from Hub
status       [yellow]in_progress[/]
priority     p2
created      2026-07-18 14:02:11 +0800
updated      2026-07-20 11:45:03 +0800
epic         autotuneagent-cleanup
labels       backend, tracer-bullet, refactor
assignee     (unassigned)
blocks       2mp, 2mq
blocked_by   (none)
run          74cc88e3 (running)
logs         ~/.local/share/archloop/hub/projects/8b382f29c45d/runs/run-74cc88e3/

[dim]-- description --------------------------------------------------------------------[/]
Remove the deprecated TaskOrchestrator and legacy Test Task model from the Hub
scheduler. Consolidate into the new BatchOrchestrator with typed task envelopes.

Acceptance:
  - all callers migrated
  - no references to TaskOrchestrator in src/
  - existing report fragments still render

[dim]-- notes --------------------------------------------------------------------------[/]
2026-07-19  yucheng.bai   see ADR-014 for envelope schema
2026-07-20  yucheng.bai   blocked on 2mp landing first

[dim]# machine output: `archloop tasks show 2mr --json`[/]
[dim]# next: `archloop tasks edit 2mr` · `archloop run --task 2mr` · `bd show 2mr`[/]
```

### 设计说明

- **仿 `git show` / `gh pr view` 的 key–value block**。左列 12 字符固定，右列自由。没有装饰边框，`grep '^status'` 即可。
- **section 分隔用 dim `-- name --------------`**，纯 ASCII，管道消费时视为 comment 或 delimiter 都容易。
- **多值字段用逗号分隔**（`labels`、`blocks`），`--json` 里则是 array；`archloop tasks show 2mr --json | jq '.blocks[]'` 顺手。
- **`(unassigned)` / `(none)`**：明确用带括号的字面量表达"空"，避免"字段不存在"和"字段为空"混淆。
- **底部 hint 用 `#` 前缀**，与 tasks list、tasks pull 保持一致的 comment 语法。
- **不打印全长 UUID**，只打印短 id + `logs` 路径；需要全 UUID 时走 `--json`。
- **description / notes 使用等宽正文**，不裁不换行只做终端软换行；因为 `tasks show` 已经是"看单条详情"的重点场景，密度可以让位给可读性。

---

## 取舍与代价

Variant A 是一种明确的取舍。相比 Variant C（moderate/balanced）或更花哨的 TUI，它牺牲了以下东西：

- **视觉辨识度更弱**。截图放进博客/发布说明时不如带状态圆点、彩色卡片的方案"上镜"；上手 5 秒不容易被打动。
- **状态传达靠单字母 + 颜色**。`NO_COLOR=1` 下 `T` / `R` / `D` / `B` 需要用户记住图例，比 `todo` / `running` / `done` 直白版更陡；文档需要显式给一张对照表。
- **没有"批次卡片 / 任务卡片"**。原来 `│` 卡片虽然拥挤，但在扫读一个 run 的整体健康度时确实自带一种"块状分组"感；事件流是时间维度线性的，横向"这个 batch 内所有 task"需要 `grep batch.*fd3cdf79` 反查。
- **交互动画少**。没有 spinner、没有分节淡入、没有 hero title；`archloop run` 感觉更接近 `docker compose up`，而不是"引导式向导"。对完全首次使用的新用户，`archloop run` 的 select 菜单是唯一的"引导"，之后一切靠事件流。
- **信息密度高，容错窗口小**。列错位、attrs 拼写错、时间戳格式变化都会立刻被脚本消费者感知——好处是 API 稳定压力大，坏处是任何改列宽/加字段的动作都要走"输出契约"变更流程。
- **和 `@clack/prompts` 的现有基建有冲突**。落地时需要绕开 clack 的 note/log/intro，改为直接写 stdout；这是实际实现成本最大的一块。

回报：命令行像**工具**而不是**应用**。写 `for id in $(archloop tasks list --status=blocked --json | jq -r '.[].id'); do archloop tasks show "$id"; done` 是自然的，用户会自发把 archloop 拼进自己的脚本、alias、Makefile、pre-commit 钩子里。这是 `git` / `gh` / `kubectl` 长成"基础设施"而不是"产品"的路径。
