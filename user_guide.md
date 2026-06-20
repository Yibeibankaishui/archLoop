# Sandcastle Unified Interface 用户使用指南

## 1 功能概述

Sandcastle unified interface 是 Sandcastle 的新主入口。它把项目管理、共享凭据、agent role 配置、任务表、PRD 拆解、任务 triage 和 flow 执行集中到 `sandcastle` CLI 中。

首版主仓库为：

```text
https://github.com/Yibeibankaishui/sandcastle.git
```

旧的 `sandcastle init` 方式仍然保留。已经使用 `.sandcastle/main.ts` 或 `.sandcastle/main.mts` 的项目可以继续按原流程运行；新的主要使用方式推荐直接使用 Hub / task board / flow 命令。

## 2 使用边界

Unified interface 面向一个已有 Git 项目运行。目标项目需要满足：

| 条件             | 说明                                                             |
| ---------------- | ---------------------------------------------------------------- |
| Git 仓库         | 仓库至少已有一个 commit                                          |
| Sandcastle CLI   | 示例统一使用 `sandcastle`，没有全局命令时可改用 `npx sandcastle` |
| Beads task store | Hub task board 使用 Beads 保存本地任务                           |
| Agent runtime    | 需要至少一个可用的 agent provider 和模型                         |
| Hub credentials  | 共享凭据保存在 Sandcastle user data directory 中                 |

Hub flow 使用 Sandcastle 自带的 flow prompt，不读取目标项目里的 `.sandcastle/main.ts` 或 `.sandcastle` prompt。目标项目不需要先执行 `sandcastle init`。

## 3 首次配置

### 3.1 检查项目状态

在目标项目根目录运行：

```bash
sandcastle project status
```

这个命令用于确认：

| 输出项                         | 用途                                         |
| ------------------------------ | -------------------------------------------- |
| Repo root                      | Sandcastle 识别到的目标项目根目录            |
| Sandcastle user data directory | Hub 状态、共享凭据、运行记录所在位置         |
| Hub project directory          | 当前项目的 Hub 运行状态目录                  |
| Beads availability             | Beads 是否可用                               |
| Task summary                   | 当前任务表、失败任务、运行批次、同步状态摘要 |

### 3.2 配置 agent roles

Hub flow 使用统一的 role 配置，配置对所有项目生效。

```bash
sandcastle agent-config init
```

也可以单独设置某个 role：

```bash
sandcastle agent-config set-role planning --provider cursor --model gpt-5.4
sandcastle agent-config set-role triage --provider cursor --model gpt-5.4
sandcastle agent-config set-role implementation --provider cursor --model gpt-5.4
sandcastle agent-config set-role review --provider cursor --model gpt-5.4
sandcastle agent-config set-role merge --provider cursor --model gpt-5.4
sandcastle agent-config set-role recovery --provider cursor --model gpt-5.4
```

查看当前配置：

