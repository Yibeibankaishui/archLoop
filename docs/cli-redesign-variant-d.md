# Variant D · Editorial / Brand-forward Style

一个把 CLI 输出当作**编辑作品**来对待的方案：像 Vercel、Bun、Astro、Deno、Railway、Fly、
Turborepo、Prisma、Wrangler 那样，用留白、字号（粗体/暗色）、一个品牌符号、和一句人话来
承担全部信息层级。目标不是把更多数据塞进屏幕，而是让每个 CLI 会话读起来像一个朋友告诉
你刚才发生了什么，并明确告诉你下一步该做什么。

---

## 设计哲学

- **只优化一件事：可读性 + 语气**。一屏一个 hero fact，其他细节要么被折叠、要么退到 dim
  灰色的从属层。用户扫视 3 秒就该抓住"发生了什么"和"我下一步做什么"。
- **留白是设计元素**。空行不是浪费，是段落划分。archLoop 的输出应当像文章的排版：段与段
  之间空一行，段内首行有一个"小标题 + 短描述"的对仗。
- **品牌符 ↻ 承担所有装饰工作**。没有任何 `│ ─ ═ ┌ ┐` 边框，没有 `● ◐ ✓ T R D B X` 状态
  列阵，没有 `1. 2. 3.` 序号（会与 Beads id 打架）。层级完全靠缩进、粗体、灰度、和一个
  精心挑选的品牌符完成。
- **写成句子，不写成 label:value**。`Total tasks: 21` 是数据库转储，`You have 21 tasks
tracked here.` 是编辑口吻。数字与 id 用 `[bold]` 强调，其余用叙述语气把它们串起来。
- **每屏都必须以 CTA 结束**。绝不留白结尾。给出 1–3 条建议命令，用 dim 灰色写成一句话。
  失败场景也一样：不是 error dump，而是"这里卡住了，你可以这样试一下"。
- **与 A / B / C 的对比**。A 追求 dense columnar plumbing，D 反其道走 prose；B 是多面板
  实时 dashboard，D 是低帧率叙述；C 是 balanced middle ground，仍用分割线与状态 glyph，
  D 抛弃所有分割线，把结构感全部交给空行和缩进。三者可以在 `--style=a|b|c|d` 下并存，D
  的定位是"默认/首次接触"，power user 依然可以退回 A。

---

## 品牌符提案

archLoop 需要一个**能出现在 Twitter 截图角落被认出**的符号。三个候选：

### 候选一 · `↻` (U+21BB · Clockwise Open Circle Arrow) ← 推荐

- **语义**：一次迭代，闭合的循环。与 archLoop 的产品名和"AI agent 反复自改进"的定位完全
  对齐。
- **字体覆盖**：macOS 与 Linux 主流 monospace（Menlo/Fira/JetBrains Mono/Iosevka）全部
  正常渲染。Windows Terminal 默认 Cascadia Code 也支持。
- **视觉性格**：轻、有方向感。放在句首像一枚小徽章。
- **和现有 glyph 冲突**：与已被 A/B/C 占用的 `▲◆●◐✓↳` 完全无冲突。
- **取舍**：在极少数远端 SSH + 老 xterm 场景可能渲染为方框；提供 `--ascii` fallback。

### 候选二 · `∞` (U+221E · Infinity)

- **语义**：连续循环、无止境的 self-improvement。抽象、诗意。
- **字体覆盖**：几乎 100%，是最保险的 Unicode 符号之一。
- **取舍**：语义上过于哲学，缺少"每次跑一圈"的动作感；且大量数学库/Prometheus 也用它做
  metric，容易撞脸。

### 候选三 · `~>` (2 ASCII chars)

- **语义**：像水流，也像一个 arch 的截面。纯 ASCII 保证在任何终端都渲染。
- **字体覆盖**：100%。也是 `--ascii` 模式的最终回退方案。
- **取舍**：占两列，不如单字符收敛；"loop" 语义弱，更像 "flow"。

