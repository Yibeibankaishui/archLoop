# Sandcastle Templates Agent 编排模式

本文整理 Sandcastle 现有 workflow templates 对应的 agent 编排框架图。这里的 template 指 `sandcastle init` 复制到 `.sandcastle/` 的工作流模板；它定义 agent 如何协作，不定义项目语言或构建系统。项目语言和 bootstrap 假设由 Project profile 负责。

## 总览

```mermaid
flowchart LR
    Blank["blank<br/>single run"] --> Simple["simple-loop<br/>single worker loop"]
    Simple --> Sequential["sequential-reviewer<br/>implement then review"]
    Sequential --> Parallel["parallel-planner<br/>plan, parallel implement, merge"]
    Parallel --> ParallelReview["parallel-planner-with-review<br/>plan, parallel implement and review, merge"]
```

## blank

`blank` 是最小脚手架：一个 prompt、一个 agent、一次 `sandcastle.run()`。它适合从空白处自定义 orchestration。

```mermaid
flowchart TD
    User["User runs .sandcastle/main.mts"] --> Run["sandcastle.run"]
    Run --> Sandbox["Sandbox Provider<br/>docker or no-sandbox"]
    Run --> Agent["Single Agent<br/>default: claude-opus-4-6"]
    Run --> Prompt[".sandcastle/prompt.md"]

    Sandbox --> Agent
    Prompt --> Agent
    Agent --> Result["Commits / Output"]
```

## simple-loop

`simple-loop` 使用单个 worker agent 顺序处理任务。每轮选一个 open task，完成实现、验证、提交并关闭任务。

```mermaid
flowchart TD
    Start["Run simple-loop"] --> Bootstrap["sandbox.onSandboxReady<br/>bash .sandcastle/bootstrap.sh"]
    Bootstrap --> Worker["Worker Agent<br/>claude-sonnet-4-6"]
    Worker --> Prompt["prompt.md<br/>list tasks + recent commits"]

    Prompt --> Pick["Pick highest-priority open task"]
    Pick --> Implement["Implement one task"]
    Implement --> Verify["npm run typecheck<br/>npm run test"]
    Verify --> Commit["Commit with RALPH prefix"]
    Commit --> Close["Close task<br/>CLOSE_TASK_COMMAND"]

    Close --> More{"More iterations?<br/>maxIterations: 3"}
    More -->|Yes| Worker
    More -->|No or COMPLETE| Done["Done"]

    Worker -. branchStrategy .-> MergeToHead["merge-to-head<br/>temp branch merged back to HEAD"]
```

## sequential-reviewer

`sequential-reviewer` 每轮创建一个共享 sandbox 和显式分支。implementer 先实现任务，若产生 commit，reviewer 在同一分支上审查并可直接修正。

```mermaid
flowchart TD
    Start["Run sequential-reviewer"] --> Loop["Outer loop<br/>MAX_ITERATIONS: 10"]
    Loop --> Branch["Create branch<br/>sandcastle/sequential-reviewer/timestamp"]
    Branch --> Sandbox["createSandbox<br/>shared sandbox + shared branch"]
    Sandbox --> Bootstrap["sandbox.onSandboxReady<br/>bash .sandcastle/bootstrap.sh"]

    Bootstrap --> Implementer["Implementer Agent<br/>claude-sonnet-4-6<br/>maxIterations: 100"]
    Implementer --> ImplementPrompt["implement-prompt.md"]
    ImplementPrompt --> Work["Pick and implement one task"]
    Work --> CommitCheck{"Commits produced?"}

    CommitCheck -->|No| CloseSandbox["Close sandbox"]
    CommitCheck -->|Yes| Reviewer["Reviewer Agent<br/>claude-sonnet-4-6<br/>maxIterations: 1"]
    Reviewer --> ReviewPrompt["review-prompt.md<br/>BRANCH argument"]
    ReviewPrompt --> Review["Review diff<br/>optionally refine and commit"]
    Review --> CloseSandbox

    CloseSandbox --> Next{"Next iteration?"}
    Next -->|Yes| Loop
    Next -->|No| Done["All done"]
```

## parallel-planner

`parallel-planner` 将 backlog 处理拆成规划、并行执行、合并三个阶段。planner 输出 `<plan>` JSON，多个 implementer 分支并行工作，merger 负责合并成功产生 commit 的分支。

