# Roadmap

本 roadmap 以代码与 git 提交为准，用于把 archLoop 的阶段性方向、当前进度和后续 PRD 对齐。飞书云文档采用固定映射双向协作；当本地与云端内容冲突时，先人工审阅，再用同步流程覆盖目标文档。

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontFamily":"Inter, ui-sans-serif, system-ui, sans-serif","primaryBorderColor":"#334155","lineColor":"#64748b","tertiaryColor":"#f8fafc"}} }%%
flowchart LR
    P00["00 基线能力<br/>Done<br/>核心编排 / Sandbox / Init"] --> P01["01 多 Agent Provider 与 Runtime<br/>Active<br/>Cursor / Codex / Claude Code / Pure API"]
    P01 --> P02["02 多技术栈项目支持<br/>Active<br/>Bootstrap Contract / 项目类型 / No-Sandbox 边界"]
    P02 --> P03["03 Capability Packs 与专业化开发闭环<br/>Done<br/>能力包 / 小程序 / 验证闭环"]
    P03 --> P04["04 Docker 环境与容器接入<br/>Planned<br/>Custom Dockerfile / Existing Container"]
    P04 --> P05["05 文档与用户体验<br/>Planned<br/>README / Init Next Steps / 用户指南"]
    P05 --> P06["06 archLoop Hub 与 GUI<br/>Planned<br/>任务表 / Flow / 配置管理 / 可视化"]

    P01 -. "能力沉淀" .-> P04
    P02 -. "使用边界" .-> P05
    P03 -. "能力模型" .-> P05
    P01 -. "运行数据" .-> P06
    P04 -. "环境模型" .-> P05
    P04 -. "运行模型" .-> P06

    classDef done fill:#d1fae5,stroke:#059669,color:#064e3b,stroke-width:2px;
    classDef active fill:#fef3c7,stroke:#f59e0b,color:#78350f,stroke-width:2px;
    classDef planned fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px;
    classDef future fill:#f3e8ff,stroke:#9333ea,color:#581c87,stroke-width:2px;
    classDef support fill:#ffe4e6,stroke:#e11d48,color:#881337,stroke-width:2px;

    class P00 done;
    class P01,P02 active;
    class P03 done;
    class P04,P05 planned;
    class P06 future;
