import { describe, expect, it } from "vitest";

import { HubFlowError } from "./errors.js";
import {
  HUB_BATCH_DEFAULT_MAX_TASKS,
  HUB_BATCH_MAX_TASKS_UPPER_LIMIT,
  parseHubBatchMaxTasks,
  parseHubBatchStrategy,
  planHubFlowBatch,
  resolveHubBatchSelectionOptions,
  selectHubFlowTasksWithBatchOptions,
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

  it("parses conservative and limited batch strategies", () => {
    expect(parseHubBatchStrategy("conservative")).toBe("conservative");
    expect(parseHubBatchStrategy(" Conservative ")).toBe("conservative");
    expect(parseHubBatchStrategy("limited")).toBe("limited");
    expect(parseHubBatchStrategy(" Limited ")).toBe("limited");
    expect(() => parseHubBatchStrategy("planned")).toThrow(HubFlowError);
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

  it("selects only the first eligible ready task for conservative strategy", () => {
    const candidates = [
      readyTask("bd-first"),
      readyTask("bd-second"),
      readyTask("bd-claimed", { claimState: "active" }),
      readyTask("bd-human", { hubStatus: "ready_for_human" }),
    ];

    const result = planHubFlowBatch({
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

  it("preserves ready queue order for conservative selection", () => {
    const { selectedTasks } = selectHubFlowTasksWithBatchOptions({
      candidates: [readyTask("bd-a"), readyTask("bd-b"), readyTask("bd-c")],
      batchStrategy: "conservative",
      maxTasks: 3,
    });

    expect(selectedTasks.map((task) => task.id)).toEqual(["bd-a"]);
  });

  it("selects at most max-tasks eligible ready tasks for limited strategy", () => {
    const candidates = [
      readyTask("bd-first"),
      readyTask("bd-second"),
      readyTask("bd-third"),
      readyTask("bd-claimed", { claimState: "active" }),
      readyTask("bd-human", { hubStatus: "ready_for_human" }),
    ];

    const result = planHubFlowBatch({
      candidates,
      batchStrategy: "limited",
      maxTasks: 2,
    });

    expect(result.selectedTasks.map((task) => task.id)).toEqual([
      "bd-first",
      "bd-second",
    ]);
    expect(result.deferredTasks).toEqual([
      { taskId: "bd-third", reason: "over_max_tasks" },
    ]);
    expect(result.batchStrategyUsed).toBe("limited");
  });

  it("limited selection follows ready queue order rather than task id order", () => {
    const candidates = [
      readyTask("bd-z-last-alphabetically"),
      readyTask("bd-m-middle"),
      readyTask("bd-a-first-alphabetically"),
    ];

    const result = planHubFlowBatch({
      candidates,
      batchStrategy: "limited",
      maxTasks: 2,
    });

    expect(result.selectedTasks.map((task) => task.id)).toEqual([
      "bd-z-last-alphabetically",
      "bd-m-middle",
    ]);
  });
});
