# archLoop 中文说明

archLoop（`@yibeibankaishui/archloop`）用于编排 AI 编程代理，统一管理多个
Git 项目、任务、隔离沙箱、代码评审和合并流程。

## 选择使用路径

| 目标                          | 建议入口                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| 第一次配置并执行项目任务      | [Hub 快速开始](#hub-快速开始推荐)                                                |
| 在 TypeScript 中调用 archLoop | [TypeScript API](#typescript-api)                                                |
| 维护已有 `.archloop/` 脚手架  | [Legacy repo-local 指南](./docs/content/docs/guides/legacy-repo-local-setup.mdx) |
| 排查运行失败                  | [故障排查](./docs/content/docs/reference/troubleshooting.mdx)                    |

Hub 是新项目的推荐路径。`archloop init` 仍然可用，但主要用于维护已有的
repo-local 自定义工作流。

## 核心能力

- 在共享 Hub 中注册和切换多个 Git 项目
- 配置规划、实现、评审、合并、Triage 和 Recovery 等 agent role
- 使用保存在 Hub 项目目录中的本地 Beads 任务表（仓库内旧库会自动迁移；有活跃 writer 时延期，redirect 后 split brain 会停止自动写入），并可与 GitHub Issues 同步。Hub flow 执行 agent 只拿到不可变任务快照，结构化 notes 由 Hub 在 attempt 之后写回
- 在 Docker、Podman、Vercel、Daytona 或 no-sandbox 环境中执行代理
- 管理分支和 git worktree，把已验证的候选提交落到 Hub 本地 publish target，落地事务不改用户工作区；同一 publish target 上的待合并任务按 durable FIFO 票据排队，投机候选链按前置 OID 构造并可并行验证精确 OID，只有队头用 fenced CAS 落地；目标漂移最多立即重建三次后进入 `target_quiet_wait`，后续任务不可超车。已提交的宿主 tip 会并入权威链，未提交 WIP 不会被导入。随后仅在 Git 能证明安全时快进宿主分支，否则保持 `checkout_sync_pending` 并自动重试，不影响 `shipped`。远程发布默认关闭；显式配置 `--publish-policy best_effort` 与 `--remote-target` 后，通过 durable outbox 推送，网络/凭证/受保护分支失败记为 `target_publish_pending`，不撤销本地 shipped，且与 GitHub 任务同步分开。仅发现 `origin` 不会开启发布。并发运行用 landing lease 与 fenced CAS 互斥，target drift 会重建并重验。进程中断后再次运行会从 durable evidence 自动续跑落地事务。升级时已关闭任务保持完成；只有 Git 祖先证明才接纳进行中的旧落地，历史 `merge_succeeded` 不能单独证明交付。独立任务失败不会拖住同批兄弟任务，冲突与验证修复有次数上限。已提交 allowlist Beads runtime 文件的旧任务分支仍可落地源码变更
- 从中断的运行和待合并批次继续执行
- 为终端提供可读输出，为自动化提供 JSONL 输出
- 通过 TypeScript API 构建自定义编排

## 前置条件

- Node.js 与 npm
- Git；每个目标仓库至少有一次提交
- 所选 agent provider 的凭据或 CLI 登录状态
- 使用本地容器沙箱时，需要 Docker 或 Podman

## Hub 快速开始（推荐）

安装：

```bash
npm install --save-dev @yibeibankaishui/archloop
```

配置共享 agent role、环境变量和认证：

```bash
npx archloop initialize
```

注册已有 Git 项目：

```bash
npx archloop project add
```

检查 Hub 和当前项目是否已经可以执行：

```bash
npx archloop check
```

运行带评审的任务流程：

```bash
npx archloop run --flow with-review
```

在交互式终端中，archLoop 会提示选择项目、项目类型和任务表设置。完成注册后，
可以从任意目录使用 `project list` 和 `project select` 切换项目。

## 常见操作

### 项目

```bash
npx archloop project list
npx archloop project status
npx archloop project select <项目名>
npx archloop project configure --project-profile node
```

### 任务

```bash
npx archloop tasks list
npx archloop tasks create "改善空状态页面"
npx archloop tasks show <任务ID>
npx archloop tasks triage <任务ID>
```

### GitHub Issues 同步

```bash
npx archloop tasks pull
npx archloop tasks sync --dry-run
npx archloop tasks sync
```

### Flow

```bash
npx archloop run --flow no-review
npx archloop run --flow with-review
npx archloop run --flow with-review --dry-run
npx archloop run --flow with-review --output json
```

Flow 会优先恢复同一流程中尚未完成的待合并批次，再领取新任务。出现异常时，
优先查看：

```bash
npx archloop project status
npx archloop tasks doctor
npx archloop tasks recover <任务ID>
```

## TypeScript API

一次性调用可以使用 `run()`：

```typescript
import { claudeCode, run } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  prompt: "完成需求并验证结果。",
});

console.log(result.commits);
```

其他主要 API：

| API                                   | 使用场景                         |
| ------------------------------------- | -------------------------------- |
| `interactive()`                       | 启动需要人工参与的交互式代理会话 |
| `createSandbox()`                     | 多轮调用或多个代理共用同一个沙箱 |
| `createWorktree()`                    | 单独管理 worktree 生命周期       |
| `Output.object()` / `Output.string()` | 从单次调用中提取结构化输出       |

## 文档导航

| 内容                        | 入口                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| 首次配置和第一个 Flow       | [Getting started](./docs/content/docs/getting-started/index.mdx) |
| Hub、项目、任务与 Flow 概念 | [Core concepts](./docs/content/docs/concepts/index.mdx)          |
| 项目管理、任务同步与恢复    | [Guides](./docs/content/docs/guides/index.mdx)                   |
| CLI 命令查阅                | [CLI reference](./docs/content/docs/cli/index.mdx)               |
| TypeScript API              | [API reference](./docs/content/docs/api/index.mdx)               |
| 配置、环境变量与故障排查    | [Reference](./docs/content/docs/reference/index.mdx)             |
| 中文任务型指南              | [用户使用指南](./user_guide.md)                                  |

## Legacy repo-local 路径

已有项目可以继续通过 `archloop init` 生成并维护 `.archloop/`：

```bash
npx archloop init
```

该目录包含工作流入口、提示文件、环境变量示例以及容器定义。新项目建议优先
使用 Hub；需要维护已有脚手架时，请阅读
[Legacy repo-local 指南](./docs/content/docs/guides/legacy-repo-local-setup.mdx)。

## Agent skill

仓库附带 [`skills/archloop-usage/SKILL.md`](./skills/archloop-usage/SKILL.md)，
可复制到所用 AI 编程代理的 skills 目录。该 skill 不会自动安装。

## 进一步阅读

- [英文 README](./README.md)
- [用户使用指南](./user_guide.md)
- [产品术语](./CONTEXT.md)
- [项目路线图](./docs/roadmap.md)

## 文档修改记录

| 修改日期   | 修改项                                                   |
| ---------- | -------------------------------------------------------- |
| 2026-05-20 | 创建中文接入指南                                         |
| 2026-08-01 | 改为 Hub 优先的文档入口，精简重复 API/CLI 内容并补充导航 |
