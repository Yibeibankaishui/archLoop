# Product Definition and Scope

本文档记录当前产品定位、能力边界和对外叙事，用于后续命名、文档、路线图和产品取舍。

## 一句话定位

archLoop 是一个自动化软件工程执行系统：把任务、需求或 PRD 交给 AI agents，通过隔离环境、分支/worktree、验证、审查、修复和合并闭环，持续产出可交付的高质量代码变更。

## 它不是什么

- 不是单纯的 AI coding assistant。
- 不是一次性代码生成器。
- 不是只跑 agent 的 sandbox wrapper。
- 不是普通 issue tracker。
- 不是 IDE 插件。

## 它是什么

- 一个能接收任务并推进到代码结果的工程系统。
- 一个多 agent / 多 provider 的执行控制面。
- 一个把“写代码”变成可验证、可恢复、可审计流程的自动化层。
- 一个面向 AFK 编程和高质量交付的 agent loop runtime。

## 核心产品范围

### Task to Code

从 GitHub Issues、Beads、本地任务、PRD 分解开始，把任务变成可执行的开发单元。

### Agent Execution Loop

让不同 AI coding agents 执行计划、实现、审查、修复、恢复、合并等阶段。

### Quality Loop

每次变更都可以通过 bootstrap、verification、review、repair、merge gate 收敛质量。

### Isolated Workspaces

用 sandbox、worktree、branch strategy 控制 agent 的执行边界和代码落点。

### Hub / Control Plane

管理项目、共享认证、任务状态、flow、运行日志、失败恢复和批量执行。

### Capability Packs

针对不同项目类型提供可复用开发闭环，比如小程序、未来的 web、backend、mobile 等。

## 真正亮点

- **Loop 产生质量**：不是生成一次就结束，而是执行、验证、修复、再验证。
- **从任务到合并**：目标不是输出代码片段，而是推进真实代码库状态。
- **Agent 可替换**：Claude Code、Codex、Cursor、OpenCode 等 provider 可以组合。
- **工程边界清楚**：sandbox、worktree、branch、logs、events、auth 都有明确所有权。
- **适合 AFK 工作**：用户可以把一批任务交给系统，它按 flow 批量推进。
- **可恢复、可审计**：失败不是黑盒，能看到 run directory、events、task status、next action。
- **面向产品交付**：最终价值是更高质量的代码产品，而不是更快的聊天式补全。

## 对外叙事

### 用户价值

Give it work. It ships verified code.

### 技术机制

Autonomous coding through task-driven, sandboxed, verifiable agent loops.

### 品牌气质

不是一个可爱小助手，而是一个可靠的自动工程师：能接任务、能检查自己、能修复失败、能把代码推进到可交付状态。

## 命名启发

基于以上定位，命名应优先围绕以下语义，而不是单纯围绕 code 或 craft：

- **origin**：项目从这里开始，并被推进成可交付结果。
- **reliable engineer**：拟人化但专业，像可信赖的自动工程师。
- **delivery**：强调把工作推进到完成，而不只是生成片段。
- **quality loop**：强调通过反复验证、修复和审查产生质量。
- **verified product**：强调可运行、可验证、可交付的代码产品。