**结论**：默认使用 `↻`，`--ascii` 模式退回 `~>`。下文所有 mockup 都以 `↻` 为准。

---

## 语气示例

| 现状措辞                                            | Editorial 措辞                                     |
| --------------------------------------------------- | -------------------------------------------------- |
| `Total tasks: 21`                                   | You have 21 tasks tracked here.                    |
| `pulled: 4 created, 0 updated, 0 conflicts`         | Pulled 4 new tasks from GitHub.                    |
| `Batch batch-fd3cdf79... \| Planning \| 1 task`     | Working on one task in this batch.                 |
| `Elapsed 29:30`                                     | 29 min in.                                         |
| `Select a Hub flow:`                                | Which flow are we running?                         |
| `Run this Hub flow now?  Yes / No`                  | Go ahead? yes / no                                 |
| `✓ Batch batch-daca6200... completed \| 1 task`     | Run finished — one task shipped.                   |
| `Logs /home/bai/.local/share/archloop/hub/…/runs/…` | Live logs stream to ~/.local/share/…/run-74cc88e3. |

关键手法：把"数据库字段"换成"主语 + 谓语 + 状语"；把 id 前缀 (`Batch`, `Flow`, `Run`)
省略成上下文默认；把 timestamp 换成人类会说的"29 min in"；把 file path 用 `~` 与省略号
折叠。

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

### After · 默认视图（prose-first）

```
$ archloop tasks list

[accent]↻[/]  [bold]autotuneagent[/]  [dim]21 tasks tracked here.[/]

You have [bold]2[/] tasks in progress and nothing is blocked right now.
[bold]21[/] tasks have shipped this week — nice pace.

[dim]In progress[/]
     AutoTuneAgent-2mr    Remove TaskOrchestrator and legacy Test Task model
     AutoTuneAgent-3aa    Wire archloop run into the new dispatcher

[dim]Next up[/]
     AutoTuneAgent-3ab    Backfill regression fixtures for the divergence path
     AutoTuneAgent-3ac    Draft ADR for run-plan versioning

[dim]Show everything with[/] [bold]archloop tasks list --all[/][dim], or open one with[/] [bold]archloop tasks show <id>[/][dim].[/]
```

### After · 混合状态（有 blocked / 有 planned）

```
$ archloop tasks list

[accent]↻[/]  [bold]autotuneagent[/]  [dim]21 tasks tracked here.[/]

[bold]2[/] in progress, [bold]1[/] waiting on review, [bold]4[/] planned. Since Monday, [bold]6[/] shipped.

[dim]In progress[/]
     AutoTuneAgent-2mr    Remove TaskOrchestrator and legacy Test Task model
     AutoTuneAgent-3aa    Wire archloop run into the new dispatcher

[yellow]Waiting on review[/]
     AutoTuneAgent-1z9    Divergence fail-path tracer bullet     [dim]needs @yucheng.bai[/]

[dim]Planned[/]
     AutoTuneAgent-3ab    Backfill regression fixtures for the divergence path
     AutoTuneAgent-3ac    Draft ADR for run-plan versioning
     AutoTuneAgent-3ad    Retire legacy namespace references
     AutoTuneAgent-3ae    Introduce colored --plain output flag

[green]Shipped this week[/]  [dim]6 tasks — run[/] [bold]archloop tasks list --shipped[/] [dim]to see them[/]

[dim]Try[/] [bold]archloop tasks show AutoTuneAgent-1z9[/] [dim]to unblock the review.[/]
```

### 设计决定

- **不再是 "Hub task board / Total tasks: 21"**。开头一句 prose 已经把总量与状态压成一
  行："You have 2 tasks in progress and nothing is blocked right now."
- **状态用 dim/yellow/green 灰阶做小标题**，而不是 A 的字母列、B 的 emoji glyph、C 的
  `●◐✓`。字号（粗细）与颜色本身就是语义。
