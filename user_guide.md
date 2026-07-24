# archLoop Unified Interface 用户使用指南

## 1 功能概述

archLoop unified interface 是 archLoop 的新主入口。它把项目管理、共享凭据、agent role 配置、任务表、PRD 拆解、任务 triage 和 flow 执行集中到 `archloop` CLI 中。

首版主仓库为：

```text
https://github.com/Yibeibankaishui/archLoop.git
```

新的主要使用方式是先做 Hub onboarding: `archloop initialize` -> `archloop project add` / `select` / `list` -> `archloop check` -> selected-project `archloop run --flow ...`。`archloop init` 仍然保留，但只作为 legacy 的 repo-local scaffold 路径；已经使用 `.archloop/main.ts` 或 `.archloop/main.mts` 的项目可以继续按原流程运行。

## 2 使用边界

Unified interface 面向一个已有 Git 项目运行。目标项目需要满足：

| 条件             | 说明                                                         |
| ---------------- | ------------------------------------------------------------ |
| Git 仓库         | 仓库至少已有一个 commit                                      |
| archLoop CLI     | 示例统一使用 `archloop`，没有全局命令时可改用 `npx archloop` |
| Beads task store | Hub task board 使用 Beads 保存本地任务                       |
| Agent runtime    | 需要至少一个可用的 agent provider 和模型                     |
| Hub credentials  | 共享凭据保存在 archLoop user data directory 中               |

Hub flow 使用 archLoop 自带的 flow prompt，不读取目标项目里的 `.archloop/main.ts` 或 `.archloop` prompt。目标项目不需要先执行 `archloop init`。

如果你要先完成 Hub 级共享设置，再注册第一个项目，先运行 `archloop initialize`。它会配置共享 agent roles、env 和 auth 指引，默认再跑一次轻量 Hub check，并在成功后把 `archloop project add` 作为下一步。若要跳过 quick check，使用 `archloop initialize --skip-check`。

## 3 首次配置

### 3.1 检查项目状态

在任意目录运行；`archloop run` 默认针对已选中的 Hub project，TTY 中还会在需要时打开 Hub project / flow 选择器；选完 flow 后会渲染 run plan section，并在约 3 秒后自动开始（`Ctrl+C` 取消，`e` 重选 flow）。`--yes` 跳过倒计时，`--dry-run` 只打印计划不启动。如需覆盖项目，可以显式传入 `--project <name>`：

```bash
archloop project status
archloop check
```

`project status` 用于确认当前选中的或显式指定的 Hub project：

| 输出项                       | 用途                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Repo root                    | 当前 Hub project 对应的目标项目根目录                                            |
| archLoop user data directory | Hub 状态、共享凭据、运行记录所在位置                                             |
| Hub project directory        | 当前项目的 Hub 运行状态目录                                                      |
| Beads availability           | Beads 是否可用                                                                   |
| Task summary                 | 当前任务表、失败任务、运行批次、同步状态摘要                                     |
| Cleanup diagnostics          | safe managed candidates、blocked reasons 和 historical unowned preservation 规则 |

`check` 默认会同时验证 Hub 级 readiness 和当前 CLI selected 的 Hub project（如果存在）。你也可以显式使用 `archloop check --hub` 只跑 Hub 级检查，`archloop check --project <name>` 检查某个项目，或 `archloop check --all-projects` 检查全部项目。Hub 级检查会验证 agent role 是否完整、共享凭据和 auth 是否存在、provider 引用是否可用、provider CLI 是否能从 PATH 找到，以及是否可以通过真实 provider 路径完成最小 smoke check。项目级检查会验证 repo path、git repo、initial commit、development contract、local task store、ready/failed 任务摘要、active run 和 flow readiness signals。输出会显示进度、按 provider/model/options 去重，并列出每个 smoke check 覆盖的 role。

`project list` 则提供更轻量的多项目概览：它按 Hub registry 列出项目，标记 selected 项，显示 repo path、project profile、path validity、local task store readiness 标签、ready/failed/total 数量（可用时）以及 active run 概览，适合快速决定接下来切换到哪个项目。

如果只是需要改名或迁移仓库路径，可以用 `archloop project rename <project> <new-name>` 和 `archloop project relink <project> --path <repo-path>`。这两个命令都会保持 Hub project id 不变，因此任务、运行和历史记录仍然挂在同一个 Hub project 上。

