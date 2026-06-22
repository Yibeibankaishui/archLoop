import { describe, expect, it } from "vitest";

import { HubFlowError } from "./errors.js";
import {
  HUB_BATCH_DEFAULT_MAX_TASKS,
  HUB_BATCH_MAX_TASKS_UPPER_LIMIT,
  parseHubBatchMaxTasks,
  parseHubBatchPlannerOutput,
  parseHubBatchStrategy,
  planHubFlowBatch,
  resolveHubBatchSelectionOptions,
  selectHubFlowTasksWithBatchOptions,
  validateHubBatchPlannerOutput,
} from "./hubBatchPlanner.js";
import type { HubTaskProjection } from "./taskBoard.js";

const readyTask = (
  id: string,
  overrides: Partial<HubTaskProjection> = {},
): HubTaskProjection =>
  ({
    id,
    title: `Task ${id}`,
    hubStatus: "ready_for_agent",
    claimState: "none",
    ...overrides,
  }) as HubTaskProjection;

const plannerStdout = (output: {
  readonly selectedTaskIds: readonly string[];
  readonly deferred?: readonly { readonly taskId: string; readonly reason: string }[];
  readonly rationale?: string;
}): string =>
  `<batch-plan>${JSON.stringify({
    deferred: [],
    ...output,
  })}</batch-plan>`;

