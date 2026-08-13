# archLoop 用户使用指南

archLoop Unified Interface 用于从一个共享 Hub 管理多个 Git 项目、任务和 AI
编程代理工作流。本指南面向日常使用者，按“配置、管理任务、执行 Flow、恢复”
组织内容。

## 1 功能概述

archLoop 可以帮助使用者：

- 注册、选择和检查多个 Git 项目
- 为不同工作阶段配置 agent provider 与模型
- 在本地任务表中创建、拆解、Triage 和跟踪任务
- 将本地任务与 GitHub Issues 同步
- 执行带评审或不带评审的实现流程
- 查看运行状态，并从中断或失败状态恢复

新项目使用 Hub 工作流，不需要在每个目标仓库执行 `archloop init`。已有
`.archloop/` 脚手架的项目可以继续使用兼容路径。

## 2 使用边界与前置条件

| 条件     | 说明                                                    |
| -------- | ------------------------------------------------------- |
| Git 项目 | 目标目录必须是 Git 仓库，并且至少有一次提交             |
| archLoop | 在用于调用 CLI 的项目中安装 `@yibeibankaishui/archloop` |
| Agent    | 至少为流程需要的 agent role 配置 provider 和 model      |
| 凭据     | 使用 Hub env 或 `archloop auth login` 提供认证          |
| 任务表   | 任务型 Flow 需要 Hub 项目目录中的 Beads 任务表          |
| 沙箱     | 使用容器型 Flow 时，需要可用的 Docker 或 Podman         |

## 3 首次配置

### 3.1 安装并初始化 Hub

```bash
npm install --save-dev @yibeibankaishui/archloop
npx archloop initialize
```

`initialize` 配置共享 agent role、环境变量与认证指引，并默认执行一次轻量
检查。需要避免 provider smoke call 时，可以使用 `--skip-check`。

### 3.2 注册第一个项目

```bash
npx archloop project add
```

交互式流程会询问仓库路径、项目名、Project profile，以及是否初始化 Hub 拥有的
任务表。新项目把 Beads 数据库放在 Hub 项目目录中，并安装 Git-ignored 的
`.beads/redirect`，以便主机上的 `bd` 命令继续指向同一套任务。
脚本中可以显式提供参数：

```bash
npx archloop project add --name demo --path <repo-path> --project-profile node
```

### 3.3 检查状态

```bash
npx archloop check
npx archloop project status
```

`check` 验证 Hub 级 agent 配置、凭据、provider CLI，以及当前项目的仓库、
初始提交、开发约定、任务表和 Flow readiness。

## 4 项目管理

| 操作               | 命令                                                     |
| ------------------ | -------------------------------------------------------- |
| 查看全部项目       | `archloop project list`                                  |
| 选择默认项目       | `archloop project select <name>`                         |
| 查看项目状态       | `archloop project status`                                |
| 修改项目类型约定   | `archloop project configure --project-profile <profile>` |
| 修改显示名称       | `archloop project rename <project> <new-name>`           |
| 仓库移动后重新关联 | `archloop project relink <project> --path <repo-path>`   |

项目选择保存在共享用户数据目录中，因此不依赖当前工作目录。所有主要 Hub
命令都可以使用 `--project <name>` 临时覆盖当前选择。

## 5 Agent 与认证

### 5.1 Agent role

```bash
npx archloop agent-config show
npx archloop agent-config init
npx archloop agent-config set-role implementation \
  --provider codex \
  --model <model>
```

常用 role 包括规划、Triage、实现、评审、合并和恢复。每个 Flow 只要求配置它
实际使用的 role。

### 5.2 环境变量与登录

```bash
npx archloop env show
npx archloop env init
npx archloop auth show
npx archloop auth login codex
npx archloop auth login github
```

Hub env 文件保存 API key；`process.env` 在运行时优先。Codex/ChatGPT CLI 登录
与 `OPENAI_KEY` 是两种不同的认证方式。GitHub Issues 同步使用 Hub 管理的
GitHub CLI 登录或 `GH_TOKEN`。

## 6 任务表使用

### 6.1 查看和创建任务

```bash
npx archloop tasks list
npx archloop tasks create "改善登录失败提示" \
  --description "为过期会话提供清晰的下一步操作"
npx archloop tasks show <task-id>
```

任务选择器使用完整 Beads ID 或精确标题，不使用列表序号。

### 6.2 Triage 与 PRD 拆解

```bash
npx archloop tasks triage <task-id>
npx archloop tasks from-prd <prd-ref>
```

这两类命令会先生成结构化提案，经过校验和确认后才修改本地任务表。在非交互
环境中，自动应用需要显式使用 `--yes`，部分高风险决定仍会被跳过。

### 6.3 评论、诊断与删除

```bash
npx archloop tasks comment <task-id>
npx archloop tasks doctor
npx archloop tasks repair-state <task-id>
npx archloop tasks recover --stale
npx archloop tasks delete <task-id> --dry-run
```

`doctor` 是只读诊断。`repair-state` 只修复本地 archLoop 管理的状态字段；删除
本地任务不会自动删除 GitHub Issue。`tasks list` 会把没有存活 worktree lease 的
执行中任务标记为 `⚠ interrupted`；`recover --stale` 默认只预览所有中断任务的
恢复路径，使用 `--yes` 或交互确认后才批量应用。

## 7 GitHub Issues 同步

```bash
npx archloop tasks pull
npx archloop tasks push
npx archloop tasks sync --dry-run
npx archloop tasks sync
```