### 3.2 配置 agent roles

Hub flow 使用统一的 role 配置，配置对所有项目生效。

```bash
archloop agent-config init
```

也可以单独设置某个 role：

```bash
archloop agent-config set-role planning --provider cursor --model gpt-5.4
archloop agent-config set-role triage --provider cursor --model gpt-5.4
archloop agent-config set-role implementation --provider cursor --model gpt-5.4
archloop agent-config set-role review --provider cursor --model gpt-5.4
archloop agent-config set-role merge --provider cursor --model gpt-5.4
archloop agent-config set-role recovery --provider cursor --model gpt-5.4
```

查看当前配置：

```bash
archloop agent-config show
archloop agent-config path
```

支持的 role：

| Role             | 用途                        |
| ---------------- | --------------------------- |
| `planning`       | PRD 拆解与任务规划          |
| `triage`         | inbox / needs_info 任务分析 |
| `implementation` | 实现 ready_for_agent 任务   |
| `review`         | 审核实现分支                |
| `merge`          | 合并任务分支并关闭本地任务  |
| `recovery`       | 修复失败或卡住的任务状态    |

### 3.3 配置共享凭据

Hub v1 使用 archLoop user data directory 下的本地明文 `.env` 文件保存共享凭据。它不是 secret vault；请按本地敏感文件管理。

```bash
archloop env init
```

Codex users can choose `archloop auth login codex` for a Codex/ChatGPT CLI login session instead of setting `OPENAI_KEY`, which uses OpenAI API billing. GitHub Issues task sync can use `archloop auth login github` instead of `GH_TOKEN`.

也可以单独设置：

```bash
archloop env set CURSOR_API_KEY
archloop env set ANTHROPIC_API_KEY
archloop env set OPENAI_KEY
archloop env set OPENCODE_API_KEY
archloop env set GH_TOKEN
```

查看配置：

```bash
archloop env show
archloop env path
archloop auth show
```

`process.env` 中的同名变量会覆盖 Hub `.env` 中的值。

## 4 任务表使用

### 4.1 初始化本地任务表

任务命令默认针对已选中的 Hub project；如需覆盖，可以显式传 `--project <name>`。
如果目标项目还没有本地任务表，先运行：

```bash
archloop tasks init
```

查看 archLoop 投影后的任务表：

```bash
archloop tasks list
archloop tasks list --json
```

示例输出（`--plain` / `NO_COLOR`）。行尾远端徽章：`github#N`（已同步）、`local-only`（待推送）、`sync-conflict`（冲突）；无远端链接则省略。被 interrupted-execution detector 判定为中断的任务（`implementing` / `reviewing` / `merging` 且无活跃 worktree lease）会额外显示 `⚠ interrupted` 徽章（`--json` 行对应新增 `interrupted: true`），无需运行 `tasks doctor` 即可一眼定位；当不存在 `.archloop/locks/` 目录时该检查整体跳过，健康看板无额外开销：

```text
  archLoop · demo                                                                   3 tasks
  ● 2 todo   ◐ 1 in_progress   ✓ 0 done
  ●  todo · 2
     todo-list-demo-mv2  Fix login redirect                                github#101
     todo-list-demo-nx1  Improve empty state copy                            local-only
  ◐  in_progress · 1
     todo-list-demo-ab3  Handle expired token                              ⚠ interrupted
  tip   archloop tasks show <id>   ·   archloop tasks pull
```

任务选择器支持两种写法（**不再接受** `tasks list` 的 1-based 序号；请用 Beads id）：

| 写法     | 示例                   |
| -------- | ---------------------- |
| Beads id | `todo-list-demo-mv2`   |
| 任务标题 | `"Fix login redirect"` |

查看任务详情：

```bash
archloop tasks show "Fix login redirect"
archloop tasks show todo-list-demo-mv2
```

示例详情：

```text
  archLoop · task · todo-list-demo-mv2                                               ready_for_agent
  title       Fix login redirect
  status      ready_for_agent  (beads: open)
  labels      ready_for_agent
  description
    User lands on blank page after login.
  next  archloop tasks update todo-list-demo-mv2 ...
```

### 4.2 创建任务

创建普通 inbox 任务：

```bash
archloop tasks create "Fix login redirect"
```

创建用户反馈任务：

```bash
archloop tasks create "Improve empty state copy" --origin user-feedback --kind ux
```

附带描述：