```

## 00 基线能力

Status: Done

Version: `ecd26a877af1f33827e95b7c5d49bdabdd48a4b7`

Goal: 记录该提交及之前已经稳定存在的 archLoop 核心编排、sandbox、agent provider、init 和模板能力。

### Scope

- 程序化 `run()` API、multi-iteration execution、completion signal、commit collection、log-to-file mode、terminal mode 和 agent stream event callback。
- 可插拔 sandbox provider 抽象，包括 bind-mount、isolated、no-sandbox，以及 Docker、Podman、Vercel、Daytona 和 no-sandbox provider。
- Branch strategy 与 worktree model，包括 `head`、`merge-to-head`、显式 `branch`、`.archloop/worktrees/`、`createWorktree()` 和 `createSandbox()`。
- Prompt 与 output model，包括 inline prompt、prompt template、argument substitution、sandbox shell expression expansion、`Output.object()` 和 `Output.string()`。
- Claude Code、Codex、Pi、OpenCode agent provider，以及 provider-specific command construction、stream parsing、Claude Code session capture、resume 和 usage parsing。
- Host lifecycle hooks、sandbox lifecycle hooks、`.archloop/.env`、provider env merge、`copyToWorktree`、timeout 配置和 `AbortSignal` 取消流程。
- `archloop init` 的 `.archloop/` scaffold、模板选择、Dockerfile / Containerfile 生成、GitHub Issues / Beads backlog manager、GitHub `archLoop` label、内置 workflow 模板，以及 Docker / Podman image 命令。

### Deliverables

- README 覆盖 baseline public API 和 CLI 基础用法。
- ADR 与 `CONTEXT.md` 记录 baseline 架构决策、术语和领域语言。
- 后续阶段不再把本节能力作为未来待实现事项，只描述增强、重构或体验改进。

### Out of Scope

- Fork 之后新增的 Cursor provider、多 runtime init、preset agent roles、bootstrap contract、GUI 和后续文档体验优化。

## 01 多 Agent Provider 与 Runtime

Status: Active

Goal: 让 archLoop 可以在同一项目中组合 Cursor、Codex、Claude Code 等 agent provider 与 installed runtimes。

### Scope

- Cursor agent provider 与多 provider 组合工作流。
- `archloop init` 中 default scaffold agent 与 installed runtimes 的分离。
- 多 runtime Dockerfile / Containerfile 组合。
- Codex、Cursor、GitHub Issues 等运行时认证 setup flow。
- Preset agent roles 与 provider/runtime 能力矩阵。
- Pure API 模式的目标形态、边界和集成方式探索。

### Deliverables

- `archloop init` 能生成以一个默认 scaffold agent 为入口、同时安装多个可用 runtime 的项目配置。
- Runtime image composition 与 auth setup flow 能支持 Cursor、Codex、Claude Code 等组合使用。
- Provider/runtime 的认证、session、stream、resume 和限制在文档中可被清晰比较。
- Pure API 模式有明确 PRD 或设计文档承接，不与 CLI init 行为混杂。

### Tasks

- [x] 增加 Cursor agent provider。
- [x] 区分 default scaffold agent 与 installed runtimes。
- [x] 支持多 runtime Dockerfile / Containerfile composition。
- [x] 增加 Codex、Cursor、GitHub Issues 相关 auth setup flow。
- [x] 完成 preset agent roles 初版。
- [ ] 明确 pure API 模式的目标形态与边界。
- [ ] 梳理 provider/runtime capability matrix。
- [ ] 补齐多 agent provider 组合示例和用户文档。

相关文档：[multi-agent-runtimes-init](./prd/multi-agent-runtimes-init.md)、[preset-agent-roles](./prd/preset-agent-roles.md)。

## 02 多技术栈项目支持

Status: Active

Goal: 让 archLoop 不再默认假设 Node 项目，而是通过项目级 bootstrap contract 支持不同语言、框架和构建系统。

### Scope

- `.archloop/bootstrap.sh` 作为 repository-specific bootstrap contract。
- `archloop init` 按 Project profile 生成 bootstrap script，模板在 sandbox 就绪时执行。
- `archloop init` 的 sandbox 入口收敛为 `docker` 与 `no-sandbox`，并把 `podman` 保留为非 init 路径下的可用能力。
- `archloop init` 生成的入口文件需要和 sandbox 选择保持一致，并在 no-sandbox 组合下校验必要的 host 依赖。
- 模板不再默认假设 `node_modules`、`npm install` 或 Node-only workflow。
- `archloop init` 根据项目类型生成更贴近目标项目的 Dockerfile / Containerfile 基础配置。
- 常见项目类型的 sandbox 环境建议，包括 Node、Python、C++ 等技术栈。
- Unsandboxed / no-sandbox 模式的安全边界、适用场景和用户提示。

### Deliverables

- 非 blank 模板依赖项目内 bootstrap contract，而不是内嵌某一技术栈的安装命令。
- 常见技术栈有可复用 bootstrap 示例，用户可以快速迁移到自己的项目。
- `archloop init` 能让用户选择项目类型，并生成包含相应语言运行时、包管理器和验证工具的 sandbox 环境骨架。
- `archloop init` 的交互和 scripted 参数与当前策略一致：支持 `docker` 与 `no-sandbox`，不再把 `podman` 作为 init 选项暴露。
- `archloop init` 选择 `no-sandbox` 时，生成的 `main.mts` / `main.ts` 会显式使用 `noSandbox()`，并对 `beads` 等 host 依赖给出校验与提示。
- Docker image、mount、auth 和 no-sandbox 行为在跨技术栈项目中有一致说明。

### Tasks

- [x] 非 blank 模板引入 `.archloop/bootstrap.sh`。
- [x] 完成 Project profile / bootstrap contract 设计收敛，并同步到 `CONTEXT.md`、ADR 和 roadmap（见 [project-profiles-init-bootstrap](./prd/project-profiles-init-bootstrap.md)、[ADR-0015](./adr/0015-project-profiles-generate-bootstrap-at-init-time.md)）。
- [x] 模板移除对 `node_modules` 或 `npm install` 的默认假设。
- [x] 完成 `archloop init` 项目类型选择的产品/交互设计，包括 scripted init 参数和交互式选择（见 [#20](https://github.com/yibeibankaishui/archloop/issues/20)）。
- [x] 完成 Node、Python、C++ Project profiles 的实现拆分与 issue 准备（见 [#23](https://github.com/yibeibankaishui/archloop/issues/23)、[#24](https://github.com/yibeibankaishui/archloop/issues/24)、[#25](https://github.com/yibeibankaishui/archloop/issues/25)）。
- [x] 明确通用 Docker 镜像与 Project profile 的边界，并确认 bootstrap 不参与 image build、不由 init 验证（见 [ADR-0015](./adr/0015-project-profiles-generate-bootstrap-at-init-time.md)）。
- [x] Project profile 影响生成 prompt 中的默认验证命令提示（见 [#75](https://github.com/yibeibankaishui/archloop/issues/75)）。
- [x] 调整 `archloop init` 的 sandbox 选项：新增 `no-sandbox`，隐藏 `podman`（保留 podman 命令与运行时代码）。
- [x] 修复 `archloop init` 的 scaffold 入口与 sandbox 选择脱节的问题，并为 `no-sandbox + beads` 增加 `bd` host 依赖校验与提示。
- [ ] 实现 `generic` Project profile 与 `--project-profile` 基础路径（见 [#21](https://github.com/yibeibankaishui/archloop/issues/21)）。
- [ ] 实现模板侧 runtime bootstrap generation 移除（见 [#22](https://github.com/yibeibankaishui/archloop/issues/22)）。
- [ ] 实现 Node、Python、C++ Project profiles（见 [#23](https://github.com/yibeibankaishui/archloop/issues/23)、[#24](https://github.com/yibeibankaishui/archloop/issues/24)、[#25](https://github.com/yibeibankaishui/archloop/issues/25)）。
- [ ] 为常见技术栈沉淀 bootstrap 示例。
- [x] 梳理并落地 `noSandbox()` 在 `run()` / `createSandbox()` 中的使用边界与适用场景。
- [ ] 修复 init 生成的 auth mount 目录缺失导致 sandbox 启动前失败的问题（见 [#19](https://github.com/yibeibankaishui/archloop/issues/19)）。

相关文档：[project-profiles-init-bootstrap](./prd/project-profiles-init-bootstrap.md)、[ADR-0015](./adr/0015-project-profiles-generate-bootstrap-at-init-time.md)、[bootstrap-template-contract](../.changeset/bootstrap-template-contract.md)。

## 03 Capability Packs 与专业化开发闭环

Status: Done

Version: `f9e432fd88279e25169555bbb3d7d1e846304e0c`

Target: [capability-packs](./prd/capability-packs.md)

Goal: 让 `archloop init` 可以显式选择专业化能力包，生成包含工具上下文、agent 规则和验证入口的开发闭环。

### Scope

- Capability pack 作为显式 init-time 选择，组合 template、Project profile、preset agents、skills、context files、verification entrypoint 和 capability add-ons。
- Capability pack 默认值与显式 init flags 的优先级规则。
- 小程序能力包默认使用 `parallel-planner-with-review`，并支持 `parallel-planner`、`parallel-planner-with-review`、`sequential-reviewer`、`simple-loop` 等模板。
- Init-time prompt assembly，把 preset role、skill、capability context、verification guidance 和选中的 add-on guidance 生成到可编辑 prompt template。
- `.archloop/capability.json` capability manifest。
- `.archloop/verify.sh` verification entrypoint。
- `generic` 与 `miniprogram` 两个第一版 capability packs，其中小程序第一版只支持 native capability variant。
- WeChat Mini Program core loop：`.archloop/verify.sh`、`npm run wx:check`、`miniprogram-ci preview`（检测到配置时自动调用）、`debug/wx-check.log`。
- `.archloop/wx-check-native.mjs` native fallback verifier，用于没有项目级 `wx:check` 时的原生小程序结构检查。
- 小程序 init-time project setup：检测 `miniprogram-ci`，缺失时让用户选择是否安装到项目中。
- no-sandbox-only Mini Program capability add-on：`runtime-debug`（WeChat DevTools MCP）。

### Deliverables

- `archloop init --capability miniprogram` 可以生成专业化的小程序 agent 环境。
- 小程序第一版能力包可以在原生微信小程序项目中提供默认 verifier；Taro、uni-app 等跨端框架会被明确标记为 unsupported variant。
- 小程序默认 verifier 在未配置 `miniprogram-ci` 时继续本地闭环；检测到上传密钥等平台验证配置时必须调用 `miniprogram-ci preview`，配置错误则失败并写入诊断。
- 小程序 init 会检测 `miniprogram-ci` 并在缺失时提供显式项目安装选择；用户拒绝安装时 init 仍可完成并给出后续配置指引。
- 小程序 init 会生成 `.archloop/context/miniprogram-setup.md`，记录检测结果、后续配置步骤和上传密钥安全提醒。
- 小程序能力包在 Docker / no-sandbox 下都有稳定的 CLI 主验证闭环。
- 小程序能力包在支持模板中保持同一套 verification contract；显式选择 `blank` 时给出手动接入验证入口的 warning。
- no-sandbox 下可选择 runtime-debug add-on，生成对应上下文和 prompt guidance，但不自动安装、登录或启动 WeChat Developer Tools。
- 生成的 prompt templates 能确定性携带小程序 skill、context、verification guidance 和 add-on guidance。
- Capability pack registry、add-on compatibility、manifest 和 scaffold 输出有测试覆盖。
- README / 用户文档能说明 Project profile、template、preset agent、skill、capability pack、capability add-on 的区别。

### Tasks

- [x] 记录 capability pack 领域术语与设计取舍到 `CONTEXT.md` 和 [ADR-0016](./adr/0016-capability-packs-compose-specialized-init-scaffolds.md)。
- [x] 创建 capability packs PRD：[capability-packs](./prd/capability-packs.md)，并发布为 [#39](https://github.com/yibeibankaishui/archloop/issues/39)。
- [x] 实现 capability pack registry 与 `generic` / `miniprogram` 定义（[#40](https://github.com/yibeibankaishui/archloop/issues/40)）。
- [x] 实现小程序 native capability variant 与 `.archloop/wx-check-native.mjs` fallback verifier，包括检测到 `miniprogram-ci` 配置时自动执行 `preview`（[#44](https://github.com/yibeibankaishui/archloop/issues/44)、[#46](https://github.com/yibeibankaishui/archloop/issues/46)）。
- [x] 实现小程序 init-time `miniprogram-ci` 检测、可选项目安装和缺失时 next-step guidance（[#45](https://github.com/yibeibankaishui/archloop/issues/45)）。
- [x] 扩展 `archloop init`，支持 `--capability` 与交互式 capability pack 选择（[#40](https://github.com/yibeibankaishui/archloop/issues/40)）。
- [x] 实现 capability defaults 与显式 init flags 的覆盖规则（[#40](https://github.com/yibeibankaishui/archloop/issues/40)）。
- [x] 实现 Mini Program core scaffold，包括 capability manifest、verification entrypoint、context files 和 prompt assembly（[#42](https://github.com/yibeibankaishui/archloop/issues/42)、[#41](https://github.com/yibeibankaishui/archloop/issues/41)）。
- [x] 生成 `.archloop/context/miniprogram-setup.md`，并在 assembled Mini Program prompts 中引用（[#42](https://github.com/yibeibankaishui/archloop/issues/42)）。
- [x] 实现 no-sandbox-only `runtime-debug` capability add-on（[#47](https://github.com/yibeibankaishui/archloop/issues/47)）。
- [x] 扩充 Mini Program preset agent 和 bundled skill，使其遵守 CLI 验证闭环（[#41](https://github.com/yibeibankaishui/archloop/issues/41)、[#43](https://github.com/yibeibankaishui/archloop/issues/43)）。
- [x] 为 capability registry、add-on compatibility、manifest、prompt assembly 和 init scaffold 增加测试（[#40](https://github.com/yibeibankaishui/archloop/issues/40)–[#47](https://github.com/yibeibankaishui/archloop/issues/47)）。
- [x] 更新 README / 用户指南，并按需补充 changeset（[#48](https://github.com/yibeibankaishui/archloop/issues/48)）。

### Out of Scope

- 第一版不实现 web 或 game capability packs。
- 第一版不支持 Taro、uni-app、mpvue 等非原生小程序 variant。
- 第一版不自动推断 capability pack。
- 第一版不新增 `run({ agentProfile })` public runtime API。
- 第一版不静默修改 host repo application files；用户显式同意的 setup action 可以安装 `miniprogram-ci` 到项目中。
- 第一版不自动安装 `wechat-devtools-mcp`、不启动或登录 WeChat Developer Tools。
- 第一版不实现 CloudBase capability add-on。

## 04 Docker 环境与容器接入

Status: Planned

Goal: 让高级用户可以清晰地复用自定义 Dockerfile、现有 image 或受控容器，同时保持 archLoop 对 sandbox 生命周期、worktree 和权限边界的可解释性。

### Scope

- 将现有 `archloop docker build-image --dockerfile` / `podman build-image --containerfile` 能力梳理成完整的用户路径。
- 支持用户在 init 或入口脚本中选择自定义 Dockerfile / Containerfile，并将其与 image name、build context、UID/GID build args 和 runtime mounts 对齐。
- 探索接入已经创建好的 Docker 容器作为高级 sandbox provider 的可行性。
- 明确外部容器模式的生命周期所有权、worktree 挂载契约、环境变量注入、网络、清理责任和错误提示。

### Deliverables

- 用户可以选择自定义 Dockerfile / Containerfile 作为 sandbox image 来源，并通过文档理解何时需要重新 build。
- 自定义 image 与 archLoop 的 `docker()` / `podman()` provider 配置关系被清楚记录。
- 已有容器接入有明确设计结论：若采用，需要形成独立 provider 或显式 experimental API；若不采用，需要记录替代方案。
- Docker 环境能力矩阵说明哪些能力来自 image、哪些来自 runtime mount、哪些来自 hooks。

### Tasks

- [ ] 梳理当前 `build-image --dockerfile` / `--containerfile` 已有能力与缺口。
- [ ] 设计 init 层面的自定义 Dockerfile / Containerfile 输入路径。
- [ ] 设计 JS API 层的自定义 image / build artifact 使用方式。
- [ ] 评估 existing container provider 的安全边界和 lifecycle contract。
- [ ] 为 Docker image、container、mount、hook 和 `.archloop/.env` 的职责边界补充用户文档。

### Out of Scope

- 不把已有容器接入作为默认 AFK 路径。
- 不把 no-sandbox provider 作为默认 AFK 路径；仅保留显式 opt-in 的 host 执行模式。
- 不在本阶段内提供完整 Docker Compose 编排。

## 05 文档与用户体验

Status: Planned

Goal: 让用户能从 README、模板、init next steps 和 roadmap 中理解 archLoop 的核心模型与当前推荐工作流。

### Scope

- README 与当前代码、CLI 行为、public API 的对齐。
- Init 生成后的 next steps、模板内注释和用户提示。
- Provider、runtime、template、preset role、sandbox、bootstrap contract 等核心概念的用户向解释。
- Capability pack、capability add-on、verification entrypoint 和 prompt assembly 的用户向解释。
- Local roadmap 与飞书云文档的同步维护约定。

### Deliverables

- README 不再停留在 baseline 状态，能反映 fork 后已经落地的主要能力。
- 用户可以根据文档选择 agent provider、runtime、sandbox provider、template 和 backlog manager。
- 用户可以理解何时选择 Project profile、template、preset agent 或 capability pack。
- Roadmap 阶段与 PRD、ADR、changeset 或 issue 建立轻量链接，避免把长设计细节塞进 roadmap。

### Tasks

- [ ] 审阅 README，并按当前代码更新 public API 与 CLI 示例（Project profile 文档收口见 [#26](https://github.com/yibeibankaishui/archloop/issues/26)）。
- [ ] 补齐 provider/runtime/template/preset role 的概念说明。
- [ ] 补齐 `archloop project status` 与 archLoop user data directory 的用户说明（见 [#63](https://github.com/yibeibankaishui/archloop/issues/63)）。
- [x] 补齐 capability pack 和小程序开发闭环说明（见 [capability-packs](./prd/capability-packs.md)、[ADR-0016](./adr/0016-capability-packs-compose-specialized-init-scaffolds.md)、[#48](https://github.com/yibeibankaishui/archloop/issues/48)）。
- [ ] 为常见工作流补充用户指南。
- [ ] 建立 roadmap 与 PRD、ADR、changeset、issue 的链接规范。

## 06 archLoop Hub 与 GUI

Status: Planned

Goal: 提供 CLI-first 的 archLoop Hub 控制面，并在同一状态模型上承接后续 GUI，用于管理项目、任务表、凭证、flows、运行观察和恢复。

### Scope

- archLoop Hub 与现有 `archloop init` scaffold 路径的边界。
- Hub project config、Hub project assets、Hub env file、Hub auth directory 和 Hub run directory。
- Beads 本地任务表、远程任务源 pull/push sync、agent-driven PRD/triage proposal flows、任务评论和 recovery。
- Flow、flow batch、task/run/batch 状态机、per-task merge events 和 task board projection。
- Hub-owned publish target、durable per-task landing transaction、fenced FIFO landing coordinator、自动 crash reconciliation 和 safe checkout projection。
- Hub-owned Beads task store、repository redirect、legacy automatic migration 和 immutable task snapshots。
- Local-first code delivery，以及显式配置的 best-effort / required remote code publication。
- 后续 GUI 的核心用户路径、信息架构和运行入口。
- GUI 与 Hub CLI / JS API 的边界、复用关系和数据来源。

### Deliverables

- archLoop Hub 的目标用户、核心流程和最小可用范围被明确记录。
- Hub task board 的本地任务源、远程同步、任务状态机和 flow 事件模型被明确记录。
- 可视化状态模型能覆盖 archLoop 的 task、batch、run、sandbox lifecycle 和 agent output。
- GUI 后续实现能复用 Hub task board 与 run/event 数据模型。
- `archloop run` 可以在不触碰用户 WIP、无需远程仓库、无需日常 `tasks recover` 的前提下自动 landing、验证、关闭任务并继续独立工作。
- Beads runtime/export state 不再进入代码仓库的 steady-state Git merge plane，已有项目自动迁移并保留裸 `bd` 兼容。
- 每个 landing、publication、task close、checkout projection 和 task-store migration 副作用都能从 durable evidence 自动恢复。

### Tasks

- [x] 明确 Hub task board、Beads 本地任务源、远程任务源同步与状态机设计（见 [archloop-hub-task-board](./prd/archloop-hub-task-board.md)、[ADR-0021](./adr/0021-hub-task-board-uses-beads-local-store.md)、[ADR-0022](./adr/0022-hub-flows-emit-per-task-merge-events.md)、[ADR-0023](./adr/0023-hub-task-statuses.md)）。
- [x] 实现 `archloop tasks list` / `archloop tasks show <task-selector>` 的只读 task board 投影与 Hub 状态分组；task selector 支持 Beads id 或完整标题（1-based 列表序号已按 ADR-0031 移除）。
- [x] 实现 `archloop tasks create <title>` / `archloop tasks comment <task-selector>` 的本地任务创建与评论写入。
- [x] 实现 `archloop tasks triage` 的 inbox / needs_info 协作状态分流与 AI triage 评论（见 [#66](https://github.com/yibeibankaishui/archloop/issues/66)）。
- [x] 实现 `archloop tasks from-prd <prd-ref>` 的 PRD 垂直切片分解、AFK/HITL 分类、人工确认依赖与 Beads 任务创建（见 [#67](https://github.com/yibeibankaishui/archloop/issues/67)）。
- [x] 实现 task claim metadata 与 Hub run 事件存储，为 flow 执行提供 run/batch/task 记录（见 [#69](https://github.com/yibeibankaishui/archloop/issues/69)）。
- [x] 为 task-board flow 的单批运行补充 run completion 事件与外层完成摘要，记录 completed batch/task counts 和 stop reason，避免 CLI 与 run history 只能从 batch 事件推断 flow 结束状态（见 [#174](https://github.com/Yibeibankaishui/archLoop/issues/174)）。
- [x] 为 task-board `archloop run` 增加显式 `--output plain`：通过进程内 Hub event observer 投影确定性 append-only lifecycle lines，覆盖空队列、单批、多批和 with-review 成功路径，并隔离 agent prose 与 ANSI 光标重写（见 [#203](https://github.com/Yibeibankaishui/archLoop/issues/203)、parent [#202](https://github.com/Yibeibankaishui/archLoop/issues/202)）。
- [x] 为 task-board run 增加 `completed` / `completed_with_failures` / `failed` / `cancelled` 结果投影、五类任务计数、失败诊断与精确 recovery/repair/dirty-overlap/same-flow rerun 指引，并定义 exit `0` / 非零 / `130` 行为（见 [#204](https://github.com/Yibeibankaishui/archLoop/issues/204)、parent [#202](https://github.com/Yibeibankaishui/archLoop/issues/202)）。
- [x] 为 task-board `archloop run` 增加 `--output json`：以 schema version 1 的 stdout-pure JSONL 投影 canonical lifecycle，覆盖稳定身份/顺序、诊断、日志、恢复动作、取消、最终 outcome 与 exit code，并保持 plain contract 不变（见 [#205](https://github.com/Yibeibankaishui/archLoop/issues/205)、parent [#202](https://github.com/Yibeibankaishui/archLoop/issues/202)）。
- [x] 将 task-board `archloop run` 默认输出升级为 `--output auto`：能力足够的 TTY 使用有界 live task board，重定向、CI、dumb/unsupported/unsafe terminal 自动回退 plain，并覆盖宽窄布局、无颜色语义、resize、终态与 cursor cleanup（见 [#206](https://github.com/Yibeibankaishui/archLoop/issues/206)、parent [#202](https://github.com/Yibeibankaishui/archLoop/issues/202)）。
- [x] Variant C Phase 3a：Hub run live view 改为 append-only `section` + 单行 spinner heartbeat（见 [#215](https://github.com/Yibeibankaishui/archLoop/issues/215)、ADR-0032、parent [#210](https://github.com/Yibeibankaishui/archLoop/issues/210)）。
- [x] Variant C Phase 3b：`archloop run` 用 run-plan `section` + 3 秒 debounce 替代 `confirmRunPlan`，支持 `Ctrl+C` 取消、`e` 重选 flow、`--yes` / non-TTY / `--dry-run` 跳过倒计时（见 [#216](https://github.com/Yibeibankaishui/archLoop/issues/216)、parent [#210](https://github.com/Yibeibankaishui/archLoop/issues/210)）。
- [x] Variant C Phase 4：对齐 bundled skill / README / readme_cn / user_guide 示例输出，删除 Phase 2–3 遗留 string formatter 包装，发布 `visual-overhaul-variant-c` changeset（见 [#217](https://github.com/Yibeibankaishui/archLoop/issues/217)、parent [#210](https://github.com/Yibeibankaishui/archLoop/issues/210)）。
- [x] 将 PRD decomposition 与 triage proposal phases 投影到共享 live/plain/JSON run output，保留 auto TTY prompts、non-interactive/`--yes` gates、mutation blocking，并区分 applied、no-change、cancelled、validation/mutation/general failure 终态（见 [#207](https://github.com/Yibeibankaishui/archLoop/issues/207)、parent [#202](https://github.com/Yibeibankaishui/archLoop/issues/202)）。
- [x] 实现首个 no-review Hub flow：从 Beads ready queue 选择任务、claim、运行 implementer，并将成功任务推进到 `waiting_for_merge`（见 [#70](https://github.com/yibeibankaishui/archloop/issues/70)）。
- [x] 实现 GitHub Issues 远程任务交换：`archloop tasks pull` 默认只拉 open issues，`tasks push` 将本地协作状态/关闭动作推到 GitHub，`tasks sync` 以 preview/确认方式做双向 reconcile，并避免同标题远端 issue 静默创建重复本地任务（见 [#68](https://github.com/yibeibankaishui/archloop/issues/68)、[#113](https://github.com/yibeibankaishui/archloop/issues/113)）。
- [x] 实现 with-review Hub flow：implementation 成功后进入 `reviewing`，reviewer 完成后推进到 `waiting_for_merge`（见 [#71](https://github.com/yibeibankaishui/archloop/issues/71)）。
- [x] 让 task-board flow 的 selected batch 并发执行 implementation / per-branch review，并保持 batch merge 串行收敛。
- [x] 让 task-board flow 在每个成功 batch 后继续读取 ready queue 并执行下一批，支持 `--max-batches` 作为总 batch 上限并在 `no_ready_tasks` / `max_batches_reached` 间正确收敛（见 [#176](https://github.com/yibeibankaishui/archloop/issues/176)、parent [#172](https://github.com/yibeibankaishui/archloop/issues/172)）。
- [x] 实现 Hub batch merge：eligible `waiting_for_merge` 任务进入 `merging`，按任务 emit merge/verification/close 事件，并在 merge、verification、本地 close 全部成功后标记 `done`（见 [#72](https://github.com/yibeibankaishui/archloop/issues/72)）。
- [ ] 实现 fully automatic Hub landing：以 Hub-managed local ref 为默认权威目标，按任务执行 durable candidate/verification/fenced-CAS/close transaction，以 ordered speculative chain 并行验证并按 FIFO 串行 landing；checkout、best-effort publication 和 cleanup 作为独立 durable projection 自动重试（见 [fully-automatic-hub-landing](./prd/fully-automatic-hub-landing.md)、parent [#247](https://github.com/Yibeibankaishui/archLoop/issues/247)、[#249](https://github.com/Yibeibankaishui/archLoop/issues/249)、[#252](https://github.com/Yibeibankaishui/archLoop/issues/252)、[#253](https://github.com/Yibeibankaishui/archLoop/issues/253)、[#255](https://github.com/Yibeibankaishui/archLoop/issues/255)、[#256](https://github.com/Yibeibankaishui/archLoop/issues/256)、[#257](https://github.com/Yibeibankaishui/archLoop/issues/257)、[#258](https://github.com/Yibeibankaishui/archLoop/issues/258)、[#260](https://github.com/Yibeibankaishui/archLoop/issues/260)、[#261](https://github.com/Yibeibankaishui/archLoop/issues/261)、[ADR-0035](./adr/0035-hub-landing-uses-durable-fenced-transactions.md)）。
      Current slice: Concurrent landing coordinators share a nonce/process-start/boot landing lease and advance the Git fence, publish target, and receipt atomically. A live owner is not stolen when a TTL elapses. Target drift invalidates the stale candidate and verification artifact, rebuilds on the new target, and fully reverifies before another CAS. Lease/lock/CAS contention stays pending ([#256](https://github.com/Yibeibankaishui/archLoop/issues/256)). Independent merge-ready tasks land in separate transactions with bounded Agent repair ([#253](https://github.com/Yibeibankaishui/archLoop/issues/253)). Interrupted local landing transactions resume from durable evidence ([#252](https://github.com/Yibeibankaishui/archLoop/issues/252)). `tasks doctor` stays read-only. Ordered speculative chains, FIFO quiet-wait, host contribution ordering, checkout projection, remote publication, and legacy pre-transaction history remain.
- [ ] 将 Hub Beads task store 外置到 stable Hub project directory，注入显式 `BEADS_DIR`、安装 Git-ignored `.beads/redirect`、自动迁移 legacy store、为执行 Agent 生成 immutable task snapshot，并为已有 task branch 的 runtime/export 变更提供安全兼容（见 parent [#247](https://github.com/Yibeibankaishui/archLoop/issues/247)、[#248](https://github.com/Yibeibankaishui/archLoop/issues/248)、[#250](https://github.com/Yibeibankaishui/archLoop/issues/250)、[#251](https://github.com/Yibeibankaishui/archLoop/issues/251)、[#254](https://github.com/Yibeibankaishui/archLoop/issues/254)、[#259](https://github.com/Yibeibankaishui/archLoop/issues/259)、[ADR-0036](./adr/0036-hub-owns-the-beads-task-store.md)）。
      Current slice: Candidate construction strips only an exact allowlist of Beads runtime/export paths from legacy task branches, records every filtered path, and leaves the source branch and checkout unchanged ([#254](https://github.com/Yibeibankaishui/archLoop/issues/254)). Beads configuration, documentation, hooks, and unknown `.beads/**` paths remain ordinary source changes. Unsafe pre-quarantine conditions defer migration while the verified legacy store stays active; cross-filesystem copies use only the quarantined cold database; leftover-plus-managed divergence after redirect is `task_store_split_brain` and stops automatic writes ([#259](https://github.com/Yibeibankaishui/archLoop/issues/259)). Writer-free stores still migrate automatically ([#251](https://github.com/Yibeibankaishui/archLoop/issues/251)). New projects initialize a Hub-owned store and Git-ignored `.beads/redirect` ([#248](https://github.com/Yibeibankaishui/archLoop/issues/248)). Agents run from an immutable task snapshot ([#250](https://github.com/Yibeibankaishui/archLoop/issues/250)).
- [ ] 完成 #120 P0 回归切片：真实 Git merger 在 `.beads/issues.jsonl` staged/modified 时仍从 clean Hub integration worktree landing code，且保持用户 index/WIP 不变、不要求 `tasks recover`（见 [#120](https://github.com/Yibeibankaishui/archLoop/issues/120)）。
- [x] 实现 `archloop tasks recover <task-selector>`：释放 stale claim、恢复 recoverable `failed` 任务、保留可重试的 branch work、在安全时清理空的 Hub-managed branch，并处理已 merge 分支上的 `close_failed`（见 [#73](https://github.com/yibeibankaishui/archloop/issues/73)）。
- [x] 实现 event-aware recovery router 与共享 interrupted-execution detector：按 run event log 的 phase-completion 信号路由中断任务（finished review → `waiting_for_merge`，finished implementation → `reviewing`，无事件 → `ready_for_agent`），并将 `reviewing` / `merging` / `waiting_for_merge` 正确标为活跃 claim（见 [#230](https://github.com/Yibeibankaishui/archLoop/issues/230)、[#231](https://github.com/Yibeibankaishui/archLoop/issues/231)、[#232](https://github.com/Yibeibankaishui/archLoop/issues/232)、[#233](https://github.com/Yibeibankaishui/archLoop/issues/233)、parent PRD [#229](https://github.com/Yibeibankaishui/archLoop/issues/229)）。
- [x] 为 `archloop tasks doctor` 增加 `interrupted_execution` 诊断：复用共享 detector，对 lease 诊断未覆盖的中断任务给出精确 next action（finished-phase vs implement-interrupted），`repairable: false`（见 [#234](https://github.com/Yibeibankaishui/archLoop/issues/234)、parent PRD [#229](https://github.com/Yibeibankaishui/archLoop/issues/229)）。
- [x] 为 `archloop tasks recover` 增加 `--stale` 批量恢复：加载 task board、worktree leases 与 run event log，经共享 interrupted-execution detector 与 event-aware recovery router 一次性恢复所有中断任务，默认 dry-run 预览每任务路由，仅 `--yes`（或交互确认）后落地，镜像 `repair-state` 确认模式（见 [#235](https://github.com/Yibeibankaishui/archLoop/issues/235)、parent PRD [#229](https://github.com/Yibeibankaishui/archLoop/issues/229)）。
- [x] 在 `archloop run` 启动时自动检测并恢复中断任务（ADR-0034）：经共享 detector + event-aware router 恢复后，由既有 resumed-batch merge / planner 续跑剩余阶段，并在人工输出与 JSON `autoRecover` 中汇报每任务路由（见 [#236](https://github.com/Yibeibankaishui/archLoop/issues/236)、[ADR-0034](./adr/0034-run-startup-auto-recovers-interrupted-tasks.md)、parent PRD [#229](https://github.com/Yibeibankaishui/archLoop/issues/229)）。
- [x] 完成 interrupted-run 可见性收尾：`archloop tasks list` 用共享 detector 为中断任务加 `⚠ interrupted` 徽章（`--json` 行新增 `interrupted`，无 `.archloop/locks/` 目录时整体跳过以保持健康看板零开销），失败 run 的 `fix` footer 用真实下一步替换从未实现的 `archloop run --resume --only-failed`——有任务真正 failed 指向 `archloop tasks recover --stale`，run 被中断则指向 `archloop run`——并同步 bundled skill / README / readme_cn / user_guide / roadmap（见 [#237](https://github.com/Yibeibankaishui/archLoop/issues/237)、parent PRD [#229](https://github.com/Yibeibankaishui/archLoop/issues/229)）。
- [x] 强化 Hub flow lifecycle 与 legacy batch merge preflight：rerun 可复用已有未合并分支 work，transition 后校验 task projection，merge summary 解释 selected/skipped/blocked 原因，将 `.beads/` runtime/export 文件分类为非源码状态，在无 ready 任务时恢复同 flow 的旧 unfinished batch merge，并在 Git merge conflict 时调用配置好的 `merge` agent role 解决冲突后再继续 verification/close；steady-state replacement 由 #247 与 ADR-0035/0036 承接（见 [#120](https://github.com/yibeibankaishui/archloop/issues/120)、[#121](https://github.com/yibeibankaishui/archloop/issues/121)、[#122](https://github.com/yibeibankaishui/archloop/issues/122)、[#123](https://github.com/yibeibankaishui/archloop/issues/123)、[#124](https://github.com/yibeibankaishui/archloop/issues/124)、[#125](https://github.com/yibeibankaishui/archloop/issues/125)、[#126](https://github.com/yibeibankaishui/archloop/issues/126)、[ADR-0027](./adr/0027-hub-beads-runtime-files-stay-local.md)）。
- [x] 增强 `archloop project status`：汇总 Hub 任务状态计数、active run/batch、失败任务与 sync 状态，并指向 Hub run 目录（见 [#74](https://github.com/yibeibankaishui/archloop/issues/74)）。
- [x] 实现 Hub-wide agent role config CLI：`agent-config path/show/set-role`、缺失角色提示与非交互失败行为（见 [#79](https://github.com/yibeibankaishui/archloop/issues/79)、parent [#78](https://github.com/yibeibankaishui/archloop/issues/78)）。
- [x] 为 Hub flow registry 增加 typed input schema，并在 `archloop run --flow --input` 与 task shortcut 命令中校验 proposal flow 输入（见 [#80](https://github.com/yibeibankaishui/archloop/issues/80)、parent [#78](https://github.com/yibeibankaishui/archloop/issues/78)）。
- [x] 实现 Hub provider auth namespace：`archloop auth show/path/login` 负责 Codex/GitHub Hub-owned session 目录，`env init` 保持 key/value 边界并提示 Codex API billing vs CLI login session（见 [#108](https://github.com/yibeibankaishui/archloop/issues/108)、[ADR-0028](./adr/0028-hub-auth-namespace-owns-provider-sessions.md)）。
- [x] 实现 proposal session runtime：Hub 管理 transcript、结构化 finalization、取消/失败路径，并在 Hub run 目录持久化 prepared context、transcript、final proposal、apply placeholder 与 events（见 [#81](https://github.com/yibeibankaishui/archloop/issues/81)、parent [#78](https://github.com/yibeibankaishui/archloop/issues/78)）。
- [x] 实现 proposal flow mutation detection：在 proposal flow 前后快照 repo 与本地 task store，检测意外变更后 fail before apply，报告变更且不自动回滚（见 [#82](https://github.com/yibeibankaishui/archloop/issues/82)、parent [#78](https://github.com/yibeibankaishui/archloop/issues/78)）。
- [x] 实现 `archloop project configure` 与 Hub project development contract 持久化输出，并让 `run --flow` 在任务板 implementer prompt 中消费该 contract，缺失时创建 generic fallback 后继续执行（见 [#173](https://github.com/yibeibankaishui/archloop/issues/173)、[#175](https://github.com/yibeibankaishui/archloop/issues/175)）。
- [ ] 实现 worktree lease：非 head branch strategy 在 agent 使用 worktree 前获取内部 lease，Hub task retry 复用保留代码并通过 status/doctor 暴露 active/stale/mismatch 诊断（见 [worktree-lease](./prd/worktree-lease.md)、[ADR-0007](./adr/0007-worktree-locking.md)）。
- [x] 实现 prd-decomposition proposal flow：archLoop-owned prompt、结构化 proposal schema、proposal session 编排、Beads apply 与 `archloop tasks from-prd` 接线（见 [#83](https://github.com/yibeibankaishui/archloop/issues/83)、parent [#78](https://github.com/yibeibankaishui/archloop/issues/78)）。
- [x] 实现 triage proposal flow：archLoop-owned prompt、结构化 triage proposal schema、proposal session 编排、guarded `--yes` apply，并将 `archloop tasks triage` 接到 agent-driven proposal path（见 [#84](https://github.com/yibeibankaishui/archloop/issues/84)、parent [#78](https://github.com/yibeibankaishui/archloop/issues/78)）。
- [x] 将 `archloop run --flow prd-decomposition/triage` 与 task shortcut 统一到 proposal flow 主路径，并将 deterministic PRD/triage helper 保留为测试或显式 fallback（见 [#85](https://github.com/yibeibankaishui/archloop/issues/85)、parent [#78](https://github.com/yibeibankaishui/archloop/issues/78)）。
- [x] 完成 agent-driven task proposal flows 的文档与人工 QA 收尾：README、bundled usage skill、Hub task board PRD、QA 指标和 roadmap 均明确 proposal sessions、Hub-wide `agent-config`、`run --flow --input`、local-only Beads writes、task sync 边界、guarded `--yes` 行为和需要真实 agent 人工验收的场景（见 [#86](https://github.com/yibeibankaishui/archloop/issues/86)、parent [#78](https://github.com/yibeibankaishui/archloop/issues/78)）。
- [x] 实现 `archloop tasks cleanup` 的 Hub-managed branch preview / confirmed cleanup 命令，支持默认安全预览、confirmed managed cleanup，以及历史 unowned `archloop/...` 候选的 `--include-unowned` opt-in（见 [#183](https://github.com/yibeibankaishui/archLoop/issues/183)、parent [#180](https://github.com/yibeibankaishui/archLoop/issues/180)）。
- [x] 实现 Hub merge lifecycle 的安全 task branch 自动清理：任务成功 close 后尝试 non-force 删除 safe managed 分支，cleanup 失败只记警告不回滚 close（见 [#182](https://github.com/Yibeibankaishui/archLoop/issues/182)、parent [#180](https://github.com/Yibeibankaishui/archLoop/issues/180)）。
- [x] 在 `archloop tasks doctor` 与 `archloop project status` 中公开 managed branch cleanup diagnostics，复用 shared evaluator 展示 safe candidates、blocked reasons 和 historical unowned preservation 规则（见 [#185](https://github.com/yibeibankaishui/archLoop/issues/185)、parent [#180](https://github.com/yibeibankaishui/archLoop/issues/180)）。
- [x] 将 `archloop tasks doctor` 输出迁移到 repo 的 section-block 渲染器：按严重程度（error = 中断/失败，warn = 过期/待同步，info = 信息性清理）分组着色，顶部 badges 行汇总各级别数量，每条诊断展示 task id、原因、作为 dim trailing hint 的下一步动作与作为 dim 续行的说明；`NO_COLOR` / 非 TTY / `--plain` 退化为保留全部 id/原因/说明/下一步动作的纯文本。检测逻辑不变，仅迁移展示层（见 [#239](https://github.com/yibeibankaishui/archLoop/issues/239)）。
- [x] 增强 `archloop tasks show` 视觉层级：status 值按看板 bucket severity 着色、评论时间线加粗作者 / dim 时间戳、剩余 metadata 以带标签的 kv 行代替原始 JSON；plain 模式保留全部文本内容（见 [#240](https://github.com/Yibeibankaishui/archLoop/issues/240)）。
- [x] 将 `archloop tasks repair-state` 输出迁移到 section-block 渲染器：按目标 Hub status 分组，并用看板 bucket severity 着色（Planned/Applied 标题可区分）；plain 模式保留全部 task id、原因、目标 status 与 branch；`--yes` 引导文案在未应用时保留。修复逻辑不变，仅迁移展示层（见 [#241](https://github.com/Yibeibankaishui/archLoop/issues/241)）。
- [x] 将 `archloop tasks cleanup` 输出迁移到 section-block 渲染器：按 safe managed / blocked managed / unowned historical 三分组着色（success ✓ / warn ! / info ●），保留 dry-run 预览与 deleted-branch 摘要；plain 模式保留全部 branch、task id 与 skip reason。评估/删除计划逻辑不变，仅迁移展示层（见 [#242](https://github.com/Yibeibankaishui/archLoop/issues/242)）。
- [x] 让 multi-iteration Hub implementer 在后续 iteration 的 transient provider startup abort（无 agent output）时继续运行，并为零提交的 exploration turn 注入进度摘要与 implementation nudge；耗尽 iteration 且无 completion signal / 无 branch work 仍记 `agent_failed`，且不回归 already-merged 判断（见 [#244](https://github.com/Yibeibankaishui/archLoop/issues/244)）。
- [x] 落地 Hub project registry 第一片段：`project add` / `project list` / `project select` 支持共享 registry、selected project、跨目录使用，以及 `project list` 的轻量 readiness projection（见 [#186](https://github.com/Yibeibankaishui/archLoop/issues/186)、[#188](https://github.com/Yibeibankaishui/archLoop/issues/188)、[#194](https://github.com/Yibeibankaishui/archLoop/issues/194)）。
- [x] 完成 Hub project onboarding 的 `project add` slice：repo path/name prompts、repo signal profile recommendation、development contract 刷新、local task store 推荐/可拒绝初始化，以及 selected project handoff（见 [#189](https://github.com/Yibeibankaishui/archLoop/issues/189)、parent [#186](https://github.com/Yibeibankaishui/archLoop/issues/186)）。
- [x] 实现共享 Hub project target resolver，并让 `project status` / `project configure` 优先使用显式目标、CLI selected project 和 TTY picker，而不是当前工作目录（见 [#191](https://github.com/Yibeibankaishui/archLoop/issues/191)、parent [#186](https://github.com/Yibeibankaishui/archLoop/issues/186)）。
- [x] 实现 Hub project identity maintenance：`project rename` / `project relink` 现在可在不改变稳定 Hub project id 的前提下更新用户可见项目名与 repo path，并对重复名称、重复路径和无效路径给出可操作的报错（见 [#190](https://github.com/Yibeibankaishui/archLoop/issues/190)、parent [#186](https://github.com/Yibeibankaishui/archLoop/issues/186)）。
- [ ] 定义 archLoop Hub 控制面的核心用户路径。
- [x] 设计 Hub project onboarding、credentials、`archloop check` readiness 验证和 flow run CLI；v1 聚焦注册已有 git repo，后续再支持从 archLoop 创建全新代码项目（见 [hub-project-onboarding-and-check](./prd/hub-project-onboarding-and-check.md)、[#186](https://github.com/Yibeibankaishui/archLoop/issues/186)、[ADR-0029](./adr/0029-hub-project-registry-and-active-context.md)）。
      Current slice: `archloop initialize` now configures Hub-wide roles/env/auth guidance and runs the quick Hub check by default; `archloop check` renders visible progress, runs real provider/model smoke checks through the provider path used by Hub flow execution, lists the roles covered by each provider/model check, checks the selected, explicit, or all registered projects for repo path, git, initial commit, contract, task-store, active run, and flow readiness signals, and returns non-zero on blocking errors; `archloop run` is now project-centric, defaults to the selected Hub project, and opens project / flow pickers in TTYs. The README, Chinese README, user guide, bundled usage skill, and command reference now frame `archloop init` as the legacy repo-local scaffold path.
- [ ] 设计 run / sandbox / branch / logs / agent stream 的可视化模型。
- [ ] 明确 GUI 与 Hub CLI / JS API 的关系。
