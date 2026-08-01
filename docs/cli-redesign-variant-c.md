# Variant C · Moderate / Balanced Style

> archLoop CLI 视觉重构方案 · C 案（对话中最初给出的方案，归档以便与 A / B 对照）。
> 目标：在 Variant A 的"plumbing 派"与 Variant B 的"dashboard 派"之间找一个中间点 ——
> 保留最小视觉层级（分隔线 + 状态符号 + 短 id + 颜色），但不画外框、不做多面板刷新。

配色标注约定（与 A / B 保持一致，便于对照）：

- `[cyan]…[/]` 主色 · 品牌 / 面板标题 / 短 id / 外部资源
- `[green]…[/]` 成功 / done
- `[yellow]…[/]` 进行中 / warning
- `[red]…[/]` 阻塞 / error
- `[dim]…[/]` 次要元信息、时间戳、tip
- `[bold]…[/]` 强调

---

## 设计哲学

- **去 `│` 竖轨，保留 `clack` 交互原语**。左侧 gutter 是当前 UI 感觉粗糙的头号原因，但 `clack.spinner` /
  `clack.select` / `clack.confirm` 的 tty 检测与动画值得保留 —— 只是不再包 `clack.note` 的框。
- **一屏 = header + 分隔线 + 段落 + 底部 tip**。四段结构照抄经典报告排版；每一屏都提供"下一步做什么"
  的引导（`tip` / `next`），因为 CLI 缺失感的大头就是这个。
- **符号 = 状态**，序号 = 无。`● ◐ ✓` 三个状态符 + 颜色即可表达 todo / in_progress / done；`1..N` 序
  号删除（Beads id 已经稳定）。
- **短 id 全线使用**。8 字符 UUID 短 id，语义等价于 git 短 hash；full id 只走 `--json` / `tasks show`。
- **截断规则匹配语义**：title 是"名字"用尾部省略 `xxx…`；path 是"目录指针"用头部省略 `…/xxx`。
- **NO_COLOR / 非 tty 全部退化为纯文本对齐版**，可 grep、可管道，但 pipe-friendliness 只是义务，不
  是首要目标 —— 这是 C 与 A 的分水岭。

放弃的东西：没有仪表盘感的 KPI panel（那是 B），也没有 `git status -s` 的极简字母列（那是 A）。

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

### After · 默认视图（全 done 的边界场景）

```
  [bold]archLoop[/] [dim]·[/] [cyan]autotuneagent[/]                                            [dim]21 tasks[/]
  [dim]──────────────────────────────────────────────────────────────────────────[/]
  [cyan]●[/] 0 todo       [yellow]◐[/] 0 in_progress       [green]✓[/] 21 done

  [green]✓[/]  [bold]done · 21[/]                                     [dim]showing 5 · archloop tasks list --all[/]
     [cyan]AutoTuneAgent-0b7[/]   Slice 2 · Expand Report Fragment columns (drift + latenc…
     [cyan]AutoTuneAgent-0g4[/]   Slice 1 · Divergence fail path — Runaway detection trace…
     [cyan]AutoTuneAgent-0ih[/]   Report Fragment view modules + per-case detail with over…
     [cyan]AutoTuneAgent-18x[/]   Slice 3 · Trajectory pose count derived from TUM, declar…
     [cyan]AutoTuneAgent-1tq[/]   Slice 4 · Dedupe failure_fingerprint.divergence to consu…
     [dim]… 16 more[/]

  [dim]tip[/]   archloop tasks show <id>   ·   archloop tasks pull
```

### After · 混合状态视图（更常见的形态）