```bash
archloop tasks create "Handle expired token" --description "User is redirected to a blank page after token expiry."
```

### 4.3 追加评论

```bash
archloop tasks comment 1 --body "QA reproduced this on a fresh checkout."
```

不传 `--body` 时会进入交互输入。

### 4.4 删除本地任务

删除只影响本地 Beads task，不删除 GitHub Issue。

```bash
archloop tasks delete 1 --dry-run
archloop tasks delete 1 --yes
```

## 5 PRD 拆解与 Triage

### 5.1 从 PRD 生成本地任务

推荐入口：

```bash
archloop tasks from-prd docs/prd/example.md
```

这个命令会启动 agent-driven proposal session。你可以在会话里要求 agent 拆分、合并、重排、调整依赖、补充验收标准，确认后才会写入本地 Beads。

非交互一轮模式：

```bash
archloop tasks from-prd docs/prd/example.md --yes
```

`--yes` 仍会调用 agent 并校验结构化输出，默认创建 inbox 任务，不会静默创建 ready 状态任务。

等价 flow 入口：

```bash
archloop run --flow prd-decomposition --input docs/prd/example.md
```

### 5.2 Triage inbox / needs_info 任务

交互选择任务：

```bash
archloop tasks triage
```

指定单个任务：

```bash
archloop tasks triage todo-list-demo-mv2
```

按状态查询：

```bash
archloop tasks triage --query inbox,needs_info
```

非交互高置信自动应用：

```bash
archloop tasks triage --yes
```

`triage --yes` 只自动应用高置信、非关闭、非依赖变更的决策。需要人工确认的决策会被跳过并记录为未确认。

等价 flow 入口：

```bash
archloop run --flow triage --input inbox,needs_info
```

## 6 诊断和修复任务状态

```bash
archloop tasks doctor
```

`tasks doctor` 只读检查本地 Beads task board、Hub run events、git 分支和工作区状态，不会修改 Beads、git 或远端 GitHub Issues。它会报告多重 archLoop 状态标签、过期的 `metadata.hubStatus`、缺失的 execution claim、failed 任务上仍存在的分支工作、已 review 但无法被 merge 选择的任务、terminal 任务里残留的 execution metadata、dirty worktree gate、需要 `tasks push` 的同步状态，以及 managed branch cleanup diagnostics。

每条输出都会说明下一步：重新运行 flow、执行 `archloop tasks recover <selector>`、执行 `archloop tasks repair-state <selector>`、推送 task sync，或按需运行 `archloop tasks cleanup --yes` / `--include-unowned`。dirty source files 是 Git 安全提示，不是可修复的 Beads 状态污染。后续 `run --flow` 只有在待合并分支会改到同一路径时才会阻塞；按输出列出的 blocking files 先 commit、stash 或 discard，再重新运行同一个 flow，archLoop 会优先恢复 `waiting_for_merge` 批次。

```bash
archloop tasks repair-state <selector>
archloop tasks repair-state <selector> --yes
```

`repair-state` 会先预览本地 Beads mutation；TTY 中需要确认，非交互模式需要 `--yes`。它使用和正常 Hub lifecycle 相同的 canonical transition path，只重写 archLoop 管理的状态标签和 metadata，保留用户自定义标签，不会修改远端 GitHub Issues。典型用途是修复 Hub event 已记录 `task_review_succeeded`、分支仍有未合并工作，但 Beads labels/metadata/claim 过期导致无法 merge 的 QA incident。`commitCount=0` 且没有 branch work 的 agent failure 不会被提升到 `waiting_for_merge`，应通过 recovery policy 处理。

## 7 执行 Flow

### 7.1 无 reviewer flow

```bash
archloop run --flow no-review
```

适合先验证最短闭环：读取 `ready_for_agent` 队列，执行实现任务，成功后进入 `waiting_for_merge`，再按批次合并并关闭本地任务。实现成功以任务分支上的提交（或既有未合并工作）加上 `<promise>COMPLETE</promise>` 为准；provider CLI 尾随的非零退出不会把已完成的工作判成 `agent_failed`，失败事件也会带上真实的分支 `commitCount`。若完成信号伴随零新增提交、但该任务实现此前已合并进基线分支（存在过往 `merge_succeeded` / `task_closed` 运行事件），则视为已合并成功并直接关闭为 `done`，而非判成 `agent_failed`；完成信号本身不会被单独采信，因此真正的“零产出”失败仍会失败。运行中途的 provider 瞬态错误（`API Error: 400 Invalid request parameters`、Cursor `RetriableError: Connection stalled` / `PING timed out`）会按指数退避重试（默认 3 次、5s/20s/60s；`ARCHLOOP_PROVIDER_RETRY_ATTEMPTS` / `ARCHLOOP_PROVIDER_RETRY_BASE_MS` 可覆盖），并记录 `task_provider_retry` 事件；已有完成信号时走观察路径、不再重试。

