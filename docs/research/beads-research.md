# Beads 研究整理

整理对象：`beads` / `bd`
研究时间：2026-06-14
结论版本：基于本机安装的 `bd 1.0.4` CLI 帮助，以及 Context7 上的 `/gastownhall/beads` 文档。

## 一句话结论

Beads 不是普通的待办清单，而是一个“依赖感知”的 issue tracker。它把任务、阻塞关系、远程同步、GitHub Issues 同步、以及 AI agent 工作流放在同一套体系里，核心目标是让人和 agent 都能围绕“真正可做的工作”协作。

## 它解决什么问题

1. 把工作从“散落在文档、聊天、脑子里”变成结构化 issue。
2. 通过依赖关系明确谁阻塞谁，避免误抢任务。
3. 为 agent 提供统一工作入口：先看 `bd ready`，再 `--claim`，做完再 `bd close`。
4. 支持 GitHub 同步和 Dolt 远程同步，适合多端协作。

## 关键概念

### Issue

最小工作单元，支持 `bug`、`feature`、`task`、`epic`、`chore`、`decision` 等类型。

### Status

常见状态：

- `open`
- `in_progress`
- `blocked`
- `deferred`
- `closed`

### Dependency

依赖关系是 beads 的核心。

- `A depends on B` 等价于 `B blocks A`
- `bd ready` 只会显示真正没有阻塞依赖的任务

### Ready work

`bd ready` 是日常最重要的入口。它不是“所有 open issue”，而是“现在可以开始做的 issue”。

## 最常用命令

### 初始化

```bash
bd init --prefix myproj
```

常见选项：

- `--server`：外部 Dolt server
- `--stealth`：更偏个人本地使用
- `--skip-agents`：不生成 agent 指南
- `--skip-hooks`：不安装 git hooks

### 创建任务

```bash
bd create "Fix login bug" -t bug -p 1
bd create "Add auth" -t feature -p 0 -d "Implement auth flow"
bd create "Write tests" --assignee alice
```

### 查看和筛选

```bash
bd list
bd list --status open
bd show <id>
bd ready
bd blocked
bd status
```

### 领取与完成

```bash
bd update <id> --claim
bd close <id> --reason "Done"
```

### 依赖管理

```bash
bd dep add <blocked> <blocker>
bd dep tree <id>
bd dep cycles
```

### 远程同步

```bash
bd dolt remote add origin git@github.com:org/repo.git
bd dolt push
bd dolt pull
```

## 与 GitHub 的关系

Beads 里有两层“GitHub”概念，容易混。

### 1. GitHub 作为代码仓库远程

这一层用的是 Dolt remote。

- 同步的是 `.beads` 数据库和 issue 历史
- 命令是 `bd dolt remote add/push/pull`
- 更像把 beads 数据当成版本化数据仓库来同步

### 2. GitHub Issues 作为外部 issue 平台

这一层用的是 `bd github`。

常见命令：

```bash
bd github status
bd github sync
bd github sync --dry-run
bd github sync --pull-only
bd github sync --push-only
bd github push <bead-id>
bd github pull <github-ref-or-bead-id>
```

行为特点：

- 默认双向同步
- 可以按 issue ID 选择性同步
- 冲突可选择 `--prefer-newer`、`--prefer-local`、`--prefer-github`

必要配置：

```bash
bd config set github.owner owner
bd config set github.repo repo
bd config set github.token <token>
```

也支持环境变量：

- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_REPOSITORY`
- `GITHUB_API_URL`

## 与 agents 的关系

Beads 提供了现成的 agent 集成 recipe，目标是让不同 IDE / agent 都遵循同一套工作流。

### Claude Code

```bash
bd setup claude
```

特征：

- 通过 hooks 注入工作流上下文
- 适合 SessionStart / PreCompact 这类场景
- 重点是让上下文压缩后仍保留 beads 工作方式

### Codex

```bash
bd setup codex
bd setup codex --global
```

特征：

- 写入 AGENTS.md 指南
- 提供 `bd prime` 作为工作流上下文入口
- 适合把 beads 变成团队统一操作规范

### Cursor

```bash
bd setup cursor
```

特征：

- 生成 Cursor 对应的 rules 文件
- 让 Cursor 也按 beads 流程工作

### 其他可用 recipe

`bd setup --list` 里还能看到：

- `aider`
- `gemini`
- `opencode`
- `windsurf`
- `cody`
- `kilocode`
- `mux`
- `factory`

## 推荐工作流

### 给人用

1. `bd ready`
2. 选一个没有 blocker 的任务
3. `bd update <id> --claim`
4. 开发
5. `bd close <id> --reason "..."`
6. `bd dolt push`

### 给 agent 用

1. 启动时读 `bd prime`
2. 运行 `bd ready`
3. 用 `--claim` 原子领取
4. 完成后 `bd close`
5. 会话结束时 `bd dolt push`

## Git hooks

Beads 可以安装 git hooks，把工作流嵌进版本控制事件里。

```bash
bd hooks install
bd hooks install --beads
bd hooks install --shared
bd hooks list
```

hooks 覆盖的事件包括：

- `pre-commit`
- `post-merge`
- `pre-push`
- `post-checkout`
- `prepare-commit-msg`

作用：

- 在 commit / push / merge 时维持工作流一致性
- 为 orchestrator agent 记录身份信息
- 和 beads 状态保持同步

## 配置要点

### 自动导出

默认启用 `export.auto`，会把 issue 导出到 `.beads/issues.jsonl`。

### 自定义状态

可以扩展状态流：

```bash
bd config set status.custom "awaiting_review,awaiting_testing"
```

### GitHub 标签映射

```bash
bd config set github.label_map.bug "bug"
bd config set github.label_map.feature "enhancement"
```

## 实际使用建议

如果你的目标是“让人和多个 agent 一起干活”，我会这样落地：

```bash
bd init --prefix <project>
bd setup codex
bd setup claude
bd setup cursor
bd hooks install --beads
bd dolt remote add origin git@github.com:org/repo.git
bd dolt push
```

如果还要同步 GitHub Issues：

```bash
bd config set github.owner org
bd config set github.repo repo
bd github sync --dry-run
bd github sync
```

## 我这次研究里最重要的判断

1. `bd dolt push/pull` 和 `bd github sync` 是两条不同的同步线，别混用。
2. `bd ready` 是 beads 的心脏，agent 应该优先围绕它工作。
3. `bd setup codex/claude/cursor` 说明 beads 的设计目标就是跨 agent 统一工作流。
4. 这个工具适合有依赖关系、需要多人或多 agent 排队执行的项目，不适合只想记一堆零散 TODO 的场景。

## 参考来源

- 本机 CLI：`bd 1.0.4`
- Context7 文档：`/gastownhall/beads`
- 本机临时 demo 验证：`bd init`、`bd create`、`bd dep add`、`bd ready`、`bd close`