- **不做全量默认打印**。默认视图只显示 in progress + next 2 条 planned，剩下折叠到
  `--all`。这是编辑取舍：全量属于 power user 的显式意图，而不是新手接触点。
- **id 与标题左对齐两列**，缩进 5 空格建立"页边距"。所有行 ≤ 100 列。
- **结尾单句 CTA**，永远告诉用户下一步命令。
- **与 A/B/C 的对比**：A 会输出 `T=2 R=1 P=4 D=21` 一行；B 会画三个 panel + 侧边计数条；
  C 会加一条 `──` 分节线。D 只用空行和大小写。

---

## 屏 2 · archloop tasks pull

### Before

```
bai@LUOBO-56FI1MA:~/code$ archloop tasks pull
│  Synced Hub tasks with GitHub Issues
│  Pulled: 4 created, 0 updated, 0 conflicts, 0 duplicate candidates
│  Pushed: 0 synced, 0 closed, 0 push pending
```

### After · 一次成功的 pull

```
$ archloop tasks pull

[accent]↻[/]  [bold]Synced with Yibeibankaishui/archLoop.[/]

Pulled [bold]4 new[/] tasks from GitHub. Nothing needed updating locally, and no conflicts came up.
Nothing to push back — you're in sync.

[dim]New here[/]
     AutoTuneAgent-3ab    Backfill regression fixtures for the divergence path
     AutoTuneAgent-3ac    Draft ADR for run-plan versioning
     AutoTuneAgent-3ad    Retire legacy namespace references
     AutoTuneAgent-3ae    Introduce colored --plain output flag

[dim]Next time you pull, I'll show what changed since this run.[/]
```

### After · 有冲突的 pull

```
$ archloop tasks pull

[accent]↻[/]  [bold]Synced with Yibeibankaishui/archLoop.[/]

Pulled [bold]3 new[/] tasks and updated [bold]1[/]. Two look like duplicates of local tasks — I left
them for you to eyeball.

[yellow]Might be duplicates[/]
     AutoTuneAgent-3af    Draft ADR for run-plan versioning
                          [dim]looks a lot like your local AutoTuneAgent-3ac[/]
     AutoTuneAgent-3ag    Colored --plain output
                          [dim]looks a lot like your local AutoTuneAgent-3ae[/]

[dim]Resolve with[/] [bold]archloop tasks merge <local> <remote>[/] [dim]or[/] [bold]archloop tasks dismiss <id>[/][dim].[/]
```

### 设计决定

- **主标题一句话讲清"和谁同步了"**。remote name 直接写在句子里，不做 label。
- **数字加 bold**，其他叙述文字全部普通字重；这样眼睛在 3 秒扫过后自然抓到 4 / 3 / 1。
- **重复候选写成"looks a lot like ..."** 而不是 "duplicate_candidates: [id1, id2]"。这是
  D 与 A 最尖锐的分歧：A 的目标是让 `jq` 消费，D 的目标是让人类第一眼理解。
- **结尾 CTA 提供了下一步的两条命令**（merge / dismiss），用两个 bold 突出。
- **"Next time I'll show what changed"** 是一句典型的编辑话术：承诺未来行为，暗示 CLI
  是有状态、有记忆的伙伴，而不是无状态的转储器。

---

## 屏 3 · archloop run 交互流程

### Before

```
◇  Select a Hub flow:  with-review
◇  Hub run plan
│  Repository root: /home/bai/code/AutoTuneAgent
│  Hub flow: with-review
│  Hub project: autotuneagent
◇  Run this Hub flow now?  Yes
```

### After · 交互对话