### 7.2 带 reviewer flow

```bash
archloop run --flow with-review
```

适合需要实现后审核的流程：实现成功后进入 `reviewing`，review 完成后进入 `waiting_for_merge`，再进入 merge 阶段。

交互式 TTY 选完 flow 后会先打印 run plan `section`，再等待约 3 秒自动开始（`Ctrl+C` 取消，`e` 重选 flow）；`--yes` / 非 TTY / `--dry-run` 跳过倒计时，`--dry-run` 只打印计划：

```text
  archLoop · run
  flow      with-review
  project   demo  ← /path/to/repo
  ready     1 task
  tip   starting in 3s · Ctrl+C to cancel · e to edit flow
```

所有 Hub flow 默认使用 `--output auto`。交互式 TTY 在尺寸与 cursor control 可用时显示 append-only Hub run card（每次状态转换追加一个 `section`，底部单行 spinner 心跳）；任务看板显示 batch/task，PRD decomposition 与 triage 显示 proposal session phases。proposal live view 在 refinement、status、approval、apply prompt 前暂停并恢复，不暴露 agent prose。重定向、CI、dumb/unsupported/unsafe terminal 自动回退 plain，所有退出路径都会恢复 cursor。`NO_COLOR=1` 或全局 `--plain` 只去掉颜色/粗体/暗色，保留符号与缩进。

所有 flow 支持显式 `--output plain`。proposal records 为 append-only canonical phase/status，不包含原始 agent prose；最终 outcome 区分 applied、no-change、cancelled、validation failure、mutation failure 和其他 failure，并提供 applied/skipped/dependencies、logs、diagnostic 与 recovery。显式 plain/JSON 不发起交互 prompt，写入 proposal 必须传 `--yes`；未确认时不 apply。

脚本和 CI 可改用 `--output json`。proposal phases 使用 stdout-pure schema version 1 `proposal_phase` JSONL，最终使用 `run_completed`；应用/无变化退出 `0`，Ctrl+C 取消退出 `130`，SIGTERM 保留退出码 `143`，validation/mutation/general failure 非零。version 1 消费者应忽略未知字段。

失败或阻塞任务会保留 failed stage、简短 diagnostic、相关 log path 和下一步命令。agent、sandbox、implementation 与 review 失败使用 `archloop tasks recover <selector>`；claim 或 task projection 不一致使用 `archloop tasks repair-state <selector>`；dirty-worktree overlap 会列出准确 blocking paths，并说明先 commit、stash 或 discard。仍在 `waiting_for_merge` 的工作应重新运行同一个 `archloop run --flow <id>`，由既有自动恢复逻辑继续批次。失败的 run 会在结尾给出 `fix` footer 指向真实下一步：有任务真正 failed 时提示 `archloop tasks recover --stale`，run 被中断（任务停留在 in-flight 状态且无 `failed` 任务）时提示 `archloop run`（重跑会恢复中断的工作，包括未完成的 `waiting_for_merge` 批次）；`tasks list` 也会用 `⚠ interrupted` 徽章一眼标出被中断的任务。不存在 `archloop run --resume` / `--only-failed` 这样的 flag。

Merge 阶段会在真正合并前输出 selected / skipped / blocked 诊断。若 Hub 事件显示任务已实现或审核完成、分支仍有未合并工作，但 Beads 投影状态或 claim 元数据已经过期，诊断会显示 `state_inconsistent` 并提示运行 `archloop tasks repair-state <selector>`；若任务处于 failed 或 stale execution 状态，`archloop tasks recover <selector>` 也可能适用。`run --flow` 启动时会提前提醒宿主仓库存在 dirty source files；若已有 `waiting_for_merge` 批次，会先做 overlap 检查。非重叠脏文件不会阻塞：archLoop 会在干净的 integration worktree/branch 中验证 merge，并在落回宿主前再次确认不会覆盖脏文件。若输出显示 dirty 文件会被覆盖或冲突，任务会留在 `waiting_for_merge`，按列出的 blocking files 先 commit、stash 或 discard，再重新运行同一个 flow 即可恢复批次。

