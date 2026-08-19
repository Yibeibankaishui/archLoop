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
`.beads/redirect`，以便主机上的 `bd` 命令继续指向同一套任务。已有的仓库内
Beads 库会在第一次变更型 `archloop run` 或 task 命令时自动迁移；若迁移前检测到
活跃 writer、fingerprint 变化、不安全快照或迁移租约占用，则继续使用已验证的
旧库并自动重试。redirect 之后若两套库被独立修改，Hub 会停止自动写入并报告
split brain，不会合并或删除任何一侧。崩溃后按 journal 续跑，不需要
`tasks recover`。
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

| 操作                    | 命令                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 查看全部项目            | `archloop project list`                                                                                            |
| 选择默认项目            | `archloop project select <name>`                                                                                   |
| 查看项目状态            | `archloop project status`                                                                                          |
| 修改项目类型约定        | `archloop project configure --project-profile <profile>`                                                           |
| 配置落地与发布策略      | `archloop project configure --publish-policy off\|best_effort\|required [--remote-target] [--delivery-timeout-ms]` |
| 修改显示名称            | `archloop project rename <project> <new-name>`                                                                     |
| 仓库移动后重新关联      | `archloop project relink <project> --path <repo-path>`                                                             |
| 清理测试泄漏的 Hub 项目 | `archloop project prune-test-fixtures`                                                                             |

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

- `no-review`：实现完成后进入验证和落地。
- `with-review`：每个任务在落地前增加 reviewer 阶段。

任务型 Flow 默认按批次选择任务。若同一个 Flow 存在未完成的待合并批次，
archLoop 会先恢复该批次，再领取新任务。

落地使用 Hub 拥有的本地 Git ref 作为权威目标，不需要远程仓库。同一 publish
target 上的待合并任务领取 durable FIFO/依赖票据；投机候选链按前置 OID 构造，
精确 OID 在依赖允许时并行验证，只有队头用 fenced CAS 落地。前置修复、失败、
已提交宿主贡献或目标漂移只会使受影响后缀失效。已提交的 behind/descendant/
diverged 宿主 tip 会并入权威链并完成验证后，任务候选才继续；未提交宿主状态
既不导入也不修改。宿主 tip 与 publish target 的确定性 merge conflict 记为
`host_contribution_conflict`（pending，不算 shipped 或任务失败）：先解决冲突再
跑同一 Flow，不要用 `tasks recover`。队头激活最多立即重建三次目标漂移，随后保留
`target_quiet_wait`，稳定窗口到来后自动续跑，不重置语义修复预算，也不要求
`tasks recover`。全 pending 批次报告 `pending` / `completed_with_pending_merge`，
不会把未落地任务算成 shipped 或语义失败。archLoop 冻结
任务源提交、在独立 worktree 中构造并验证 merge candidate，再用一次 Git ref
事务推进 publish target、fence 和 landing receipt，然后关闭任务。用户工作区、
index 和未提交改动在落地事务中保持不变。落地之后，Hub 会把宿主分支的快进记入
durable outbox：未被任何 worktree 检出的本地分支用 OID CAS 推进；已检出的分
支只在所属 worktree 里、且 Git 能证明 index、工作区、操作状态、未跟踪文件、
sparse checkout、submodule 和其他 worktree 都安全时才快进。否则记录
`checkout_sync_pending`，用户状态一字不改，并在之后的 `archloop run` 自动重
试。后台投影不会 stash、切分支、force-reset 或跑用户 hooks。待同步不影响
`shipped`，也不拦住后续任务。若任务分支已经提交了 allowlist 内的 Beads
runtime/export 文件（例如 `.beads/issues.jsonl`），Hub 只会从 candidate 中
去掉这些路径并记录过滤结果，不会改写任务分支或用户 checkout；Beads 配置、
文档、hooks 以及未知的 `.beads/**` 路径仍按普通源码变更审查。远程发布默认
`off`，仅发现 `origin` 不会开启推送。显式配置
`archloop project configure --publish-policy best_effort --remote-target origin/main`
后，本地 shipped 会入队 durable publication outbox：网络、凭证、受保护分支或
未知推送结果记为 `target_publish_pending`，自动重试，不撤销本地交付，且与
GitHub 任务同步分开显示。显式配置 `--publish-policy required` 时，任务保持
`publishing`，直到远程祖先证明交付；同一 remote ref 上后继任务可以构造与验证，
但不能越过未确认的前置任务推进本地交付序列。`--delivery-timeout-ms` 控制等待；
超时返回 `completed_with_pending_delivery`（非零退出），不把任务标为语义失败。
推送成功但进程中断后若远程被 force rewrite，记为 integrity incident，不会当成
普通 drift 自动覆盖。每个待合并任务有自己的
落地事务：一个任务被拦住时，独立兄弟任务继续落地，依赖未落地前置任务的兄弟
会等待。Git 冲突和验证失败各最多自动修复两次；耗尽后只把该任务标为
`blocked`（`merge_conflict_unresolved` 或 `verification_failed`），批次在有
成功也有失败时报告 `partial_failed`。同一项目或同一任务的两次运行共用 landing
lease 和 fenced CAS；publish target 在落地前变化时会作废旧 candidate、在新
目标上重建并重新验证。lease / lock / CAS 争用保持 pending，不会变成任务失败。

