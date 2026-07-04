# archLoop 中文使用指南

在**其他待开发项目**中接入 archLoop 的说明。完整 API 与英文文档见 [README.md](./README.md)、[user_guide.md](./user_guide.md)。

## archLoop 是什么

archLoop（`@yibeibankaishui/archloop`）是一个 TypeScript 工具包，用于在**隔离沙箱**（Docker、Podman、Vercel 等）中编排 AI 编程代理，并统一管理：

- 提示词与多轮迭代
- 分支 / git worktree 策略
- 提交收集与合并
- 运行日志

典型场景：并行 AFK agent、实现→评审流水线、从 GitHub Issues 自动领任务并提交。

如果想先浏览已注册的 Hub project，可以运行 `archloop project list`：它会显示项目名、repo path、Project profile、selected 标记、path/task readiness 标签，以及 active run 概览，方便先挑选再切换。

## 核心思路：按仓库配置

archLoop **不是**全局装一次到处用，而是**每个 Git 项目单独初始化**：

| 层级     | 说明                                                             |
| -------- | ---------------------------------------------------------------- |
| 依赖     | 写在**目标项目**的 `package.json`（如 `devDependencies`）        |
| 配置目录 | 项目根下的 `.archloop/`（Dockerfile、prompt、`main.ts`、`.env`） |
| 镜像     | 默认名 `archloop:<仓库目录名>`，按项目构建                       |

工作区内已有参考实现：`course-video-manager`（`parallel-planner-with-review` 模板）。

---

## 在新项目中接入

### 前置条件