### 7.3 Flow 状态

Hub task board 使用这些状态：

| 状态                | 含义                                        |
| ------------------- | ------------------------------------------- |
| `inbox`             | 新任务，等待 triage                         |
| `needs_info`        | 需要补充信息                                |
| `ready_for_agent`   | 可以交给 agent 实现                         |
| `ready_for_human`   | 等待人工处理                                |
| `blocked`           | 被依赖任务阻塞                              |
| `implementing`      | agent 正在实现                              |
| `reviewing`         | reviewer 正在审核                           |
| `waiting_for_merge` | 当前任务已实现/审核，等待同批任务进入 merge |
| `merging`           | 正在合并                                    |
| `done`              | 已合并、验证通过、本地任务已关闭            |
| `wontfix`           | 确认不处理                                  |
| `failed`            | 执行、sandbox、merge、验证或关闭失败        |
| `sync_conflict`     | 本地和远端同步语义冲突                      |

`project status` 会给出 repo root、archLoop user data directory、Hub project directory、selected project profile、contract path、`bd` 可用性、task board ready/total、active runs、failed tasks、sync state、recent events、Hub run 目录、worktree lease diagnostics，以及 managed branch cleanup diagnostics。

查看当前进度：

```bash
archloop project status
archloop tasks list
```

## 8 GitHub Issues 同步

Hub task board 的本地任务源是 Beads。GitHub Issues 是远端协作表，通过同步命令 pull / push。

```bash
archloop tasks pull
archloop tasks push
archloop tasks sync
archloop tasks resolve <id> --keep local|remote
```

成功同步后输出方向性 `section`（↓ pulled / ↑ pushed）。有变更时在对应方向下缩进列出每个任务（`<id> <title> <github#N>`）；冲突行额外显示 dim 的 reason。空摘要（`nothing new` / `nothing to push`）不打印条目列表。有冲突时 footer 变为 `fix` 并指向 `archloop tasks resolve <id>`。`--json` 输出含完整 `entries[]`；全局 `--plain`（或 `NO_COLOR`）保留同样信息但无颜色：

```text
  archLoop · sync · demo                                                    owner/repo
  ↓ pulled  4 created  0 updated · 0 conflicts · 0 dup-candidates
     arch-abc  Import open issues into Beads                                 github#101
  ↑ pushed  nothing to push  0 synced · 0 closed · 0 pending
    done in 1.4s
  next  archloop tasks list
```

`archloop tasks resolve <id>` 读取本地 `sync_conflict` 标记与关联 GitHub issue，展示 local / remote 分歧字段，再用 `--keep local|remote`（TTY 下可交互选择）写回 Beads。`--keep local` 会把 `sync_state` 设为 `push_pending` 并保留本地字段；`--keep remote` 用远端覆盖本地并设为 `synced`。解析只改本地 Beads，不直接调用 `gh issue edit/close`。非交互模式必须带 `--keep`；`--json` 输出 `{ id, kept, mutations }`。

同步规则：

| 方向             | 行为                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- |
| GitHub -> Beads  | 拉取带 archLoop 协作标签的 issue                                                   |
| Beads -> GitHub  | 推送协作标签、关闭 `done` / `wontfix` 任务                                         |
| Proposal flows   | 只写本地 Beads，不直接改 GitHub                                                    |
| Execution states | `implementing`、`reviewing`、`waiting_for_merge`、`merging`、`failed` 保持本地状态 |

如果同步失败，本地已完成任务不会被重新打开；任务会保留 `push_pending` 或 `conflict` 元数据，供后续处理。

## 9 Recovery

任务卡在失败或中间态时，使用 recovery 命令修复。

```bash
archloop tasks recover 1
```

要一次性恢复所有被中断的任务（`implementing` / `reviewing` / `merging` 且没有活跃 worktree lease），使用 `--stale`：

```bash
archloop tasks recover --stale
```

`--stale` 会加载 task board、worktree leases 与 run event log，经共享的 interrupted-execution detector 标记中断任务，再按 event-aware recovery router 逐个路由——与单任务 `recover` 走完全相同的路由逻辑，已完成阶段不会被重做。默认只打印 dry-run 预览（每任务列出 prior status -> target、claim 保留或释放、原因），传 `--yes`（或在 TTY 中交互确认）后才会落地，行为镜像 `tasks repair-state` 的确认模式；非交互/CI 环境不传 `--yes` 时只预览并退出，不修改状态。