describe("hubBatchPlanner", () => {
  it("parses and validates max-tasks bounds for task-board flows", () => {
    expect(parseHubBatchMaxTasks("1")).toBe(1);
    expect(parseHubBatchMaxTasks(String(HUB_BATCH_MAX_TASKS_UPPER_LIMIT))).toBe(
      HUB_BATCH_MAX_TASKS_UPPER_LIMIT,
    );

    expect(() => parseHubBatchMaxTasks("0")).toThrow(HubFlowError);
    expect(() =>
      parseHubBatchMaxTasks(String(HUB_BATCH_MAX_TASKS_UPPER_LIMIT + 1)),
    ).toThrow(HubFlowError);
    expect(() => parseHubBatchMaxTasks("abc")).toThrow(HubFlowError);
  });

  it("parses planned and conservative batch strategies", () => {
    expect(parseHubBatchStrategy("conservative")).toBe("conservative");
    expect(parseHubBatchStrategy(" Planned ")).toBe("planned");
    expect(() => parseHubBatchStrategy("limited")).toThrow(HubFlowError);
  });

  it("rejects batch selection options for proposal flows", () => {
    expect(() =>
      resolveHubBatchSelectionOptions({
        flowKind: "proposal",
        batchStrategy: "conservative",
      }),
    ).toThrow(/Proposal flows do not support --batch-strategy or --max-tasks/);

    expect(() =>
      resolveHubBatchSelectionOptions({
        flowKind: "proposal",
        maxTasks: "2",
      }),
    ).toThrow(/Proposal flows do not support --batch-strategy or --max-tasks/);
  });

  it("defaults max-tasks when batch strategy is provided for task-board flows", () => {
    expect(
      resolveHubBatchSelectionOptions({
        flowKind: "task-board",
        batchStrategy: "conservative",
      }),
    ).toEqual({
      batchStrategy: "conservative",
      maxTasks: HUB_BATCH_DEFAULT_MAX_TASKS,
    });
  });

  it("selects only the first eligible ready task for conservative strategy", async () => {
    const candidates = [
      readyTask("bd-first"),
      readyTask("bd-second"),
      readyTask("bd-claimed", { claimState: "active" }),
      readyTask("bd-human", { hubStatus: "ready_for_human" }),
    ];

    const result = await planHubFlowBatch({
      candidates,
      batchStrategy: "conservative",
      maxTasks: HUB_BATCH_DEFAULT_MAX_TASKS,
    });

    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-first"]);
    expect(result.deferredTasks).toEqual([
      { taskId: "bd-second", reason: "over_max_tasks" },
    ]);
    expect(result.batchStrategyUsed).toBe("conservative");
  });

  it("preserves ready queue order for conservative selection", async () => {
    const { selectedTasks } = await selectHubFlowTasksWithBatchOptions({
      candidates: [readyTask("bd-a"), readyTask("bd-b"), readyTask("bd-c")],
      batchStrategy: "conservative",
      maxTasks: 3,
    });

    expect(selectedTasks.map((task) => task.id)).toEqual(["bd-a"]);
  });

  it("parses valid planned batch planner output", () => {
    const parsed = parseHubBatchPlannerOutput(
      plannerStdout({
        selectedTaskIds: ["bd-1", "bd-2"],
        deferred: [{ taskId: "bd-3", reason: "explicit_blocker" }],
        rationale: "Parallel API work is safe.",
      }),
    );

    expect(parsed).toEqual({
      selectedTaskIds: ["bd-1", "bd-2"],
      deferred: [{ taskId: "bd-3", reason: "explicit_blocker" }],
      rationale: "Parallel API work is safe.",
    });
    expect(
      validateHubBatchPlannerOutput({
        output: parsed!,
        eligibleTaskIds: new Set(["bd-1", "bd-2", "bd-3"]),
        maxTasks: 3,
      }),
    ).toBeUndefined();
  });

  it("rejects invalid planned planner output reasons", () => {
    const parsed = parseHubBatchPlannerOutput(
      plannerStdout({
        selectedTaskIds: ["bd-1"],
        deferred: [{ taskId: "bd-2", reason: "mystery_reason" }],
      }),
    );

    expect(parsed?.deferred).toEqual([]);
  });

  it("uses planned planner output when valid", async () => {
    const candidates = [
      readyTask("bd-first"),
      readyTask("bd-second"),
      readyTask("bd-third"),
    ];

    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: "/tmp/repo",
      runDir: "/tmp/run",
      candidates,
      batchStrategy: "planned",
      maxTasks: 2,
      batchPlanner: async () =>
        plannerStdout({
          selectedTaskIds: ["bd-first", "bd-second"],
          deferred: [{ taskId: "bd-third", reason: "same_core_module" }],
          rationale: "Two independent tasks.",
        }),
    });

    expect(result.batchStrategyUsed).toBe("planned");
    expect(result.selectedTasks.map((task) => task.id)).toEqual([
      "bd-first",
      "bd-second",
    ]);
    expect(result.deferredTasks).toEqual([
      { taskId: "bd-third", reason: "same_core_module" },
    ]);
    expect(result.rationale).toBe("Two independent tasks.");
  });

  it("falls back to conservative when planned planner fails", async () => {
    const candidates = [readyTask("bd-first"), readyTask("bd-second")];

    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: "/tmp/repo",
      runDir: "/tmp/run",
      candidates,
      batchStrategy: "planned",
      maxTasks: 3,
      batchPlanner: async () => {
        throw new Error("planner offline");
      },
    });

    expect(result.batchStrategyUsed).toBe("conservative");
    expect(result.fallbackReason).toBe("planner_failed");
    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-first"]);
  });

  it("falls back to conservative for malformed planned planner output", async () => {
    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: "/tmp/repo",
      runDir: "/tmp/run",
      candidates: [readyTask("bd-first"), readyTask("bd-second")],
      batchStrategy: "planned",
      maxTasks: 3,
      batchPlanner: async () => "no batch plan here",
    });

    expect(result.batchStrategyUsed).toBe("conservative");
    expect(result.fallbackReason).toBe("malformed_output");
    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-first"]);
  });

  it("falls back to conservative for out-of-candidate planned selections", async () => {
    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: "/tmp/repo",
      runDir: "/tmp/run",
      candidates: [readyTask("bd-first")],
      batchStrategy: "planned",
      maxTasks: 3,
      batchPlanner: async () =>
        plannerStdout({
          selectedTaskIds: ["bd-ghost"],
        }),
    });

    expect(result.batchStrategyUsed).toBe("conservative");
    expect(result.fallbackReason).toBe("invalid_task_ids");
    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-first"]);
  });

  it("falls back to conservative for duplicate planned selections", async () => {
    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: "/tmp/repo",
      runDir: "/tmp/run",
      candidates: [readyTask("bd-first"), readyTask("bd-second")],
      batchStrategy: "planned",
      maxTasks: 3,
      batchPlanner: async () =>
        plannerStdout({
          selectedTaskIds: ["bd-first", "bd-first"],
        }),
    });

    expect(result.fallbackReason).toBe("duplicate_task_ids");
    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-first"]);
  });

  it("falls back to conservative when planned selection exceeds max tasks", async () => {
    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: "/tmp/repo",
      runDir: "/tmp/run",
      candidates: [
        readyTask("bd-first"),
        readyTask("bd-second"),
        readyTask("bd-third"),
      ],
      batchStrategy: "planned",
      maxTasks: 2,
      batchPlanner: async () =>
        plannerStdout({
          selectedTaskIds: ["bd-first", "bd-second", "bd-third"],
        }),
    });

    expect(result.fallbackReason).toBe("over_max_tasks");
    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-first"]);
  });

  it("falls back to conservative when planned selection is empty", async () => {
    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: "/tmp/repo",
      runDir: "/tmp/run",
      candidates: [readyTask("bd-first"), readyTask("bd-second")],
      batchStrategy: "planned",
      maxTasks: 3,
      batchPlanner: async () =>
        plannerStdout({
          selectedTaskIds: [],
        }),
    });

    expect(result.fallbackReason).toBe("empty_selection");
    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-first"]);
  });
});