```mermaid
flowchart TD
    Start["Run parallel-planner"] --> Loop["Outer loop<br/>MAX_ITERATIONS: 10"]

    Loop --> Planner["Planner Agent<br/>claude-opus-4-6<br/>maxIterations: 1"]
    Planner --> PlanPrompt["plan-prompt.md<br/>open tasks"]
    PlanPrompt --> Plan["Output <plan> JSON<br/>unblocked tasks + branches"]

    Plan --> AnyIssues{"Any unblocked issues?"}
    AnyIssues -->|No| Done["Exit"]
    AnyIssues -->|Yes| FanOut["Fan out with Promise.allSettled"]

    FanOut --> I1["Implementer Agent 1<br/>branch: issue branch"]
    FanOut --> I2["Implementer Agent 2<br/>branch: issue branch"]
    FanOut --> IN["Implementer Agent N<br/>branch: issue branch"]

    I1 --> P1["implement-prompt.md<br/>TASK_ID + ISSUE_TITLE + BRANCH"]
    I2 --> P2["implement-prompt.md<br/>TASK_ID + ISSUE_TITLE + BRANCH"]
    IN --> PN["implement-prompt.md<br/>TASK_ID + ISSUE_TITLE + BRANCH"]

    P1 --> C1["Commits?"]
    P2 --> C2["Commits?"]
    PN --> CN["Commits?"]

    C1 --> Collect["Collect branches with commits"]
    C2 --> Collect
    CN --> Collect

    Collect --> HasCommits{"Any completed branches?"}
    HasCommits -->|No| Loop
    HasCommits -->|Yes| Merger["Merger Agent<br/>claude-sonnet-4-6<br/>maxIterations: 1"]

    Merger --> MergePrompt["merge-prompt.md<br/>BRANCHES + ISSUES"]
    MergePrompt --> Merge["Merge branches<br/>resolve conflicts<br/>run tests<br/>close tasks"]
    Merge --> Loop
```

## parallel-planner-with-review

`parallel-planner-with-review` 是当前最完整的模板。它保留 planner 和 merger，同时把每个 issue 的执行管线升级为 implementer + reviewer。所有 issue pipeline 并行运行，每条 pipeline 内部顺序实现、审查、合并 commit 结果。

```mermaid
flowchart TD
    Start["Run parallel-planner-with-review"] --> Loop["Outer loop<br/>MAX_ITERATIONS: 10"]

    Loop --> Planner["Planner Agent<br/>claude-opus-4-6<br/>maxIterations: 1"]
    Planner --> PlanPrompt["plan-prompt.md<br/>open tasks"]
    PlanPrompt --> Plan["Output <plan> JSON<br/>unblocked tasks + branches"]

    Plan --> AnyIssues{"Any unblocked issues?"}
    AnyIssues -->|No| Done["Exit"]
    AnyIssues -->|Yes| FanOut["Fan out issue pipelines<br/>Promise.allSettled"]

    FanOut --> Pipeline1["Issue Pipeline 1"]
    FanOut --> Pipeline2["Issue Pipeline 2"]
    FanOut --> PipelineN["Issue Pipeline N"]

    subgraph OnePipeline["Per-issue pipeline"]
        CreateSandbox["createSandbox<br/>dedicated branch"] --> Bootstrap["sandbox.onSandboxReady<br/>bash .sandcastle/bootstrap.sh"]
        Bootstrap --> Implementer["Implementer Agent<br/>claude-sonnet-4-6<br/>maxIterations: 100"]
        Implementer --> ImplementPrompt["implement-prompt.md<br/>TASK_ID + ISSUE_TITLE + BRANCH"]
        ImplementPrompt --> CommitCheck{"Commits produced?"}
        CommitCheck -->|No| PipelineDone["Close sandbox"]
        CommitCheck -->|Yes| Reviewer["Reviewer Agent<br/>claude-sonnet-4-6<br/>maxIterations: 1"]
        Reviewer --> ReviewPrompt["review-prompt.md<br/>BRANCH"]
        ReviewPrompt --> Review["Review diff<br/>optionally refine and commit"]
        Review --> Combine["Combine implementer + reviewer commits"]
        Combine --> PipelineDone
    end

    Pipeline1 --> Collect["Collect completed branches with commits"]
    Pipeline2 --> Collect
    PipelineN --> Collect

    Collect --> HasCommits{"Any completed branches?"}
    HasCommits -->|No| Loop
    HasCommits -->|Yes| Merger["Merger Agent<br/>claude-sonnet-4-6<br/>maxIterations: 1"]

    Merger --> MergePrompt["merge-prompt.md<br/>BRANCHES + ISSUES"]
    MergePrompt --> Merge["Merge reviewed branches<br/>resolve conflicts<br/>run tests<br/>close tasks"]
    Merge --> Loop
```

## 选择建议

| 目标                                       | 推荐模板                       |
| ------------------------------------------ | ------------------------------ |
| 从最小示例开始，自定义自己的编排           | `blank`                        |
| 单 agent 逐个处理任务                      | `simple-loop`                  |
| 逐个处理任务，但每次实现后都要 review      | `sequential-reviewer`          |
| 并行处理多个互不阻塞任务                   | `parallel-planner`             |
| 并行处理任务，并对每个分支增加 review gate | `parallel-planner-with-review` |