进程中断后再次执行同一个 `archloop run`，启动阶段会根据已经完成的实现或评审
事件把任务恢复到下一个安全阶段，并保留已有分支和 worktree 内容。未完成的落地
事务会从 candidate ref、verification artifact、atomic receipt 和 Beads close
元数据自动续跑，不需要 `tasks recover`。升级时，已经关闭的历史任务保持完成，
不会补造 landing receipt；若 Git 祖先关系证明任务分支已包含在配置目标中，
下一次变更型 `archloop run` 会把它纳入新的 verified transaction。历史
`merge_succeeded` 事件不能单独证明落地。缺失或分叉的分支会报告
`legacy_landing_integrity`，不会被静默关闭或重新实现。失败任务的 `fix` 指引使用
`tasks recover --stale`；只有运行中断但没有失败任务时，指引会让用户直接重新
执行 `archloop run`。

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

| 现象                        | 处理方式                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 没有默认项目                | `project list` 后执行 `project select`                                                                                 |
| 列表里出现大量 `cli-host-*` | 先 `project prune-test-fixtures` 预览，再 `--apply --yes` 删除测试夹具                                                 |
| 仓库路径失效                | 使用 `project relink` 指向新的 Git 仓库路径                                                                            |
| role 或凭据缺失             | 使用 `agent-config show`、`env show`、`auth show`                                                                      |
| 没有初始提交                | 先在目标仓库创建一次 Git 提交                                                                                          |
| 运行被中断                  | 重新执行同一 Flow，或先用 `tasks recover --stale` 预览                                                                 |
| 任务状态和运行事件不一致    | 先运行 `tasks doctor`，再按建议 repair 或 recover                                                                      |
| 落地后工作区看不到改动      | 权威结果在 Hub publish target；宿主分支仅在安全时快进，否则 `checkout_sync_pending`，清理或切换工作区后再跑同一 Flow   |
| 代码已 shipped 但远程未更新 | 显式 `best_effort` 发布会记 `target_publish_pending`；检查 `--remote-target`、凭证与受保护分支，再跑同一 Flow 自动重试 |
| required 仍在 publishing    | 检查远程 proof / FIFO 前置任务；超时是 `completed_with_pending_delivery`，不是任务失败；继续跑同一 Flow 自动重试       |
| GitHub 同步冲突             | 使用 `tasks resolve --keep local` 或 `--keep remote`                                                                   |
| 工作分支仍有可恢复内容      | 使用 `tasks recover`，不要手动强删 worktree 或分支                                                                     |
| 后续 iteration 启动即 abort | 只要还有剩余 iteration，运行会继续并带上进度摘要；全部用尽且无完成信号才记 `agent_failed`                              |

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
5. archLoop 验证候选提交，并把它落到 Hub publish target 后关闭任务。
6. 运行状态、日志和恢复建议保存在 Hub 项目目录中。

## 文档修改记录

| 修改日期   | 修改项                                                                          |
| ---------- | ------------------------------------------------------------------------------- |
| 2026-06-12 | 创建 Unified Interface 用户指南                                                 |
| 2026-08-01 | 按用户任务重组指南，统一 Hub 优先路径并拆出详细参考链接                         |
| 2026-08-13 | 补充中断自动恢复、批量恢复与任务诊断输出说明                                    |
| 2026-08-13 | 说明后续 iteration 启动 abort 会继续运行，而不是整次失败                        |
| 2026-08-13 | 新 Hub 项目将 Beads 任务表放到 Hub 项目目录，并保留 bd 跳转                     |
| 2026-08-13 | Hub 执行 agent 使用不可变任务快照，notes 由 Hub 写回                            |
| 2026-08-13 | 已有仓库内 Beads 库在首次变更型命令时自动迁移并可崩溃续跑                       |
| 2026-08-13 | 不安全迁移会延期，split brain 会停止自动写入                                    |
| 2026-08-13 | 单任务通过 fenced local landing 落到 Hub publish target                         |
| 2026-08-14 | 中断的落地事务从物理证据自动续跑，doctor 保持只读                               |
| 2026-08-14 | 独立兄弟任务分别落地；有界 Agent 修复隔离坏任务                                 |
| 2026-08-14 | 旧任务分支上的 allowlist Beads runtime 文件会从 candidate 剥离                  |
| 2026-08-14 | 并发落地用 lease 与 fence CAS 互斥；target drift 会重建并重验                   |
| 2026-08-14 | 升级时接纳旧落地历史：已关闭保持完成，无祖先证明不视为落地                      |
| 2026-08-14 | 落地后安全快进宿主分支；不安全 WIP 保持 checkout_sync_pending                   |
| 2026-08-14 | best-effort 远程发布 outbox；失败保持 target_publish_pending                    |
| 2026-08-14 | FIFO 投机链并行验证；宿主贡献入链；target_quiet_wait 防超车                     |
| 2026-08-14 | required 远程交付：publishing、有序 proof、超时 completed_with_pending_delivery |
| 2026-08-15 | 宿主贡献冲突记为 host_contribution_conflict / pending，不算 shipped 或失败      |
| 2026-08-19 | CLI 测试不再写入真实 Hub registry；`project prune-test-fixtures` 清理历史泄漏   |