```
  [bold]archLoop[/] [dim]·[/] [cyan]autotuneagent[/]                                             [dim]8 tasks[/]
  [dim]──────────────────────────────────────────────────────────────────────────[/]
  [cyan]●[/] 2 todo       [yellow]◐[/] 1 in_progress       [green]✓[/] 5 done

  [cyan]●[/]  [bold]todo · 2[/]
     [cyan]AutoTuneAgent-9k3[/]   Slice 5 · Wire config validator into apply pipeline
     [cyan]AutoTuneAgent-a12[/]   fix(run_task): stop double-registering error handlers   [yellow]⚠ prd-warn[/]

  [yellow]◐[/]  [bold]in_progress · 1[/]
     [cyan]AutoTuneAgent-2mr[/]   Slice 2 · Remove TaskOrchestrator and legacy Test Task…   [dim]yc.bai[/]

  [green]✓[/]  [bold]done · 5[/]                                     [dim]showing 3 · archloop tasks list --all[/]
     [cyan]AutoTuneAgent-fij[/]   feat(scenario_register): apply candidate writes board…
     [cyan]AutoTuneAgent-hwz[/]   Summary Digest composer + SUMMARY prompt shrinks to co…
     [cyan]AutoTuneAgent-z1e[/]   Slice 4 · Intake Parameter Space — int→float relaxation
     [dim]… 2 more[/]

  [dim]tip[/]   archloop tasks show <id>   ·   archloop tasks pull
```

### 设计说明

- **header 单行**：`archLoop · autotuneagent` 左对齐，`21 tasks` 右对齐；下方一条细分隔线。
- **三徽章一行**：`● 0 todo`、`◐ 0 in_progress`、`✓ 21 done` 三个符号 + 计数并排；眼睛一秒扫完状态
  轻重缓急，取代了原 `Total tasks: 21` 一行单点数字。
- **分组标题**：`[status-glyph] [status-name · count]` 单行，右侧灰字提示"只显示前 N 条，用 --all
  展开"。
- **id 列**：固定宽度 18 字符（`AutoTuneAgent-xxx` 的长度），两空格 gutter，title 尾部 `…` 截断。
- **顺序号 `1..N` 删除**（Beads id 已经稳定）；PRD 警告用尾部黄色 `⚠ prd-warn` 徽章取代 `[warning:…]`
  的长文本；有 claim 的任务尾部灰字显示 owner。
- **底部 tip**：一行"接下来可能想做什么"，与 A 案 `#` 注释、B 案 hotkey bar 在同一角色上。

---

## 屏 2 · archloop tasks pull

### Before

```
│
│  Synced Hub tasks with GitHub Issues
│
│  Pulled: 4 created, 0 updated, 0 conflicts, 0 duplicate candidates
│
│  Pushed: 0 synced, 0 closed, 0 push pending
```

### After

```
  [bold]archLoop[/] [dim]·[/] sync [dim]·[/] [cyan]autotuneagent[/]                        [dim]Yibeibankaishui/archLoop[/]

  [green]↓[/]  [bold]pulled[/]    [green]4 created[/]           [dim]0 updated · 0 conflicts · 0 dup-candidates[/]
  [dim]↑[/]  [bold]pushed[/]    [dim]nothing to push[/]     [dim]0 synced · 0 closed · 0 pending[/]

  [dim]done in 1.4s[/]

  [dim]next[/]   archloop tasks list
```

### 有真正推送时

```
  [green]↓[/]  [bold]pulled[/]    [dim]nothing new[/]         [dim]0 updated · 0 conflicts · 0 dup-candidates[/]
  [green]↑[/]  [bold]pushed[/]    [green]3 synced · 1 closed[/] [dim]0 pending[/]
```

### 有冲突时

```
  [green]↓[/]  [bold]pulled[/]    [green]1 created[/]           [dim]2 updated[/] · [red]3 conflicts[/] · [yellow]1 dup-candidate[/]
  [dim]↑[/]  [bold]pushed[/]    [dim]nothing to push[/]     [dim]0 synced · 0 closed · 0 pending[/]

  [red]![/]  [bold]3 conflicts pending review[/]
     [cyan]AutoTuneAgent-2mr[/]   remote.title differs           [dim]resolve: archloop tasks resolve 2mr[/]
     [cyan]AutoTuneAgent-2mp[/]   remote closed, local in_progress
     [cyan]AutoTuneAgent-2mq[/]   remote labels differ

  [dim]next[/]   archloop tasks resolve <id>   ·   archloop tasks pull --json
```

