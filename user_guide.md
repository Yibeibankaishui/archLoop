# 1 功能概述

## Sandcastle

Sandcastle 是一个用于编排 AI 编程工具的 TypeScript 工具包。它把代码代理的执行过程放进独立的 sandbox 中，并负责串起提示词、分支策略、提交收集和运行日志。

## 解决的问题

Sandcastle 主要用于解决以下场景中的重复工作：

- 在隔离环境中运行 AI 编程工具，避免直接污染当前工作目录
- 为代码修改自动创建分支或 worktree，并在运行结束后回收结果
- 把提示词、环境变量、sandbox 配置和任务来源集中到同一套配置目录
- 支持单次执行、交互式会话、复用 sandbox、多轮迭代和并行流水线

## 核心能力

- 通过 `run()` 发起一次或多次迭代执行
- 通过 `interactive()` 启动交互式代理会话
- 通过 `createSandbox()` 复用同一个 sandbox 连续运行多个阶段
- 通过 `createWorktree()` 创建独立 worktree 后再执行任务
- 支持 Docker、Podman、Vercel 和自定义 sandbox provider
- 支持 Claude Code、Codex、Cursor、OpenCode、Pi 等内置 agent provider
- 支持 `head`、`merge-to-head`、`branch` 三类分支策略
- 支持模板化初始化，快速生成 `.sandcastle/` 配置目录

## 使用边界或前置条件

- 目标目录需要是一个 Git 仓库
- 需要至少一种可用的 sandbox provider
- 需要为所选 agent runtime 和任务来源准备可用凭据
- sandbox 环境需要能运行当前任务涉及的关键命令，例如测试、格式检查或项目启动命令

---

# 2 配置参数

## 配置目录

初始化后，仓库根目录下会生成 `.sandcastle/`。常见文件包括：

| 文件                                            | 说明                |
| ----------------------------------------------- | ------------------- |
| `.sandcastle/.env`                              | 运行时环境变量      |
| `.sandcastle/.env.example`                      | 环境变量模板        |
| `.sandcastle/main.ts` 或 `.sandcastle/main.mts` | 入口脚本            |
| `.sandcastle/prompt.md` 或其他提示词文件        | 传给 agent 的提示词 |
| `.sandcastle/Dockerfile` 或 `Containerfile`     | sandbox 镜像模板    |

## 常用运行参数

下表列出使用者最常调整的公开参数：

| 参数名               | 默认值                   | 说明                                                           |
| -------------------- | ------------------------ | -------------------------------------------------------------- |
| `agent`              | 无                       | 选择具体 agent provider，例如 `claudeCode(...)`、`codex(...)`  |
| `sandbox`            | 无                       | 选择 sandbox provider，例如 `docker()`、`podman()`、`vercel()` |
| `promptFile`         | 无                       | 指向提示词文件                                                 |
| `prompt`             | 无                       | 直接提供内联提示词，和 `promptFile` 二选一                     |
| `promptArgs`         | `{}`                     | 替换提示词中的 `{{KEY}}` 占位符                                |
| `maxIterations`      | `1`                      | 最大迭代次数                                                   |
| `branchStrategy`     | provider 决定            | 控制结果落在哪个分支                                           |
| `logging`            | 写入 `.sandcastle/logs/` | 控制日志输出方式                                               |
| `hooks`              | 无                       | 在 host 或 sandbox 中运行准备命令                              |
| `copyToWorktree`     | 无                       | 在进入 sandbox 前复制指定路径到 worktree                       |
| `idleTimeoutSeconds` | `600`                    | 代理长时间无输出时的超时时间                                   |

## 常见环境变量

具体变量取决于所选 runtime 和任务来源。常见项如下：

