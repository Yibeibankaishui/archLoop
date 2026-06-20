# Sandcastle 中文使用指南

在**其他待开发项目**中接入 Sandcastle 的说明。完整 API 与英文文档见 [README.md](./README.md)、[user_guide.md](./user_guide.md)。

## Sandcastle 是什么

Sandcastle（`@ai-hero/sandcastle`）是一个 TypeScript 工具包，用于在**隔离沙箱**（Docker、Podman、Vercel 等）中编排 AI 编程代理，并统一管理：

- 提示词与多轮迭代
- 分支 / git worktree 策略
- 提交收集与合并
- 运行日志

典型场景：并行 AFK agent、实现→评审流水线、从 GitHub Issues 自动领任务并提交。

## 核心思路：按仓库配置

Sandcastle **不是**全局装一次到处用，而是**每个 Git 项目单独初始化**：

| 层级     | 说明                                                               |
| -------- | ------------------------------------------------------------------ |
| 依赖     | 写在**目标项目**的 `package.json`（如 `devDependencies`）          |
| 配置目录 | 项目根下的 `.sandcastle/`（Dockerfile、prompt、`main.ts`、`.env`） |
| 镜像     | 默认名 `sandcastle:<仓库目录名>`，按项目构建                       |

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
npm install --save-dev @ai-hero/sandcastle
# 或
pnpm add -D @ai-hero/sandcastle
```

### 步骤 2：初始化（每个项目仅一次）

```bash
npx sandcastle init
```

交互式会询问：Sandbox 提供商、Backlog 管理器、工作流模板、**Project profile**（项目类型）、默认 agent 与镜像内安装的 runtime 等。

**非交互示例**（Node 项目 + 简单循环 + 构建镜像）：

```bash
npx sandcastle init \
  --agent claude-code \
  --sandbox docker \
  --backlog github-issues \
  --template simple-loop \
  --project-profile node \
  --build-image true
```

**重要**：若已存在 `.sandcastle/`，`init` 会**报错并拒绝覆盖**，避免冲掉自定义配置。需要重做时请手动备份后删除该目录再 init。

初始化后典型目录结构：

```
.sandcastle/
├── Dockerfile          # Podman 时为 Containerfile
├── bootstrap.sh        # 沙箱就绪时在仓库内执行的准备脚本
├── main.mts            # 或 main.ts — 编排入口
├── prompt.md           # 及模板附带的其他 prompt 文件
├── .env.example
└── .gitignore
```

### 步骤 3：配置环境变量

```bash
cp .sandcastle/.env.example .sandcastle/.env
# 编辑 .sandcastle/.env，填入所需 token
```

常见变量（以 init 所选 runtime 为准）：

| 变量                                          | 用途                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                           | Claude Code / Pi                                                                  |
| `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` | Claude 兼容网关（可选）                                                           |
| `OPENAI_KEY`                                  | Codex API key（也可用 `sandcastle auth login codex` 配置 Codex/ChatGPT CLI 登录） |
| `CURSOR_API_KEY`                              | Cursor                                                                            |
| `GH_TOKEN`                                    | GitHub Issues backlog（也可用 `sandcastle auth login github`）                    |

### 步骤 4：构建沙箱镜像

```bash
npx sandcastle docker build-image
# Podman 项目：
# npx sandcastle podman build-image
```

修改 `.sandcastle/Dockerfile` 或 `Containerfile` 后需重新执行 build。

### 步骤 5：运行编排

```bash
npm install
npm run sandcastle
# 若生成的是 main.ts，将文件名改为 main.ts
```

建议在目标项目 `package.json` 中增加脚本，例如：

```json
{
  "scripts": {
    "sandcastle": "npx tsx ./.sandcastle/main.ts"
  }
}
```

然后执行 `npm run sandcastle` 或 `pnpm sandcastle`。

---

## 如何选择 Project profile 与模板

### Project profile（项目类型）

在 `sandcastle init` 时选择（`--project-profile`），影响 **Dockerfile 工具层**、**bootstrap.sh** 以及生成 prompt 中的**默认验证命令提示**（如 Node 用 npm、Python 用 pytest 等），不影响 `run()` 等运行时 API。

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

`course-video-manager` 使用 `parallel-planner-with-review`：规划 issue → 最多 4 路并行 `createSandbox` → 实现与评审 → 合并分支。入口见该项目 `.sandcastle/main.ts`。

---

## 针对其他仓库运行（不 chdir 到目标项目）

编排脚本可在 A 仓库，通过 `cwd` 指定 B 仓库为宿主：

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  cwd: "/path/to/other-repo",
  promptFile: ".sandcastle/prompt.md",
});
```

说明：

