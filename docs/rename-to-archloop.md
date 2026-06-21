# Rename Plan: Sandcastle to archLoop

本文档是项目从 Sandcastle 全量重命名为 archLoop 的执行契约。当前阶段基本没有外部用户，因此采用破坏性改名：不保留双名兼容，不维护旧 CLI、旧包名、旧配置目录、旧 env var 或旧用户数据目录 fallback。

## 目标

- 建立一个干净的新产品身份：archLoop。
- 移除 Sandcastle、mattpocock、ai-hero 等旧产品和归属标识。
- 让代码、CLI、npm 包、配置目录、用户数据目录、文档和分发 skill 使用同一套新命名。
- 避免长期兼容层拖累早期产品定位和实现。

## 命名映射

| 用途                | 旧值                                                    | 新值                        |
| ------------------- | ------------------------------------------------------- | --------------------------- |
| 产品展示名          | Sandcastle                                              | archLoop                    |
| npm 包名            | `@ai-hero/sandcastle`                                   | `@yibeibankaishui/archloop` |
| CLI 命令            | `sandcastle`                                            | `archloop`                  |
| GitHub owner/repo   | `mattpocock/sandcastle` 或 `Yibeibankaishui/sandcastle` | `yibeibankaishui/archloop`  |
| repo-local 配置目录 | `.sandcastle/`                                          | `.archloop/`                |
| 用户数据目录        | `sandcastle`                                            | `archloop`                  |
| env var 前缀        | `SANDCASTLE_`                                           | `ARCHLOOP_`                 |
| 分支前缀            | `sandcastle/`                                           | `archloop/`                 |
| worktree 目录名前缀 | `sandcastle-`                                           | `archloop-`                 |
| npm script          | `sandcastle`                                            | `archloop`                  |
| bundled skill       | `sandcastle-usage`                                      | `archloop-usage`            |

`archLoop` 只用于产品展示文案。包名、CLI、目录、分支、env var 和代码常量分别使用 lowercase 或 uppercase 形式：`archloop` / `ARCHLOOP`.

## 非目标

- 不保留 `sandcastle` CLI alias。
- 不 fallback 读取 `.sandcastle/`。
- 不 fallback 读取 `~/.local/share/sandcastle`。
- 不 fallback 读取 `SANDCASTLE_*` 环境变量。
- 不继续在新生成项目中写入 `sandcastle` npm script。
- 不维护 `@ai-hero/sandcastle` 的运行时兼容 import。

## 破坏性影响

现有 init 过的项目需要手动迁移：

- `.sandcastle/` 需要改名为 `.archloop/`。
- `package.json#scripts.sandcastle` 需要改成 `scripts.archloop`。
- 依赖需要从 `@ai-hero/sandcastle` 改成 `@yibeibankaishui/archloop`。
- 模板和用户代码中的 import 需要改成新包名。
- `SANDCASTLE_BD_PATH` 等环境变量需要改成 `ARCHLOOP_BD_PATH`。
- Hub 本地状态如果要保留，需要从旧用户数据目录手动移动到新目录。
- 旧的 `sandcastle/...` 分支和 `.sandcastle/worktrees/` 不会被新版本自动识别或清理。

这是有意的：当前用户规模允许一次性切干净，避免新产品长期背负旧命名。

## 代码改动范围

### Package and Distribution

- 更新 root `package.json`：
  - `name` 改为 `@yibeibankaishui/archloop`。
  - `bin` 改为 `{ "archloop": "dist/main.js" }`。
  - `repository.url` 改为 `https://github.com/yibeibankaishui/archloop`。
  - 自引用 devDependency 改为 `@yibeibankaishui/archloop`。
  - scripts 中的 `.sandcastle/*` 和 `sandcastle` 改为 `.archloop/*` 和 `archloop`。
- 更新 `package-lock.json`。
- 更新所有 template import：
  - `@ai-hero/sandcastle` -> `@yibeibankaishui/archloop`
  - `@ai-hero/sandcastle/sandboxes/*` -> `@yibeibankaishui/archloop/sandboxes/*`

### CLI and User-Facing Text

- 所有用户可见命令改为 `archloop ...`。
- CLI help、错误文案、next steps、doctor/recover 提示改用 archLoop。
- `CONFIG_DIR` 从 `.sandcastle` 改为 `.archloop`。
- 缺少配置目录时提示 `No .archloop/ found. Run \`archloop init\` first.`

### Runtime Paths

- repo-local 目录：
  - `.sandcastle/.env` -> `.archloop/.env`
  - `.sandcastle/logs` -> `.archloop/logs`
  - `.sandcastle/patches` -> `.archloop/patches`
  - `.sandcastle/worktrees` -> `.archloop/worktrees`
  - `.sandcastle/auth/*` -> `.archloop/auth/*`
  - `.sandcastle/context/*` -> `.archloop/context/*`
  - `.sandcastle/agents` -> `.archloop/agents`
  - `.sandcastle/skills` -> `.archloop/skills`
- user data directory:
  - `~/.local/share/sandcastle` -> `~/.local/share/archloop`
  - XDG data home 下同样使用 `archloop` 子目录。

### Branches and Worktrees

