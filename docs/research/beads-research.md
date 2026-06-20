# Beads 研究整理

整理对象：`beads` / `bd`
研究时间：2026-06-14；2026-06-20 追加 Sandcastle Hub 集成验证
结论版本：基于本机安装的 `bd 1.0.4` CLI 帮助、Context7 上的 `/gastownhall/beads` 文档，以及 Sandcastle Hub QA 中的真实命令行为。

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

当前 `bd show` 支持的详情参数：

```bash
bd show <id> --json --long
bd show <id> --json --long --thread --refs
```

注意：`bd 1.0.4` 不支持早期误用过的 `--include-comments`、`--include-dependents`。评论应使用：

```bash
bd comments <id> --json
bd comments add <id> "comment body"
```

列表相关的实用语义：

```bash
bd list --json --all --limit 0
bd list --json --ready
bd ready --json
```

- `bd list` 默认有 limit，完整投影任务表时要显式 `--limit 0`。
- `bd list --all` 会包含 closed tasks。
- `bd ready` / `bd list --ready` 使用 blocker-aware ready-work 语义，只返回真正可开始的 open issue，排除 `in_progress`、`blocked`、`deferred` 等。

### 领取与完成

```bash
bd update <id> --claim
bd close <id> --reason "Done"
```

### 更新 labels、metadata、status

2026-06-20 再次核对 `bd 1.0.4` 和官方 CLI reference 后，以下语义对 Sandcastle 集成尤其重要：

```bash
bd update <id> --status in_progress
bd update <id> --add-label waiting-for-merge
bd update <id> --remove-label implementing
bd update <id> --set-labels waiting-for-merge
bd update <id> --metadata '{"hubStatus":"waiting_for_merge"}'
bd update <id> --set-metadata team=platform
bd update <id> --unset-metadata failureReason
```

- `--add-label` / `--remove-label` 是增量更新，可重复。
- `--set-labels` 会替换全部 labels，可重复；如果上层系统只想替换自己管理的状态 label，必须先读出现有 labels，保留用户自定义 labels，再 set 回去。
- `--metadata` 设置 custom metadata，适合写入一整包 JSON。
- `--set-metadata key=value` / `--unset-metadata key` 是字段级 metadata 操作，更适合清理 `failureReason`、`failed`、`done` 这类状态字段。
- `--claim` 是领取任务的原子操作，会把任务设为 `in_progress` 并设置 assignee。
- Beads 的 stored status 仍是 `open`、`in_progress`、`blocked`、`deferred`、`closed` 这一级；Sandcastle 的 `ready_for_agent`、`reviewing`、`waiting_for_merge` 等更细状态需要通过 labels/metadata 在 Beads 上投影。

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

Sandcastle QA 中观察到：即使执行 `bd --readonly show ...`，Beads 也可能因为 auto-export 尝试执行 `git add`，在 Codex sandbox 里表现为 `.git/index.lock` 权限错误噪音。对上层 CLI 来说，这意味着：

- 只读读取最好统一加 `--readonly`，并评估是否需要 `--sandbox`。
- Sandcastle 不应让 `tasks list/show` 这类只读命令因为 auto-export 的 git 副作用而吓到用户。
- 如果继续把 Beads 作为内部模块，Sandcastle 应该在错误包装里区分“真实读取失败”和“auto-export/git add 噪音”。

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

## 2026-06-20 Sandcastle Hub QA 结论

这轮 QA 暴露的问题不是 Beads 本身的任务模型不适合，而是 Sandcastle 把更细的 Hub 状态投影到 Beads 时，写入策略不够严格。

### 事故现象

`sandcastle run . --flow with-review` 中，一批 task 实现和 review 完成后，merge 阶段只选中了部分任务。排查发现：

- 有些 task 的 labels 同时残留 `implementing`、`reviewing`、`waiting-for-merge`。
- 有些 task 的 metadata 中 `hubStatus` 回退到 `ready_for_agent`。
- 有些 task 在 review 成功后丢失 `claim.batchId`，导致 batch merge selector 无法确认它属于当前 batch。
- `selectHubBatchMergeTasks` 只选择 `hubStatus === "waiting_for_merge"` 且 `claim.batchId` 匹配的 task，所以状态污染会直接导致任务被跳过。

临时修复是把已 review 且 branch 有未合并提交的 task 手工校正为：

```json
{
  "hubStatus": "waiting_for_merge",
  "claim": {
    "runId": "...",
    "batchId": "...",
    "branch": "...",
    "claimedAt": "..."
  }
}
```

同时把 labels 替换成单一 `waiting-for-merge`。之后重新运行 flow，Hub 进入 `resumed_batch`，只执行 merge phase，最终这些任务转为 `done`。

另一个任务 `sandcastle-3n0` 仍保持 failed，原因不同：它的 implement agent 因 Cursor provider `socket hang up` 失败，commit count 为 0，分支没有任何未合并 work。这类任务应通过 `sandcastle tasks recover <id>` 回到 `ready_for_agent` 后重新运行，而不能直接推进到 merge。