```
$ archloop run

[accent]↻[/]  [bold]Let's start a run.[/]   [dim]repo AutoTuneAgent · project autotuneagent[/]

Which flow are we running?

     [bold]›[/] with-review     [dim]plan, implement, and pause for human review[/]
       fast-forward    [dim]plan and implement, no review gate[/]
       dry-run         [dim]plan only, do not touch the sandbox[/]

[dim]…you picked[/] [bold]with-review[/][dim].[/]

Here's the plan.

     one batch, one task
     starting from [bold]AutoTuneAgent-2mr[/]  — Remove TaskOrchestrator and legacy Test Task model
     logs will land in ~/.local/share/archloop/hub/projects/8b382f29c45d/runs

Go ahead?   [bold]›[/] yes    no
```

### After · 用户 override 了默认

```
Which flow are we running?
     [bold]›[/] fast-forward   [dim]plan and implement, no review gate[/]
       with-review    [dim]plan, implement, and pause for human review[/]
       dry-run        [dim]plan only, do not touch the sandbox[/]

[dim]…you picked[/] [bold]fast-forward[/][dim] — skipping the review gate. I'll ship it if it goes green.[/]
```

### 设计决定

- **每一步是一个问句**。`Which flow are we running?` 代替 `Select a Hub flow:`；`Go
ahead?` 代替 `Run this Hub flow now?`。CLI 用第一/第二人称讲话。
- **选项右侧一句 dim tagline**，帮用户在没读文档的情况下做选择。这是 D 与 clack 默认渲染
  最大的差别。
- **"…you picked X" 是叙述回合**，把 clack 的重复回显包装成一个自然的段落过渡，而不是
  `◇  Select a Hub flow:  with-review` 这样的机械回显。
- **"Here's the plan" 段落是缩进列表**，不是 label:value；每一项都是一个完整的短句。
- **默认动作用 bold `›` 提示当前光标**，视觉上把品牌符 `↻` 用于章节起点，`›` 用于选项当
  前项。两者形态互补。
- **override 场景中 CLI 会顺势加一句评价**（"skipping the review gate. I'll ship it if
  it goes green."）——这是编辑口吻的关键：CLI 有观点。

---

## 屏 4 · run live view

这是 D 的**showcase**：把 log stream 改造成三幕故事——**Dispatch → Focus → Summary**。
每一幕之间是数分钟到数十分钟的静默；CLI 不做每秒刷新，而是在"值得说一句"的时候升起一段
新文字，其他一切进 dim log。

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

### After · 第一幕 · Dispatch (t=0)

```
[accent]↻[/]  [bold]Run started.[/]   [dim]autotuneagent · flow with-review · run-74cc88e3[/]

Working on one task in this batch.

     [bold]AutoTuneAgent-2mr[/]   Remove TaskOrchestrator and legacy Test Task model

[dim]Live logs stream to ~/.local/share/archloop/hub/…/runs/run-74cc88e3.[/]
[dim]I'll narrate the important moments — press ? for the raw log.[/]
```

### After · 第二幕 · Focus (t = ~29 min in)

```
[accent]↻[/]  [bold]Implementing AutoTuneAgent-2mr[/]   [dim]29 min in[/]

     Now: writing tests for the legacy import cleanup.
     Next: retiring `orchestrator/` and rewiring the run dispatcher.

     [dim]Since we started, we've[/]
        edited 12 files, added 240 lines, deleted 118
        added 4 tests, 0 failing so far
        committed 3 checkpoints

[dim]Press[/] [bold]l[/] [dim]for the raw log, or[/] [bold]s[/] [dim]to send the agent a note.[/]
```

### After · 第三幕 · Summary (成功)

```
[green]↻[/]  [bold]Run finished.[/]   [dim]37 min total · one task shipped[/]

[bold]AutoTuneAgent-2mr[/] — Remove TaskOrchestrator and legacy Test Task model — [green]merged[/].

     A tidy diff: 14 files touched, 268 lines added, 141 removed.
     Test suite is green: 89 tests, 0 failing.
     Left a checkpoint at [bold]archloop/run-74cc88e3[/] on your working tree.

[dim]What's next?[/]
     [bold]archloop tasks show AutoTuneAgent-2mr[/]      read the full summary
     [bold]archloop run[/]                                kick off the next flow
     [bold]archloop tasks list[/]                         see what else is planned
```