### 设计说明

- **箭头 + 主数值 + 灰色细节**：`↓ pulled 4 created` 用绿色高亮主要数值，零值细节走 dim；箭头一眼分辨
  方向，取代原来的两长句。
- **零 vs 非零区分**：零值全部灰、非零上语义色。视线只会被真正需要注意的东西吸引。
- **底部 tip 会依情况替换**：干净时是 `next   archloop tasks list`，有冲突时替换为
  `next   archloop tasks resolve <id>`。这是"引导下一步"精神的核心体现。
- **不画双面板**（B 版做的那个 `↓ PULL / ↑ PUSH` 两列面板）：pull 命令是一次性的，用两行 + 一句耗时
  就够了；把面板换成"两行、一致对齐、右侧灰色摘要"节省纵向空间。

---

## 屏 3 · archloop run 交互流程

### Before（3 步）

```
◇  Select a Hub flow:  with-review
◇  Hub run plan
│  Repository root: /home/bai/code/AutoTuneAgent
│  Hub flow: with-review
│  Hub project: autotuneagent
◇  Run this Hub flow now?  Yes
```

### After · 单屏摘要 + 一次确认

```
  [bold]archLoop[/] [dim]·[/] run

  [cyan]▸[/]  [bold]flow[/]       with-review                        [dim](last used · Enter to accept)[/]
  [cyan]▸[/]  [bold]project[/]    autotuneagent  [dim]←[/] /home/bai/code/AutoTuneAgent
  [cyan]▸[/]  [bold]ready[/]      1 task from inbox                  [dim]archloop run --dry to preview[/]

  [dim]press Enter to start   ·   e to edit   ·   q to cancel[/]
```

选完 flow 后 Enter 就跑；`e` 回到 `select` 改选，`q` 取消。`--yes` / `ARCHLOOP_RUN_YES=1` 保留 headless。

### After · 需要选 flow 时先弹 select（仅当无默认/首次运行）

```
  [bold]archLoop[/] [dim]·[/] run [dim]· select flow[/]

  [cyan]›[/] with-review     [dim]planning + review + implementation[/]
    no-review       [dim]planning + implementation[/]
    bug-fix         [dim]single-task issue-driven fix[/]
    spike           [dim]throwaway experiment; no auto-merge[/]

  [dim]↑↓ to navigate · Enter to select · q to cancel[/]
```

选完之后进入前一屏的"摘要 + 一次确认"。

### 设计说明

- **合并两次确认为一次**。原流程"选 flow → 展示 plan card → 再确认"三步；新流程是"（可选）select →
  摘要 + Enter 起跑"两步。摘要面板本身即"plan"，取消掉"Run this Hub flow now?"这个近乎无价值的
  yes-only 二次确认。
- **`▸` 键值前缀**：三个 `▸` 让摘要区看起来是"三条陈述"而不是"一堆键值对"，视觉更平静。
- **`←` 指向自动推断**：`autotuneagent ← /home/bai/code/AutoTuneAgent` 告诉用户"这是从 cwd 推出来
  的"，可以覆写。
- **底部快捷键**：`Enter / e / q` 三键覆盖所有分支，无需在提示间跳跃。
- **和 B 案 pre-flight panel 的差异**：C 案不预留一个 pre-flight 分区，出错时直接把 flow / project /
  ready 中的对应行变红，最下面加一行 `[red]! reason[/]` 提示；不为"没错"的情况占位。

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

### After · 运行中