### 对 Sandcastle 集成的设计约束

1. **Hub 状态写入必须有唯一入口。** 所有状态变化都应通过类似 `transitionHubTaskStatus()` 的函数，统一 Beads lifecycle status、Hub status label、metadata。
2. **状态 labels 要 canonical replace。** Sandcastle 只应保留一个自己管理的状态 label。实现时先读当前 labels，保留用户自定义 labels，去掉所有 Sandcastle 状态 labels，再用 `bd update --set-labels` 写回。`blocked`、`failed`、`done`、`wontfix` 等通用词如果作为 Sandcastle 状态 label 使用，就必须在文档中声明为保留 label；否则投影层应以 `metadata.hubStatus` 为准，labels 只作为显示/兼容 fallback。
3. **metadata 写入要有明确语义。** 简单标量字段优先使用 `--set-metadata` / `--unset-metadata`；复杂 JSON 对象如 `claim`、`remote_refs`、数组值必须先用真实 `bd 1.0.4` 验证类型保持。如果 `--set-metadata claim=...` 会把对象存成字符串，就应改为 fresh read-modify-write 后用 `--metadata` 写整包。写完必须重新读取验证。
4. **execution 状态必须保留 claim。** `implementing`、`reviewing`、`waiting_for_merge`、`merging` 都应有 `claim.runId`、`claim.batchId`、`claim.branch`。
5. **不能用旧 metadata 快照推进生命周期。** review success 前应重新读取最新 task，或沿用 implementation success 返回的 updated task metadata，避免把旧的 `ready_for_agent` 或缺失 claim 写回去。更稳的 API 是让 transition 只接收 patch/intent，由 transition 内部 fresh load 当前 task 后合成最终状态。
6. **transition 尽量单次 `bd update` 完成。** `--status`、`--set-labels`、metadata set/unset 或整包 `--metadata` 应组合到一次写命令中，避免多条命令中途失败留下半更新状态。
7. **transition 后要强验证。** 写入后立即重新 `bd show --json --long`，验证 projected Hub status、状态 label 数量、claim、failure metadata、done/wontfix 等不变量。
8. **merge selector 应诊断状态不一致。** 如果 event log 有 `task_review_succeeded`、branch 有 unmerged work，但 Beads projection 不是 `waiting_for_merge`，应输出 `state_inconsistent`，而不是静默跳过。默认不应自动修复；真正写状态应放在显式 `tasks repair-state --yes` 或 `tasks recover` 中。自动修复如果存在，也必须 opt-in，并要求最新事件、branch work、batch/claim 可恢复等条件全部满足。
9. **recover 要复用同一套 canonical transition。** 从 failed/stale execution 恢复时，要清理残留状态 labels 和 stale metadata，而不是新增另一套状态写入逻辑。failed 且 branch 有 unmerged work 时保留 claim；回到 ready/human/blocked 时清 claim；done/wontfix 必须清 claim。
10. **GitHub sync 边界要写死。** `implementing`、`reviewing`、`waiting_for_merge`、`merging`、`failed` 等 execution statuses 是本地执行态，不应作为 GitHub Issues 协作状态推送。canonical labels 不能破坏远端协作标签映射，也不能误删本地自定义 labels。
11. **需要真实 Beads 集成测试。** Mock Beads 没抓住这次问题。至少要用真实 `bd 1.0.4` 覆盖 labels replacement、metadata 清理、claim 保留、review success 到 merge selection、failed recovery。
12. **对外隐藏 Beads，内部尊重 Beads。** 用户命令应继续是 `sandcastle tasks ...`；Sandcastle 内部可以使用 `bd`，但要把 Beads 的副作用、错误信息、版本差异包装成 Sandcastle 语义。

### 建议落地顺序

1. 先做真实 `bd 1.0.4` characterization tests：`--set-labels`、JSON/数组 metadata、`--unset-metadata`、只读参数、auto-export 副作用。
2. 提取纯函数：Sandcastle 管理 label 集合、canonical label 计算、metadata patch/clear 规则、transition 后验证规则。
3. 引入 `transitionHubTaskStatus()`，让现有 `updateHubTaskStatus()` 走它，并保持外部 API 基本不变。
4. 修 review success stale metadata：transition 内 fresh load 当前 task，显式保留 claim/batch/branch。
5. 迁移 recover、merge enter/revert/failure/close、sync conflict 到同一 transition。
6. 增强 merge selector 的 `state_inconsistent` 诊断，默认只诊断不写状态。
7. 最后增加 `sandcastle tasks doctor` / `sandcastle tasks repair-state`，再更新 README、skill、changeset。

## 参考来源

- 本机 CLI：`bd 1.0.4`
- Context7 文档：`/gastownhall/beads`
- 本机临时 demo 验证：`bd init`、`bd create`、`bd dep add`、`bd ready`、`bd close`
- Sandcastle Hub QA 验证：`bd update --set-labels`、`bd show --long --thread --refs`、`bd comments`、`sandcastle run . --flow with-review` resumed batch merge