### After · 第三幕 · Summary (失败)

```
[red]↻[/]  [bold]Run stopped.[/]   [dim]12 min in · one task attempted[/]

[bold]AutoTuneAgent-2mr[/] didn't land. The agent's sandbox exited with a merge conflict on
`packages/hub/src/orchestrator/index.ts` after 3 rebase attempts.

     Last thing the agent said:
       "I keep re-hitting the same conflict — I want a human to pick a side."

[dim]How to move forward[/]
     [bold]archloop tasks show AutoTuneAgent-2mr --diff[/]   review what the agent tried
     [bold]archloop run --resume run-74cc88e3[/]              take over from the sandbox
     [bold]archloop tasks pull[/]                             refresh from GitHub first
```

### 设计决定

- **三幕结构（Dispatch → Focus → Summary）是 D 的最强主张**。B 的 dashboard 会每秒重绘
  多面板；A 的 log tail 会每事件一行；D 只在"值得说"的时候升起一段文字，其他时间 CLI 静
  默，工具本身像在"打字给你看"，而不是"仪表盘转动给你看"。
- **Focus 幕的三行叙述（Now / Next / Since we started）**是核心。它用一句话讲当下、一句
  话讲下一步、一段小总结讲历史，把"实时性"用"最近半小时的三个句子"呈现出来。
- **品牌符 ↻ 在成功/失败时变色**（`[green]↻[/]` / `[red]↻[/]`），是唯一的状态编码通道。
  不需要 `✓` / `✗` / `!` 等额外 glyph。
- **失败页也是编辑口吻**："Last thing the agent said: ..." 把 agent 的最后一条状态包装成
  一段引言，而不是原始 stack trace（stack trace 折叠到 `--verbose` 或 log 文件里）。
- **CTA 三选一**：读、继续、刷新。永远比只留一句 `Logs /home/...` 有用。
- **与 B 的显著对比**：B 强调多面板并行状态；D 强调单一叙事线。B 是"NASA 控制室"，D 是
  "记者现场发稿"。用户在长跑（几十分钟）任务里更需要后者。

---

## 屏 5 · archloop tasks show

### Before

```
$ archloop tasks show AutoTuneAgent-2mr
│
│  Task AutoTuneAgent-2mr
│  Title: Slice 2: Remove TaskOrchestrator and legacy Test Task model from …
│  Status: in_progress
│  Owner: @yucheng.bai
│  Depends on: AutoTuneAgent-2mp
│  Blocks: AutoTuneAgent-3aa
```

### After · 任务作为一篇小型文档

```
$ archloop tasks show AutoTuneAgent-2mr

[accent]↻[/]  [bold]AutoTuneAgent-2mr[/]

     [bold]Remove TaskOrchestrator and legacy Test Task model[/]
     [dim]In progress · owned by @yucheng.bai · opened 3 days ago[/]

     Slice 2 of the orchestrator rewrite. We're pulling the old TaskOrchestrator scaffolding
     out of packages/hub and folding its remaining responsibilities into the new dispatcher.

     [dim]What good looks like[/]
        packages/hub/src/orchestrator/ is gone
        archloop run --flow with-review uses the new dispatcher end-to-end
        no reference to the Test Task model outside historical docs

     [dim]Depends on[/]      AutoTuneAgent-2mp    Dispatch API surface locked in
     [dim]Blocks[/]          AutoTuneAgent-3aa    Wire archloop run into the new dispatcher

     [dim]Recent activity[/]
        [dim]2h ago[/]       agent checkpoint at archloop/run-74cc88e3      [dim]+240 −118[/]
        [dim]yesterday[/]    @yucheng.bai left a note on the divergence path
        [dim]3d ago[/]       picked up by AFK agent

[dim]Continue with[/] [bold]archloop run --task AutoTuneAgent-2mr[/][dim], or comment with[/] [bold]archloop tasks note[/][dim].[/]
```