- 临时分支：
  - `sandcastle/<timestamp>` -> `archloop/<timestamp>`
  - `sandcastle/<name>/<timestamp>` -> `archloop/<name>/<timestamp>`
- managed worktree 目录名：
  - `sandcastle-<timestamp>` -> `archloop-<timestamp>`
  - `sandcastle-<name>-<timestamp>` -> `archloop-<name>-<timestamp>`

### Env Vars

- `SANDCASTLE_BD_PATH` -> `ARCHLOOP_BD_PATH`
- 文档、测试、错误提示和 env key guidance 同步更新。
- 不支持旧 env var fallback。

### Init Scaffolding

- `archloop init` 生成 `.archloop/`。
- 生成的 `package.json`：
  - script 为 `"archloop": "tsx .archloop/main.mts"`。
  - devDependency 为 `@yibeibankaishui/archloop`。
- generated next steps 使用 `npm run archloop`。
- capability packs、project profiles、preset agents、auth mounts 和 bootstrap guidance 全部使用 `.archloop/`。

### Bundled Skill

- `skills/sandcastle-usage/SKILL.md` 改名为 `skills/archloop-usage/SKILL.md`。
- YAML frontmatter 更新：
  - `name: archloop-usage`
  - description 使用 archLoop、`@yibeibankaishui/archloop`、`archloop init`、`.archloop/` 等触发词。
- 内容同步 README、中文 README、user guide 和实际 CLI 行为。

## 文档改动范围

必须更新：

- `README.md`
- `readme_cn.md`
- `user_guide.md`
- `docs/product-definition-and-scope.md`
- `docs/content/docs/**`
- `docs/prd/**`
- `docs/roadmap.md`
- `docs/agents/**` 中当前使用路径、包名或 repo owner 的部分
- `skills/archloop-usage/SKILL.md`

历史 ADR、research 和旧 changeset 可以分级处理：

- 当前安装、使用、发布路径必须全部改成 archLoop。
- 历史记录中作为事实背景出现的 Sandcastle 可以保留，但应避免继续指向 `mattpocock/sandcastle` 或 `@ai-hero/sandcastle` 作为当前项目入口。
- 如果保留历史名，建议使用 “formerly Sandcastle” 这类明确措辞。

## Changeset 策略

当前 `.changeset/*` 中大量包名仍是 `@ai-hero/sandcastle`。改包名后需要选择一种策略：

1. 简单方案：批量把 pending changeset package name 改成 `@yibeibankaishui/archloop`。
2. 干净方案：在重命名前发布或清理 pending changesets，再新增一个 rename changeset。

推荐简单方案。当前项目仍处于早期，批量改 changeset 包名成本低，也能避免 release tool 找不到新包名。

新增 rename changeset：

```md
---
"@yibeibankaishui/archloop": patch
---

Rename the project from Sandcastle to archLoop, including the package name, CLI command, local config directory, user data directory, environment variable prefix, generated scaffolds, templates, docs, and bundled usage skill.
```

## 手动迁移说明

如果内部项目需要保留旧配置，可手动执行：

```bash
mv .sandcastle .archloop
```

更新 `package.json`：

```json
{
  "scripts": {
    "archloop": "tsx .archloop/main.mts"
  },
  "devDependencies": {
    "@yibeibankaishui/archloop": "^<version>"
  }
}
```

更新 imports：

```ts
import { run, claudeCode } from "@yibeibankaishui/archloop";
import { docker } from "@yibeibankaishui/archloop/sandboxes/docker";
```

如需保留 Hub 本地状态：

```bash
mv ~/.local/share/sandcastle ~/.local/share/archloop
```

如需保留 Beads executable override：

```bash
export ARCHLOOP_BD_PATH="$SANDCASTLE_BD_PATH"
```

## 实施顺序

1. 创建 rename 分支：`codex/rename-archloop`。
2. 更新 `package.json`、`package-lock.json`、CLI bin 和 package metadata。
3. 集中更新核心命名常量：产品名、CLI 名、包名、配置目录、用户数据目录、env 前缀、分支前缀。
4. 替换 `.sandcastle/` 为 `.archloop/`。
5. 替换 `@ai-hero/sandcastle` 为 `@yibeibankaishui/archloop`。
6. 替换用户可见 `sandcastle` 命令为 `archloop`。
7. 替换 `SANDCASTLE_*` 为 `ARCHLOOP_*`。
8. 更新 templates、init scaffold、capability packs、Hub flows 和 bundled skill。
9. 更新 README、中文 README、user guide、docs site、roadmap 和 product definition。
10. 更新 tests。
11. 批量处理 pending changesets。
12. 运行质量门：

```bash
npm run typecheck
npm test
```

13. 完成 GitHub repo rename 与 npm 发布准备。

## 验收标准

- `rg "Sandcastle|sandcastle|SANDCASTLE|@ai-hero|mattpocock"` 只剩历史上下文或明确标注为 formerly 的迁移说明。
- 新 init 只生成 `.archloop/`。
- CLI 只暴露 `archloop`。
- package import 示例只使用 `@yibeibankaishui/archloop`。
- Hub 用户数据目录只使用 `archloop`。
- 临时分支只使用 `archloop/`。
- `npm run typecheck` 通过。
- `npm test` 通过。
