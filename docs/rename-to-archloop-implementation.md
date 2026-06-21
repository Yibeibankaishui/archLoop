# archLoop Rename Implementation Plan

本文档记录 Sandcastle -> archLoop 的具体实施方法，避免长任务中出现上下文漂移。执行原则：这是一次 identity rename，不引入行为变化，不做双名兼容，不使用 Beads 跟踪本次工作。

## 执行角色

主控 agent 负责最终集成、测试、提交和审计。必要时使用 subagent，但每个 subagent 必须有明确、互不重叠的写入范围，避免大规模冲突。

### 推荐 subagent 数量

使用 5 个 worker subagent + 1 个 audit subagent：

1. Core Runtime Worker
   - 负责核心运行时代码。
   - 文件范围：`src/run.ts`, `src/createWorktree.ts`, `src/WorktreeManager.ts`, `src/projectStatus.ts`, `src/EnvResolver.ts`, `src/hubEnv.ts`, `src/hubAuth.ts`, `src/resolveBdExecutable.ts`, 以及对应测试。
   - 目标：`.archloop/`, `archloop/`, `ARCHLOOP_*`, user data dir `archloop`。

2. CLI and Init Worker
   - 负责 CLI 和 init 生成逻辑。
   - 文件范围：`src/cli.ts`, `src/InitService.ts`, `src/templates.ts`, `src/projectProfiles.ts`, `src/capabilityPacks.ts`, `src/miniprogramScaffold.ts`, 以及对应测试。
   - 目标：`archloop init`, `npm run archloop`, `.archloop/*`, 新 package import。

3. Templates and Capability Worker
   - 负责复制到用户项目里的模板、prompt、capability bundle。
   - 文件范围：`src/templates/**`, `src/capability-bundles/**`, `src/preset-bundles/**`, `src/hub-flows/**`。
   - 目标：生成物中不再出现旧包名、旧 CLI 或旧配置目录。

4. Docs and Skill Worker
   - 负责当前用户文档和 bundled skill。
   - 文件范围：`README.md`, `readme_cn.md`, `user_guide.md`, `docs/content/docs/**`, `docs/product-definition-and-scope.md`, `skills/**`。
   - 目标：当前用户路径全部使用 archLoop，并将 skill 改名为 `archloop-usage`。

5. Release Metadata Worker
   - 负责发布元数据。
   - 文件范围：`package.json`, `package-lock.json`, `.changeset/**`, `docs/package.json`, `docs/package-lock.json`。
   - 目标：包名、scope、repo URL、pending changesets 和 lockfile 都指向 `@yibeibankaishui/archloop`。

6. Audit Worker
   - 只做复核，不做第一轮大改。
   - 范围：全仓库扫描、分类残留旧名、提出必须修复项。
   - 命令：

```bash
rg "Sandcastle|sandcastle|SANDCASTLE|@ai-hero|mattpocock|Yibeibankaishui/sandcastle"
rg "@yibeibankaishui/archloop|archLoop|archloop|ARCHLOOP"
```

## 主控集成规则

- 不让两个 worker 同时修改同一个高冲突文件。
- `package-lock.json` 最后统一生成，避免被多方重复改。
- `.changeset/**` 最后统一处理。
- 不提交 `.beads/**` 或 `.firecrawl/**` 等无关状态。
- 每一批提交前运行最小检查：`git diff --check` 和针对改动范围的旧名扫描。
- 大提交拆分为可回滚的小提交。

## 提交边界

按以下边界分批提交，避免积累过多未提交改动：

1. Documentation Contract
   - `docs/rename-to-archloop.md`
   - `docs/rename-to-archloop-implementation.md`
   - `docs/product-definition-and-scope.md`

2. Core Identity
   - package metadata
   - CLI bin
   - central runtime constants if introduced
   - `.archloop` path and user data dir
   - branch/env prefix

3. Init and Generated Artifacts
   - init scaffolding
   - templates
   - capability bundles
   - generated package scripts/imports

4. Tests
   - update unit tests and snapshots/assertions for new identity.
   - keep test semantics unchanged.

5. User Docs and Skill
   - README, Chinese README, user guide, docs site, bundled skill.

6. Release Metadata and Cleanup
   - changesets
   - lockfiles
   - remaining non-historical old-name cleanup
   - final audit fixes

If a batch gets large or touches unrelated regions, split it further.

## 保持功能不变的方法

### 不改业务逻辑

禁止在本次 rename 中重构以下行为：

- agent execution loop
- sandbox lifecycle
- worktree lifecycle
- Hub task state transitions
- proposal flow apply logic
- Beads projection logic
- merge/recover/doctor semantics
- capability pack behavior
- provider auth behavior

除非测试暴露 rename 相关 breakage，否则不要改算法、状态机或错误处理结构。

### 只允许 identity 变更

每个 diff hunk 都应该能归类到以下之一：

- product display name
- CLI command
- package name
- repo owner/repo URL
- config directory
- user data directory
- env var prefix
- branch/worktree prefix
- generated docs/templates/tests 中的同名断言

如果某个 hunk 不能归类，先暂停并重新判断是否跑偏。

### 测试策略

分层验证：

1. 快速静态检查：

```bash
git diff --check
rg "Sandcastle|sandcastle|SANDCASTLE|@ai-hero|mattpocock|Yibeibankaishui/sandcastle"
```

2. 类型检查：

```bash
npm run typecheck
```

3. 完整测试：

```bash
npm test
```

4. Init 生成物抽查：

重点确认 `archloop init` 相关测试覆盖：

- 生成 `.archloop/`
- 写入 `npm run archloop`
- 安装或声明 `@yibeibankaishui/archloop`
- 模板 import 使用新包名
- capability context 和 auth mount 使用 `.archloop/`

## 旧名残留分类

最终 audit 中如仍存在旧名，只允许以下类别：

- migration note 明确说明旧名 -> 新名。
- 历史 ADR/research 中作为历史事实出现，且不作为当前入口。
- 第三方 issue 链接作为历史出处，且上下文不会误导当前安装或使用路径。

不允许残留：

- 当前 README/install/import 示例。
- CLI help/error/next-step。
- init generated artifacts。
- package metadata。
- bundled skill 触发词。
- runtime path constants。
- tests 的当前期望。

## 完成定义

- 文档合同已提交。
- 代码、模板、测试、文档和发布元数据完成 archLoop rename。
- `npm run typecheck` 通过。
- `npm test` 通过，或明确记录非 rename 引起的外部失败。
- 旧名扫描只剩允许的历史上下文。
- 提交已按边界拆分，未包含无关 `.beads` / `.firecrawl` 状态。