常见用途：

| 场景                 | 结果                                       |
| -------------------- | ------------------------------------------ |
| agent / sandbox 失败 | 释放 stale claim，回到可重试状态           |
| merge conflict       | 保留失败原因，允许人工处理后恢复           |
| verification failure | 修复验证问题后重新进入可恢复路径           |
| close_failed         | 如果分支已合并且验证通过，重试关闭本地任务 |

## 10 Legacy Repo-local Scaffold 兼容路径

`archloop init` 继续存在，适用于需要 repo-local 脚手架和自定义 TypeScript 编排的场景。Hub-wide setup 仍然请先使用 `archloop initialize`。

```bash
archloop init
```

运行旧流程：

```bash
npx tsx ./.archloop/main.ts
```

如果生成的是 `main.mts`：

```bash
npx tsx ./.archloop/main.mts
```

一旦使用：

```bash
archloop run --flow no-review
```

就会使用 archLoop Hub 自带的 flow prompt，而不是项目 `.archloop/` 中生成的 main 脚本或 prompt。

## 11 QA 建议路径

建议按下面顺序做首轮 QA：

1. 先在 Hub 中选中或显式指定目标项目，再运行 `archloop project status`，确认不需要 `.archloop/`。
2. 运行 `archloop agent-config init`，配置 `planning`、`triage`、`implementation`、`review`、`merge`、`recovery`。
3. 运行 `archloop env init`，配置 agent 和 GitHub 所需凭据。
4. 运行 `archloop tasks init`，再用 `archloop tasks create` 创建 2 到 3 个测试任务。
5. 用 `archloop tasks list` 确认看板有 status badges + Beads id（无 1-based 序号），用 `tasks show` 分别测试 id、标题选择；确认数字序号会被拒绝。
6. 用 `archloop tasks comment` 追加评论，再用 `tasks show` 验证评论可见。
7. 准备一个 PRD 文件，运行 `archloop tasks from-prd <prd-file>`，人工调整 proposal 后确认写入。
8. 运行 `archloop tasks triage`，确认 agent 能给出状态建议并写入本地 Beads。
9. 将至少一个任务变为 `ready_for_agent`，运行 `archloop run --flow no-review`，确认 run plan + 3s debounce（或 `--yes` 跳过）。
10. 再准备一轮任务，运行 `archloop run --flow with-review`。
11. 运行 `archloop tasks sync`，验证 GitHub Issues pull / push 行为与 ↓/↑ section 输出。
12. 人工制造一个失败或 stale 状态，运行 `archloop tasks recover <selector>`。
13. 运行 legacy `archloop init`，确认旧的 `.archloop/main.ts` 或 `.archloop/main.mts` 路径仍可用，并再次确认 Hub onboarding 仍然以 `archloop initialize` 为入口。

## 12 验收指标

| 指标                          | 通过标准                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Unified interface 不依赖 init | `project status`、`tasks list`、`run --flow` 不要求目标项目已有 `.archloop/` |
| 共享配置可复用                | 不同项目读取同一套 Hub agent config 和 Hub env                               |
| Task selector 易用            | id、标题可选中任务；列表序号不再被接受                                       |
| Proposal flow 有人工确认      | PRD 拆解和 triage 都能反复讨论后再 apply                                     |
| Proposal flow 不直接改远端    | `from-prd` / `triage` 只写本地 Beads                                         |
| Flow prompt 来源正确          | `run --flow` 使用 archLoop Hub 自带 prompt                                   |
| Merge 结果可追踪              | 每个任务能区分合并成功、失败或未处理                                         |
| Legacy init 兼容              | 旧项目仍可运行生成的 main 脚本                                               |

## 文档修改记录

| 修改日期   | 修改项                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-20 | Variant C Phase 4：对齐 `section` 示例输出、注明 1-based 序号选择器已移除、补充 run debounce / `--plain`/`NO_COLOR` 说明                     |
| 2026-06-19 | 更新为 unified-interface 首版用户使用指南，补充 Hub 配置、任务表、PRD 拆解、triage、flow 执行、GitHub 同步、recovery 和 legacy init 兼容说明 |