- `cwd`：宿主仓库路径，用于 `.sandcastle/worktrees/`、git 操作等。
- `promptFile`：相对**执行脚本时**的 `process.cwd()` 解析，**不是**相对 `cwd`。
- 仍建议在**目标仓库**内保留 `.sandcastle/` 配置。

交互式会话（无沙箱）可指定目录：

```typescript
import { interactive, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

await interactive({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: noSandbox(),
  cwd: "/path/to/other-repo",
});
```

---

## 本地开发 Sandcastle 源码

使用本仓库 `/home/bai/code/sandcastle` 而非 npm 发布包时：

```bash
cd /path/to/sandcastle
npm install && npm run build
npm link

cd /path/to/your-project
npm link @ai-hero/sandcastle
```

或在目标项目 `package.json` 中：

```json
"@ai-hero/sandcastle": "file:../sandcastle"
```

修改 sandcastle 源码后需在 sandcastle 目录重新 `npm run build`。

---

## 与 Docker Desktop「Sandbox」的区别

部分文档中的 **Docker Desktop Sandbox**（`docker sandbox run`、模板镜像）与 Sandcastle \*\*不是同一套机制：

|            | Docker Desktop Sandbox    | Sandcastle                                    |
| ---------- | ------------------------- | --------------------------------------------- |
| 隔离方式   | 官方 sandbox 模板 / 微 VM | 普通 Docker/Podman 容器 + bind-mount worktree |
| 环境变量   | 注入困难，常需交互登录    | `.sandcastle/.env` + provider `env`           |
| Git / 分支 | 能力有限                  | worktree、显式分支、提交收集与合并            |
| 适用       | 快速单次 Claude 会话      | 多 agent、多分支、可重复流水线                |

Sandcastle 使用常规容器将宿主 worktree 挂载进沙箱，agent 在容器内写回挂载目录，无需依赖 `docker sandbox` CLI。

---

## 接入后验证清单

1. **Git**：`git log` / `git status` 是否出现预期分支与提交。
2. **日志**：`.sandcastle/logs/` 是否生成对应运行日志。
3. **沙箱环境**：容器内能否执行项目关键命令（测试、构建、启动）；不足则改 `Dockerfile` 与 `bootstrap.sh`。
4. **凭据**：`.sandcastle/.env` 是否在 init 提示的变量均已填写。

---

## 最小 API 示例

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});
```

## 常用 CLI

| 命令                             | 说明                                 |
| -------------------------------- | ------------------------------------ |
| `sandcastle init`                | 生成 `.sandcastle/`                  |
| `sandcastle docker build-image`  | 从 `.sandcastle/Dockerfile` 构建镜像 |
| `sandcastle docker remove-image` | 删除镜像                             |
| `sandcastle podman build-image`  | Podman 构建                          |
| `sandcastle podman remove-image` | Podman 删除镜像                      |

## Agent skill（接入说明）

本仓库附带可移植的 agent skill：[`skills/sandcastle-usage/SKILL.md`](./skills/sandcastle-usage/SKILL.md)，用于指导 AI 编程代理（Cursor、Claude、Codex 等）在目标项目中接入并运行 Sandcastle。

该 skill **不会自动安装**。将其目录复制到对应代理的 skills 目录即可启用：

```bash
# 按所用代理选择目录（不存在则先创建）：
cp -R skills/sandcastle-usage ~/.agents/skills/sandcastle-usage    # 通用 / 共享
cp -R skills/sandcastle-usage ~/.cursor/skills/sandcastle-usage    # Cursor
cp -R skills/sandcastle-usage ~/.claude/skills/sandcastle-usage    # Claude
cp -R skills/sandcastle-usage ~/.codex/skills/sandcastle-usage     # Codex
```

Sandcastle 升级后若改动了 CLI、init 流程、模板或 API，请重新复制最新 skill。

## 进一步阅读

- [README.md](./README.md) — 完整 API、`run()` / `createSandbox()` / `createWorktree()`、Hooks、Prompt 占位符
- [user_guide.md](./user_guide.md) — 中文功能概述与参数表
- [CONTEXT.md](./CONTEXT.md) — 术语与架构概念
- [docs/adr/0015-project-profiles-bootstrap-at-init.md](./docs/adr/0015-project-profiles-bootstrap-at-init.md) — Project profile 与 bootstrap 设计

## 工作区参考项目

| 项目                   | 说明                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `course-video-manager` | 已接入 Sandcastle，`package.json` 含 `@ai-hero/sandcastle` 与 `sandcastle` 脚本；`.sandcastle/` 为 parallel-planner-with-review 实例 |

---

## 文档修改记录

| 日期       | 说明                                               |
| ---------- | -------------------------------------------------- |
| 2026-05-20 | 初版：在其他待开发项目中接入 Sandcastle 的中文指南 |