| 条件       | 说明                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| Git 仓库   | 必须已初始化或克隆完成                                                             |
| 容器运行时 | 本地常用 [Docker Desktop](https://www.docker.com/) 或 [Podman](https://podman.io/) |
| API 凭据   | 按所选 agent 与 backlog 准备（见下方环境变量）                                     |

### 步骤 1：安装依赖

在**目标项目根目录**执行：

```bash
npm install --save-dev @yibeibankaishui/archloop
# 或
pnpm add -D @yibeibankaishui/archloop
```

### 步骤 2：初始化（每个项目仅一次）

```bash
npx archloop init
```

交互式会询问：Sandbox 提供商、Backlog 管理器、工作流模板、**Project profile**（项目类型）、默认 agent 与镜像内安装的 runtime 等。

**非交互示例**（Node 项目 + 简单循环 + 构建镜像）：

```bash
npx archloop init \
  --agent claude-code \
  --sandbox docker \
  --backlog github-issues \
  --template simple-loop \
  --project-profile node \
  --build-image true
```

**重要**：若已存在 `.archloop/`，`init` 会**报错并拒绝覆盖**，避免冲掉自定义配置。需要重做时请手动备份后删除该目录再 init。

初始化后典型目录结构：

```
.archloop/
├── Dockerfile          # Podman 时为 Containerfile
├── bootstrap.sh        # 沙箱就绪时在仓库内执行的准备脚本
├── main.mts            # 或 main.ts — 编排入口
├── prompt.md           # 及模板附带的其他 prompt 文件
├── .env.example
└── .gitignore
```

### 步骤 3：配置环境变量

```bash
cp .archloop/.env.example .archloop/.env
# 编辑 .archloop/.env，填入所需 token
```

常见变量（以 init 所选 runtime 为准）：

| 变量                                          | 用途                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                           | Claude Code / Pi                                                                |
| `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` | Claude 兼容网关（可选）                                                         |
| `OPENAI_KEY`                                  | Codex API key（也可用 `archloop auth login codex` 配置 Codex/ChatGPT CLI 登录） |
| `CURSOR_API_KEY`                              | Cursor                                                                          |
| `GH_TOKEN`                                    | GitHub Issues backlog（也可用 `archloop auth login github`）                    |

### 步骤 4：构建沙箱镜像

```bash
npx archloop docker build-image
# Podman 项目：
# npx archloop podman build-image
```

修改 `.archloop/Dockerfile` 或 `Containerfile` 后需重新执行 build。

### 步骤 5：运行编排

```bash
npm install
npm run archloop
# 若生成的是 main.ts，将文件名改为 main.ts
```

建议在目标项目 `package.json` 中增加脚本，例如：

```json
{
  "scripts": {
    "archloop": "npx tsx ./.archloop/main.ts"
  }
}
```

然后执行 `npm run archloop` 或 `pnpm archloop`。

---

## 如何选择 Project profile 与模板

### Project profile（项目类型）

在 `archloop init` 时选择（`--project-profile`），影响 **Dockerfile 工具层**、**bootstrap.sh** 以及生成 prompt 中的**默认验证命令提示**（如 Node 用 npm、Python 用 pytest 等），不影响 `run()` 等运行时 API。

| Profile   | 适用场景                                        |
| --------- | ----------------------------------------------- |
| `generic` | 默认，语言无关，bootstrap 需自行编辑            |
| `node`    | Node / npm / pnpm，bootstrap 处理 lockfile 依赖 |
| `python`  | Python、pip、venv、uv                           |
| `cpp`     | C++、CMake / Makefile                           |

v1 **不会**自动检测项目类型；选最接近的 profile，或保持 `generic`。

非 `blank` 模板会在 `sandbox.onSandboxReady` 中执行 `bootstrap.sh`（worktree 挂载后、agent 运行前）。

### 工作流模板（Template）

与语言无关，按协作方式选择：

| 模板                           | 说明                                  |
| ------------------------------ | ------------------------------------- |
| `blank`                        | 最小脚手架，自行编写 `main` 与 prompt |
| `simple-loop`                  | 逐个处理 issue                        |
| `sequential-reviewer`          | 实现后逐条代码评审                    |
| `parallel-planner`             | 规划 → 多分支并行实现 → 合并          |
| `parallel-planner-with-review` | 并行实现 + 每分支评审后再合并         |

`course-video-manager` 使用 `parallel-planner-with-review`：规划 issue → 最多 4 路并行 `createSandbox` → 实现与评审 → 合并分支。入口见该项目 `.archloop/main.ts`。

---

## 针对其他仓库运行（不 chdir 到目标项目）

编排脚本可在 A 仓库，通过 `cwd` 指定 B 仓库为宿主：

```typescript
import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  cwd: "/path/to/other-repo",
  promptFile: ".archloop/prompt.md",
});
```

说明：

- `cwd`：宿主仓库路径，用于 `.archloop/worktrees/`、git 操作等。
- `promptFile`：相对**执行脚本时**的 `process.cwd()` 解析，**不是**相对 `cwd`。
- 仍建议在**目标仓库**内保留 `.archloop/` 配置。

交互式会话（无沙箱）可指定目录：

```typescript
import { interactive, claudeCode } from "@yibeibankaishui/archloop";
import { noSandbox } from "@yibeibankaishui/archloop/sandboxes/no-sandbox";

await interactive({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: noSandbox(),
  cwd: "/path/to/other-repo",
});
```

---

## 本地开发 archLoop 源码

使用本仓库 `/home/bai/code/archloop` 而非 npm 发布包时：

```bash
cd /path/to/archloop
npm install && npm run build
npm link

cd /path/to/your-project
npm link @yibeibankaishui/archloop
```

或在目标项目 `package.json` 中：

```json
"@yibeibankaishui/archloop": "file:../archloop"
```

修改 archloop 源码后需在 archloop 目录重新 `npm run build`。

---

## 与 Docker Desktop「Sandbox」的区别

部分文档中的 **Docker Desktop Sandbox**（`docker sandbox run`、模板镜像）与 archLoop \*\*不是同一套机制：

|            | Docker Desktop Sandbox    | archLoop                                      |
| ---------- | ------------------------- | --------------------------------------------- |
| 隔离方式   | 官方 sandbox 模板 / 微 VM | 普通 Docker/Podman 容器 + bind-mount worktree |
| 环境变量   | 注入困难，常需交互登录    | `.archloop/.env` + provider `env`             |
| Git / 分支 | 能力有限                  | worktree、显式分支、提交收集与合并            |
| 适用       | 快速单次 Claude 会话      | 多 agent、多分支、可重复流水线                |

archLoop 使用常规容器将宿主 worktree 挂载进沙箱，agent 在容器内写回挂载目录，无需依赖 `docker sandbox` CLI。

---

## 接入后验证清单

1. **Git**：`git log` / `git status` 是否出现预期分支与提交。
2. **日志**：`.archloop/logs/` 是否生成对应运行日志。
3. **沙箱环境**：容器内能否执行项目关键命令（测试、构建、启动）；不足则改 `Dockerfile` 与 `bootstrap.sh`。
4. **凭据**：`.archloop/.env` 是否在 init 提示的变量均已填写。

## Hub flow 脏工作区诊断

`archloop run . --flow no-review` 和 `archloop run . --flow with-review` 启动时会提前提醒宿主仓库里的 dirty source files。若同一个 flow 已有未完成的 `waiting_for_merge` 批次，archLoop 会先恢复该批次，并在领取新任务前检查待合并分支是否会改到这些脏文件。

非重叠脏文件不会阻塞 merge：archLoop 会在干净的 integration worktree/branch 中验证结果，并只在不会覆盖宿主脏文件时落回当前分支。若存在重叠，CLI 会列出具体 blocking files；先 commit、stash 或 discard 这些文件，再重新运行同一个 flow，archLoop 会继续恢复 `waiting_for_merge` 任务。

任务命令默认针对已选中的 Hub project；如需覆盖，可以显式传 `--project <name>`。`.beads/issues.jsonl`、`.beads/interactions.jsonl` 等 Beads runtime/export 文件会单独报告，通常不要提交；通过 `archloop tasks pull` / `push` / `sync` 交换远端任务状态。

---

## 最小 API 示例

```typescript
import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  promptFile: ".archloop/prompt.md",
});
```

## 常用 CLI

| 命令                           | 说明                               |
| ------------------------------ | ---------------------------------- |
| `archloop init`                | 生成 `.archloop/`                  |
| `archloop docker build-image`  | 从 `.archloop/Dockerfile` 构建镜像 |
| `archloop docker remove-image` | 删除镜像                           |
| `archloop podman build-image`  | Podman 构建                        |
| `archloop podman remove-image` | Podman 删除镜像                    |

## Agent skill（接入说明）

本仓库附带可移植的 agent skill：[`skills/archloop-usage/SKILL.md`](./skills/archloop-usage/SKILL.md)，用于指导 AI 编程代理（Cursor、Claude、Codex 等）在目标项目中接入并运行 archLoop。

该 skill **不会自动安装**。将其目录复制到对应代理的 skills 目录即可启用：

```bash
# 按所用代理选择目录（不存在则先创建）：
cp -R skills/archloop-usage ~/.agents/skills/archloop-usage    # 通用 / 共享
cp -R skills/archloop-usage ~/.cursor/skills/archloop-usage    # Cursor
cp -R skills/archloop-usage ~/.claude/skills/archloop-usage    # Claude
cp -R skills/archloop-usage ~/.codex/skills/archloop-usage     # Codex
```

archLoop 升级后若改动了 CLI、init 流程、模板或 API，请重新复制最新 skill。

## 进一步阅读

- [README.md](./README.md) — 完整 API、`run()` / `createSandbox()` / `createWorktree()`、Hooks、Prompt 占位符
- [user_guide.md](./user_guide.md) — 中文功能概述与参数表
- [CONTEXT.md](./CONTEXT.md) — 术语与架构概念
- [docs/adr/0015-project-profiles-bootstrap-at-init.md](./docs/adr/0015-project-profiles-bootstrap-at-init.md) — Project profile 与 bootstrap 设计

## 工作区参考项目

| 项目                   | 说明                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `course-video-manager` | 已接入 archLoop，`package.json` 含 `@yibeibankaishui/archloop` 与 `archloop` 脚本；`.archloop/` 为 parallel-planner-with-review 实例 |

---

## 文档修改记录

| 日期       | 说明                                             |
| ---------- | ------------------------------------------------ |
| 2026-05-20 | 初版：在其他待开发项目中接入 archLoop 的中文指南 |