### 设计决定

- **任务是一份文档，不是一张表**。顶部 breadcrumb（品牌符 + id）→ 主标题（bold）→ 副标题
  （dim, 状态/owner/时间）→ 段落式描述 → 若干小节。
- **深缩进（5 空格）建立"页边距"**。所有内容整体缩进，让屏幕左侧留白像书页的天头。
- **"What good looks like" 代替 "Acceptance criteria"**。日常语言比术语更能被非工程 owner
  快速理解。
- **依赖关系不做树图**。两行 dim label（Depends on / Blocks）+ inline 的 `id  title` 双列
  排布，密度低但一眼可读。与 B 的关系图/A 的 `deps=[...]` 完全不同。
- **Recent activity 是时间线，不是 event log**。每行一个人类时刻描述，右侧才是可能的
  metadata（`+240 −118`）。
- **结尾 CTA 双动作**：继续跑 / 加评论。任务视图永远预设读者读完后要"做点什么"。

---

## 取舍与代价

选择 D 意味着接受下列成本，这些成本 A/B/C 都不同程度地回避了：

- **文案维护成本高**。每一条 code path 都要有一句人话措辞。新增一个错误分支不能靠
  `sprintf("%s failed: %s", name, err)` 打发，需要写 "X didn't land — Y kept hitting..."。
  这是永久性负担，需要一个 `messages.ts` 目录和 code review 时的语气把关。
- **i18n 负担 3-5 倍于键值风格**。中英文措辞不对等（"you have"、"here's the plan"、"nice
  pace" 这种口吻在中文里需要重写而非直译），本地化不再是字符串替换，而是"重写文案"。要么
  一开始就双语共维，要么承认某些语言只有 A 风格。
- **不 pipe 友好**。叙述性 stdout 很难被 `awk` / `grep` / `jq` 消费。必须提供 `--json`
  与 `--plain` 双通道；CI 环境应默认走 `--plain`（去掉品牌符、颜色、和"叙述过渡"）。这
  是 D 与 A 的最本质对立：A 天然是"结构化优先"，D 天然是"人类优先"，两者共存需要额外
  基础设施。
- **Power user 会抱怨"太慢"**。一屏 5 行叙述 vs. A 的一屏 20 行结构化数据，密度差 4 倍。
  给他们保底：`archloop tasks list --style=a` 一键切回 plumbing 风格。
- **强制 CTA 在 edge case 会尴尬**。当结局明确是 "run finished successfully, nothing to
  do" 时，仍要挤出一句 CTA，很容易变成 "You could... uh... run it again?"。需要一套"当没
  什么可建议时就说什么"的规则，例如引导到 `archloop tasks list` 或 docs。
- **品牌符渲染兜底**。`↻` 在极少数 Windows 终端里显示为方框；需要在启动时做一次终端能力
  探测（或提供 `--ascii`），fallback 到 `~>`。这是一次性工程成本，但必须做。
- **live view 静默期可能被误认为"卡了"**。当第一幕和第二幕之间有 15 分钟"什么都不说"，
  新用户会怀疑进程死了。缓解：在长静默期插入一句极简 heartbeat（"still thinking · 8 min
  in"），但需要克制，不能变回 B 的刷新流。
- **失败页写作难度最高**。成功页容易写得漂亮，失败页要在"表达同情"和"给出可行动线索"
  之间平衡，很容易变成客服式空话。需要一个失败措辞的规范库。

综上：D 不适合"我们只是想让输出别那么丑"这种诉求（那是 C 的领域）；它适合"我们希望
archLoop 有品牌记忆点，用户会截图分享"这种诉求。选 D 就要一直选下去——每一个新命令、
每一次错误、每一份 release note 都要在同一个语气里写完。