```
  [bold]archLoop[/] [dim]·[/] [cyan]autotuneagent[/] [dim]·[/] with-review           [dim]run[/] [cyan]74cc88e3[/] [dim]·[/] [bold]29m30s[/]

  [green]✓[/]  batch [cyan]daca6200[/]   1 task                                                     [dim]done[/]
  [yellow]◐[/]  batch [cyan]fd3cdf79[/]   1 task                                            [dim]planning · impl[/]

     [cyan]↳[/]  [cyan]AutoTuneAgent-2mr[/]   Slice 2 · Remove TaskOrchestrator and legacy Test Task
                            model from the run pipeline
                            [dim]implementing · 3m12s in this step[/]

  [dim]logs[/]   [dim]…/runs/run-74cc88e3/[/]                                    [dim]press[/] [bold]o[/] [dim]to open ·[/] [bold]l[/] [dim]to tail[/]
```

### After · 完成时（一屏收束）

```
  [bold]archLoop[/] [dim]·[/] [cyan]autotuneagent[/] [dim]·[/] with-review           [dim]run[/] [cyan]74cc88e3[/] [dim]·[/] [green]✓ 34:12[/]

  [green]✓[/]  batch [cyan]daca6200[/]   1 task                                                     [dim]done[/]
  [green]✓[/]  batch [cyan]fd3cdf79[/]   1 task                                                     [dim]done[/]

     [green]✓[/]  [cyan]AutoTuneAgent-2mr[/]   Slice 2 · Remove TaskOrchestrator and legacy Test Task
                            model from the run pipeline

  [dim]logs[/]   [dim]…/runs/run-74cc88e3/[/]                       [dim]summary[/]   [green]3 merged · 0 failed[/]
  [dim]next[/]   archloop tasks list
```

### After · 出错时

```
  [bold]archLoop[/] [dim]·[/] [cyan]autotuneagent[/] [dim]·[/] with-review           [dim]run[/] [cyan]74cc88e3[/] [dim]·[/] [red]✗ 29m30s[/]

  [green]✓[/]  batch [cyan]daca6200[/]   1 task                                                     [dim]done[/]
  [red]✗[/]  batch [cyan]fd3cdf79[/]   1 task                                          [red]failed at impl[/]

     [red]✗[/]  [cyan]AutoTuneAgent-2mr[/]   Slice 2 · Remove TaskOrchestrator and legacy Test Task
                            model from the run pipeline
                            [red]! typecheck failed after 3 retries · exit=2[/]

  [dim]logs[/]   [dim]…/runs/run-74cc88e3/[/]                       [dim]retry[/]   archloop run --resume 74cc88e3 --only-failed
```

### 设计说明

- **header 一行三事**：`身份 · run 短id · elapsed`，右侧 elapsed 是**固定视觉锚点**（用户扫这个屏幕最
  想知道的就是"跑了多久了 / 结束了没"）。
- **batch 一行一条**：状态符号 + 短 id + 任务数 + 右侧一览态；多个 batch 时纵向堆叠，肉眼一次扫完。
- **当前任务 `↳` 缩进**：唯一"活跃"的任务给两行文字（title 允许两行 wrap 不截断），下方 dim 一行说
  "当前阶段 · 已花时间"。
- **路径头部省略**：`…/runs/run-74cc88e3/` —— 尾部保留才是有信息量的部分（run id + 是"日志目录"）。
- **状态转换用色不用换 layout**：running / done / failed 只变颜色和符号，行数与列位都不变；不像 B 案
  运行完切换到 3 行 header 版本，C 案更"低动效"，屏幕不会突然重排。
- **和 B 案 dashboard 的差异**：不使用 alt-screen buffer、不做多面板刷新、不画 `═ ║` 双线外框；本质
  仍然是**追加式输出**（append-only），断连或滚屏都不会碎。这换取了实现成本的显著下降。

---

## 屏 5 · archloop tasks show