| 变量名              | 默认值 | 说明                         |
| ------------------- | ------ | ---------------------------- |
| `ANTHROPIC_API_KEY` | 无     | Claude Code 或 Pi 常用凭据   |
| `OPENAI_KEY`        | 无     | Codex 常用凭据               |
| `CURSOR_API_KEY`    | 无     | Cursor 常用凭据              |
| `OPENCODE_API_KEY`  | 无     | OpenCode 常用凭据            |
| `GH_TOKEN`          | 无     | GitHub Issues 任务源常用凭据 |

---

# 3 外部接口

## 输入

- Git 仓库
- 提示词文件或内联提示词
- `.sandcastle/.env` 中的运行时变量
- sandbox provider 配置
- agent provider 配置

## 输出

- 代理生成的 Git 提交
- 运行日志
- 目标分支名
- 可选的结构化输出结果

## CLI 接口

| 命令                       | 说明                          |
| -------------------------- | ----------------------------- |
| `sandcastle init`          | 生成 `.sandcastle/` 配置目录  |
| `sandcastle --help`        | 查看命令帮助                  |
| `sandcastle docker --help` | 查看 Docker provider 相关命令 |
| `sandcastle podman --help` | 查看 Podman provider 相关命令 |

## JavaScript / TypeScript API

| 接口                                                            | 说明                         |
| --------------------------------------------------------------- | ---------------------------- |
| `run()`                                                         | 一次性执行代理任务           |
| `interactive()`                                                 | 启动交互式代理会话           |
| `createSandbox()`                                               | 创建可复用 sandbox           |
| `createWorktree()`                                              | 创建独立 worktree 后继续运行 |
| `docker()` / `podman()` / `vercel()` / `noSandbox()`            | 创建 sandbox provider        |
| `claudeCode()` / `codex()` / `cursor()` / `opencode()` / `pi()` | 创建 agent provider          |

---

# 4 使用示例

## 初始化项目

```bash
npx sandcastle init
```

执行后会生成 `.sandcastle/` 目录，并根据所选模板写入入口脚本、提示词和运行配置。

## 运行生成的入口脚本

```bash
npm install
npm run sandcastle
```

如果初始化生成的是 `main.ts`，把文件名替换为 `main.ts` 即可。

## 直接通过 API 发起一次执行

```ts
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});
```

## 启动交互式会话

```ts
import { interactive, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

await interactive({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: noSandbox(),
  prompt: "Review the current changes.",
});
```

## 验证方法

- 检查运行后是否产生新提交
- 检查 `.sandcastle/logs/` 中是否生成对应日志
- 检查目标分支是否符合预期
- 如使用结构化输出，检查返回结果是否包含目标字段

---

# 5 工作流程

## 主流程

1. 使用者初始化项目，生成 `.sandcastle/` 配置目录
2. 使用者配置环境变量、提示词和入口脚本
3. 入口脚本创建 agent provider 与 sandbox provider
4. Sandcastle 根据分支策略直接使用当前目录，或创建临时分支 / worktree
5. Sandcastle 启动 sandbox，并把提示词交给 agent
6. agent 在 sandbox 内完成任务并产出提交
7. Sandcastle 收集提交，并按分支策略返回结果或合并结果

## 关键机制

### 分支策略

- `head`：直接在当前工作目录运行
- `merge-to-head`：在临时分支上工作，完成后合并回当前分支
- `branch`：在指定分支上工作，结果保留在该分支

### sandbox 模式

- Docker / Podman：本地 bind-mount sandbox
- Vercel：独立文件系统的隔离 sandbox
- no-sandbox：仅用于交互式场景，直接在 host 上运行

### 模板模式

初始化时可选择不同模板：

- `blank`：最小入口，适合自行编排
- `simple-loop`：单代理循环处理任务
- `sequential-reviewer`：实现后再评审
- `parallel-planner`：规划后并行执行再合并
- `parallel-planner-with-review`：并行执行、逐分支评审后再合并

---

## 文档修改记录

| 修改日期   | 修改项                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| 2026-05-17 | 初始创建用户指南，补充功能概述、配置参数、外部接口、使用示例与工作流程 |