```bash
sandcastle agent-config show
sandcastle agent-config path
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

Hub v1 使用 Sandcastle user data directory 下的本地明文 `.env` 文件保存共享凭据。它不是 secret vault；请按本地敏感文件管理。

```bash
sandcastle env init
```

Codex users can choose `sandcastle auth login codex` for a Codex/ChatGPT CLI login session instead of setting `OPENAI_KEY`, which uses OpenAI API billing. GitHub Issues task sync can use `sandcastle auth login github` instead of `GH_TOKEN`.

也可以单独设置：

```bash
sandcastle env set CURSOR_API_KEY
sandcastle env set ANTHROPIC_API_KEY
sandcastle env set OPENAI_KEY
sandcastle env set OPENCODE_API_KEY
sandcastle env set GH_TOKEN
```

查看配置：

```bash
sandcastle env show
sandcastle env path
sandcastle auth show
```

`process.env` 中的同名变量会覆盖 Hub `.env` 中的值。

## 4 任务表使用

### 4.1 初始化或查看 Beads

如果目标项目还没有 Beads 数据，可以先初始化：

```bash
bd init
```

查看 Sandcastle 投影后的任务表：

```bash
sandcastle tasks list
```

任务选择器支持三种写法：

| 写法                  | 示例                   |
| --------------------- | ---------------------- |
| Beads id              | `todo-list-demo-mv2`   |
| 任务标题              | `"Fix login redirect"` |
| `tasks list` 中的序号 | `1`                    |

查看任务详情：

```bash
sandcastle tasks show 1
sandcastle tasks show "Fix login redirect"
sandcastle tasks show todo-list-demo-mv2
```

### 4.2 创建任务

创建普通 inbox 任务：

```bash
sandcastle tasks create "Fix login redirect"
```

创建用户反馈任务：

```bash
sandcastle tasks create "Improve empty state copy" --origin user-feedback --kind ux
```

附带描述：

```bash
sandcastle tasks create "Handle expired token" --description "User is redirected to a blank page after token expiry."
```

### 4.3 追加评论

```bash
sandcastle tasks comment 1 --body "QA reproduced this on a fresh checkout."
```

不传 `--body` 时会进入交互输入。

### 4.4 删除本地任务

删除只影响本地 Beads task，不删除 GitHub Issue。

```bash
sandcastle tasks delete 1 --dry-run
sandcastle tasks delete 1 --yes
```

## 5 PRD 拆解与 Triage

### 5.1 从 PRD 生成本地任务

推荐入口：

```bash
sandcastle tasks from-prd docs/prd/example.md
```

这个命令会启动 agent-driven proposal session。你可以在会话里要求 agent 拆分、合并、重排、调整依赖、补充验收标准，确认后才会写入本地 Beads。

非交互一轮模式：

```bash
sandcastle tasks from-prd docs/prd/example.md --yes
```

`--yes` 仍会调用 agent 并校验结构化输出，默认创建 inbox 任务，不会静默创建 ready 状态任务。

等价 flow 入口：

```bash
sandcastle run . --flow prd-decomposition --input docs/prd/example.md
```

### 5.2 Triage inbox / needs_info 任务

交互选择任务：

```bash
sandcastle tasks triage
```

指定单个任务：

```bash
sandcastle tasks triage todo-list-demo-mv2
```

按状态查询：

```bash
sandcastle tasks triage --query inbox,needs_info
```

非交互高置信自动应用：

```bash
sandcastle tasks triage --yes
```

`triage --yes` 只自动应用高置信、非关闭、非依赖变更的决策。需要人工确认的决策会被跳过并记录为未确认。

等价 flow 入口：

```bash
sandcastle run . --flow triage --input inbox,needs_info
```

## 6 执行 Flow

### 6.1 无 reviewer flow

```bash
sandcastle run . --flow no-review
```

适合先验证最短闭环：读取 `ready_for_agent` 队列，执行实现任务，成功后进入 `waiting_for_merge`，再按批次合并并关闭本地任务。

### 6.2 带 reviewer flow

```bash
sandcastle run . --flow with-review
```

适合需要实现后审核的流程：实现成功后进入 `reviewing`，review 完成后进入 `waiting_for_merge`，再进入 merge 阶段。

### 6.3 Flow 状态

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

查看当前进度：

```bash
sandcastle project status
sandcastle tasks list
```

## 7 GitHub Issues 同步

Hub task board 的本地任务源是 Beads。GitHub Issues 是远端协作表，通过同步命令 pull / push。

```bash
sandcastle tasks sync
```

同步规则：

| 方向             | 行为                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- |
| GitHub -> Beads  | 拉取带 Sandcastle 协作标签的 issue                                                 |
| Beads -> GitHub  | 推送协作标签、关闭 `done` / `wontfix` 任务                                         |
| Proposal flows   | 只写本地 Beads，不直接改 GitHub                                                    |
| Execution states | `implementing`、`reviewing`、`waiting_for_merge`、`merging`、`failed` 保持本地状态 |

如果同步失败，本地已完成任务不会被重新打开；任务会保留 `push_pending` 或 `conflict` 元数据，供后续处理。

## 8 Recovery

任务卡在失败或中间态时，使用 recovery 命令修复。

```bash
sandcastle tasks recover 1
```

常见用途：

| 场景                 | 结果                                       |
| -------------------- | ------------------------------------------ |
| agent / sandbox 失败 | 释放 stale claim，回到可重试状态           |
| merge conflict       | 保留失败原因，允许人工处理后恢复           |
| verification failure | 修复验证问题后重新进入可恢复路径           |
| close_failed         | 如果分支已合并且验证通过，重试关闭本地任务 |

## 9 Legacy Init 兼容路径

`sandcastle init` 继续存在，适用于需要项目内脚手架和自定义 TypeScript 编排的场景。

```bash
sandcastle init
```

运行旧流程：

```bash
npx tsx ./.sandcastle/main.ts
```

如果生成的是 `main.mts`：

```bash
npx tsx ./.sandcastle/main.mts
```

一旦使用：

```bash
sandcastle run . --flow no-review
```

就会使用 Sandcastle Hub 自带的 flow prompt，而不是项目 `.sandcastle/` 中生成的 main 脚本或 prompt。

## 10 QA 建议路径

建议按下面顺序做首轮 QA：

1. 在目标 Git 项目中运行 `sandcastle project status`，确认不需要 `.sandcastle/`。
2. 运行 `sandcastle agent-config init`，配置 `planning`、`triage`、`implementation`、`review`、`merge`、`recovery`。
3. 运行 `sandcastle env init`，配置 agent 和 GitHub 所需凭据。
4. 运行 `bd init`，再用 `sandcastle tasks create` 创建 2 到 3 个测试任务。
5. 用 `sandcastle tasks list` 确认任务带序号，用 `tasks show` 分别测试 id、标题、序号选择。
6. 用 `sandcastle tasks comment` 追加评论，再用 `tasks show` 验证评论可见。
7. 准备一个 PRD 文件，运行 `sandcastle tasks from-prd <prd-file>`，人工调整 proposal 后确认写入。
8. 运行 `sandcastle tasks triage`，确认 agent 能给出状态建议并写入本地 Beads。
9. 将至少一个任务变为 `ready_for_agent`，运行 `sandcastle run . --flow no-review`。
10. 再准备一轮任务，运行 `sandcastle run . --flow with-review`。
11. 运行 `sandcastle tasks sync`，验证 GitHub Issues pull / push 行为。
12. 人工制造一个失败或 stale 状态，运行 `sandcastle tasks recover <selector>`。
13. 运行 legacy `sandcastle init`，确认旧的 `.sandcastle/main.ts` 或 `.sandcastle/main.mts` 路径仍可用。

## 11 验收指标

| 指标                          | 通过标准                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Unified interface 不依赖 init | `project status`、`tasks list`、`run --flow` 不要求目标项目已有 `.sandcastle/` |
| 共享配置可复用                | 不同项目读取同一套 Hub agent config 和 Hub env                                 |
| Task selector 易用            | id、标题、列表序号都可选中任务                                                 |
| Proposal flow 有人工确认      | PRD 拆解和 triage 都能反复讨论后再 apply                                       |
| Proposal flow 不直接改远端    | `from-prd` / `triage` 只写本地 Beads                                           |
| Flow prompt 来源正确          | `run --flow` 使用 Sandcastle Hub 自带 prompt                                   |
| Merge 结果可追踪              | 每个任务能区分合并成功、失败或未处理                                           |
| Legacy init 兼容              | 旧项目仍可运行生成的 main 脚本                                                 |

## 文档修改记录

| 修改日期   | 修改项                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-19 | 更新为 unified-interface 首版用户使用指南，补充 Hub 配置、任务表、PRD 拆解、triage、flow 执行、GitHub 同步、recovery 和 legacy init 兼容说明 |