| 命令   | 方向                                              |
| ------ | ------------------------------------------------- |
| `pull` | 将带 archLoop 标签的 GitHub Issues 导入本地任务表 |
| `push` | 将已关联的本地状态、标签和关闭结果写回 GitHub     |
| `sync` | 规划并执行双向同步                                |

发生冲突时：

```bash
npx archloop tasks resolve <task-id> --keep local
# 或
npx archloop tasks resolve <task-id> --keep remote
```

先使用 `sync --dry-run` 查看计划。`--keep local` 只在本地解决冲突，需要下一次
`tasks push` 才会写回 GitHub。

## 8 执行 Flow

### 8.1 预览

```bash
npx archloop run --flow with-review --dry-run
```

### 8.2 执行

```bash
npx archloop run --flow no-review
npx archloop run --flow with-review
```

- `no-review`：实现完成后进入验证和合并。
- `with-review`：每个任务在合并前增加 reviewer 阶段。

任务型 Flow 默认按批次选择任务。若同一个 Flow 存在未完成的待合并批次，
archLoop 会先恢复该批次，再领取新任务。

进程中断后再次执行同一个 `archloop run`，启动阶段会根据已经完成的实现或评审
事件把任务恢复到下一个安全阶段，并保留已有分支和 worktree 内容。失败任务的
`fix` 指引使用 `tasks recover --stale`；只有运行中断但没有失败任务时，指引会让
用户直接重新执行 `archloop run`。

### 8.3 自动化输出

```bash
npx archloop run --flow with-review --output plain --yes
npx archloop run --flow with-review --output json --yes
```

- `auto`：交互式终端显示运行卡片；不支持交互时回退到 plain。
- `plain`：稳定的逐行生命周期输出。
- `json`：stdout 只输出 schema version 1 JSONL，适合程序消费。

Proposal Flow 在显式 plain/JSON 模式下属于非交互执行，写入操作需要 `--yes`。

## 9 恢复与故障排查

建议按以下顺序检查：

```bash
npx archloop project status
npx archloop check
npx archloop tasks doctor
npx archloop tasks recover <task-id>
```

常见情况：

| 现象                        | 处理方式                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| 没有默认项目                | `project list` 后执行 `project select`                                                    |
| 仓库路径失效                | 使用 `project relink` 指向新的 Git 仓库路径                                               |
| role 或凭据缺失             | 使用 `agent-config show`、`env show`、`auth show`                                         |
| 没有初始提交                | 先在目标仓库创建一次 Git 提交                                                             |
| 运行被中断                  | 重新执行同一 Flow，或先用 `tasks recover --stale` 预览                                    |
| 任务状态和运行事件不一致    | 先运行 `tasks doctor`，再按建议 repair 或 recover                                         |
| 合并被脏文件阻塞            | 提交、暂存或放弃 CLI 列出的重叠文件后重试同一 Flow                                        |
| GitHub 同步冲突             | 使用 `tasks resolve --keep local` 或 `--keep remote`                                      |
| 工作分支仍有可恢复内容      | 使用 `tasks recover`，不要手动强删 worktree 或分支                                        |
| 后续 iteration 启动即 abort | 只要还有剩余 iteration，运行会继续并带上进度摘要；全部用尽且无完成信号才记 `agent_failed` |

完整诊断索引见
[Troubleshooting](./docs/content/docs/reference/troubleshooting.mdx)。

## 10 Legacy repo-local 兼容路径

已有 `.archloop/` 自定义脚手架的项目可以继续使用：

```bash
npx archloop init
```

该命令生成工作流入口、prompt、环境变量示例和容器定义，并拒绝覆盖已有
`.archloop/`。新项目优先使用 Hub 工作流；只有需要维护现有自定义编排时才选择
这条路径。

详见
[Legacy repo-local setup](./docs/content/docs/guides/legacy-repo-local-setup.mdx)。

## 11 TypeScript 外部接口

| 接口                                  | 作用                                       |
| ------------------------------------- | ------------------------------------------ |
| `run()`                               | 在自动管理的沙箱生命周期中执行一次代理任务 |
| `interactive()`                       | 启动交互式代理会话                         |
| `createSandbox()`                     | 创建可复用沙箱并执行多轮代理任务           |
| `createWorktree()`                    | 独立管理 worktree，并按需连接代理或沙箱    |
| `Output.object()` / `Output.string()` | 从单次调用输出中提取结构化结果             |

API 参数、返回值和生命周期说明见
[API reference](./docs/content/docs/api/index.mdx)。

## 12 工作流程概览

1. `initialize` 准备共享 Hub 配置。
2. `project add` 注册项目并建立项目级约定。
3. 任务进入本地任务表，并按需与 GitHub Issues 同步。
4. `run --flow` 选择任务批次，调用实现与评审 agent。执行 agent 只拿到只读任务快照，结构化 notes 由 Hub 写回任务表。
5. archLoop 验证并合并符合条件的任务分支。
6. 运行状态、日志和恢复建议保存在 Hub 项目目录中。

## 文档修改记录

| 修改日期   | 修改项                                                      |
| ---------- | ----------------------------------------------------------- |
| 2026-06-12 | 创建 Unified Interface 用户指南                             |
| 2026-08-01 | 按用户任务重组指南，统一 Hub 优先路径并拆出详细参考链接     |
| 2026-08-13 | 补充中断自动恢复、批量恢复与任务诊断输出说明                |
| 2026-08-13 | 说明后续 iteration 启动 abort 会继续运行，而不是整次失败    |
| 2026-08-13 | 新 Hub 项目将 Beads 任务表放到 Hub 项目目录，并保留 bd 跳转 |
| 2026-08-13 | Hub 执行 agent 使用不可变任务快照，notes 由 Hub 写回 |