### Before

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
  [bold]archLoop[/] [dim]·[/] task [dim]·[/] [cyan]AutoTuneAgent-2mr[/]                     [yellow]in_progress[/] [dim]·[/] [dim]yc.bai[/]

  [bold]title[/]       Slice 2 · Remove TaskOrchestrator and legacy Test Task model from
              the run pipeline
  [bold]status[/]      [yellow]in_progress[/]   [dim](beads: in_progress)[/]
  [bold]labels[/]      slice-2, refactor, hub
  [bold]origin[/]      inbox         [bold]kind[/] slice
  [bold]remote[/]      [cyan]github#182[/]    [dim]Yibeibankaishui/archLoop[/]

  [bold]description[/]
    We still keep a shadow TaskOrchestrator alongside the new HubRunner. Slice 2
    deletes it and rewires the two remaining call sites in the CLI.

  [bold]comments · 3[/]
    [dim]yc.bai · 2026-07-19[/]  green on typecheck, waiting for pull request review
    [dim]codex  · 2026-07-19[/]  applied fix for missing null guard in batch dispatch
    [dim]yc.bai · 2026-07-18[/]  spun this off from the parent PRD, see #181

  [dim]tip[/]    archloop tasks comment 2mr   ·   archloop tasks recover 2mr   ·   gh issue view 182
```

### 设计说明

- **key-value block** 用固定 12 字符左对齐 gutter，加粗 key + 默认前景 value；比 `clack.note` 的
  `key: value` 视觉更稳。
- **header 一次交代身份 · 状态 · owner**，正文里不再重复。
- **description / comments 各成一段**，comments 时间线格式与 tasks show 现有实现兼容（`author · date`
  前缀）。
- **和 B 案卡片式 `┌─ deps ─┬─ blocks ─┐` 双列拆分的差异**：C 案不做 deps / blocks 的横向双列 —— 它对
  Beads 任务的常见形态（0-2 个依赖）用左对齐 key-value 更省纵向空间，代价是"上游 / 下游"没有 B 案那
  么强的图结构表达。

---

## 取舍与代价

- **不如 A 案纯粹**。仍然依赖颜色和 Unicode 状态符（`● ◐ ✓ ↳`）；`--json` 不是一等公民，只是 opt-in
  兜底。管道消费者会觉得"要 grep 的时候还是要 `--plain`"。
- **不如 B 案上镜**。截图丢到发布说明或博客里，B 案的 `╔═ ═╗` dashboard + sparkline + progress bar 显
  然更"新品发布会"；C 案更像是"日常工具的一次美化"，不足以形成品牌记忆点。
- **仍需绕开 `clack.note`**。要真正去掉 `│` gutter，必须在 Display 层新增一个不走 `clack.note` 的
  `board()` / `runCard()` 高层原语 —— 这一步实现成本已经落在必须支付的清单里，选 A 或 B 也同样绕不
  开。
- **对旧测试有兼容成本**。`taskBoard.test.ts` / `cli.test.ts` 里有大量
  `expect(stdout).toContain("Hub task board")` / `"Total tasks: 21"` 断言；C 案标题变成
  `archLoop · autotuneagent`，副标题变成 `21 tasks`，需要把测试从"字符串包含"迁到"model 层结构断
  言"或者调整字面。这与 A / B 相同。
- **live view 演进天花板低**。C 案是 append-only 输出，未来若想加入 B 案那种任务级 sub-progress 条 /
  多面板刷新 / hotkey 拦截，会撞上"append-only 无法定点更新"的限制 —— 那时得走 alt-screen 重写。C 案
  是"当下能立刻上线且回报显著"的中间点，而不是"长期终局形态"。

回报：一次落地就能把当前粗糙的 clack 输出提升到"看着舒服 · 认知负担明显下降"的水平，实现成本远低于
B 案；同时保留了向 B 案演进的可能性（把 `board()` / `runCard()` 原语替换为 dashboard 实现即可）。
适合"先做 C，观察一到两个 release，再决定是否升级到 B"的路径。
