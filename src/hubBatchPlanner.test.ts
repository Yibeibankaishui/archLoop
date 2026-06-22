import { describe, expect, it } from "vitest";

import { HubFlowError } from "./errors.js";
import {
  HUB_BATCH_DEFAULT_MAX_TASKS,
  HUB_BATCH_DEFAULT_STRATEGY,
  HUB_BATCH_MAX_TASKS_UPPER_LIMIT,
  parseHubBatchMaxTasks,
  parseHubBatchStrategy,
  planHubFlowBatch,
  resolveFreshValidatedHubBatchSelection,
  resolveEffectiveHubBatchSelection,
  resolveHubBatchSelectionOptions,
  selectHubFlowTasksWithBatchOptions,
  validateHubBatchSelectionFreshness,
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

  it("parses planned, limited, and conservative batch strategies", () => {
    expect(parseHubBatchStrategy("planned")).toBe("planned");
    expect(parseHubBatchStrategy("limited")).toBe("limited");
    expect(parseHubBatchStrategy("conservative")).toBe("conservative");
    expect(parseHubBatchStrategy(" Conservative ")).toBe("conservative");
    expect(() => parseHubBatchStrategy("random")).toThrow(HubFlowError);
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

  it("defaults task-board flows to planned strategy and max 3 tasks", () => {
    expect(
      resolveHubBatchSelectionOptions({
        flowKind: "task-board",
      }),
    ).toEqual({
      batchStrategy: HUB_BATCH_DEFAULT_STRATEGY,
      maxTasks: HUB_BATCH_DEFAULT_MAX_TASKS,
    });

    expect(
      resolveEffectiveHubBatchSelection({
        flowKind: "task-board",
      }),
    ).toEqual({
      batchStrategy: HUB_BATCH_DEFAULT_STRATEGY,
      maxTasks: HUB_BATCH_DEFAULT_MAX_TASKS,
    });
  });

  it("allows overriding task-board batch strategy and max tasks", () => {
    expect(
      resolveHubBatchSelectionOptions({
        flowKind: "task-board",
        batchStrategy: "limited",
        maxTasks: "2",
      }),
    ).toEqual({
      batchStrategy: "limited",
      maxTasks: 2,
    });

    expect(
      resolveHubBatchSelectionOptions({
        flowKind: "task-board",
        maxTasks: "5",
      }),
    ).toEqual({
      batchStrategy: HUB_BATCH_DEFAULT_STRATEGY,
      maxTasks: 5,
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

  it("selects ready queue order up to max tasks for limited strategy", () => {
    const candidates = [
      readyTask("bd-a"),
      readyTask("bd-b"),
      readyTask("bd-c"),
      readyTask("bd-d"),
    ];

    const result = planHubFlowBatch({
      candidates,
      batchStrategy: "limited",
      maxTasks: 2,
    });

    expect(result.selectedTasks.map((task) => task.id)).toEqual([
      "bd-a",
      "bd-b",
    ]);
    expect(result.deferredTasks).toEqual([
      { taskId: "bd-c", reason: "over_max_tasks" },
      { taskId: "bd-d", reason: "over_max_tasks" },
    ]);
    expect(result.batchStrategyUsed).toBe("limited");
  });

  it("falls back to conservative when planned strategy has no planner", () => {
    const candidates = [readyTask("bd-a"), readyTask("bd-b")];

    const result = planHubFlowBatch({
      candidates,
      batchStrategy: "planned",
      maxTasks: HUB_BATCH_DEFAULT_MAX_TASKS,
    });

    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-a"]);
    expect(result.batchStrategyRequested).toBe("planned");
    expect(result.batchStrategyUsed).toBe("conservative");
    expect(result.fallbackReason).toBe("planner_unavailable");
  });

  it("preserves ready queue order for conservative selection", () => {
    const { selectedTasks } = selectHubFlowTasksWithBatchOptions({
      candidates: [readyTask("bd-a"), readyTask("bd-b"), readyTask("bd-c")],
      batchStrategy: "conservative",
      maxTasks: 3,
    });

    expect(selectedTasks.map((task) => task.id)).toEqual(["bd-a"]);
  });

  it("rejects duplicate selected task ids during fresh validation", () => {
    const result = validateHubBatchSelectionFreshness({
      selectedTaskIds: ["bd-a", "bd-a"],
      freshCandidates: [readyTask("bd-a"), readyTask("bd-b")],
      maxTasks: 3,
    });

    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("duplicate_selection");
  });

  it("rejects selections over the configured max task count", () => {
    const result = validateHubBatchSelectionFreshness({
      selectedTaskIds: ["bd-a", "bd-b"],
      freshCandidates: [readyTask("bd-a"), readyTask("bd-b")],
      maxTasks: 1,
    });

    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("over_max_tasks");
  });

  it("rejects selections outside the fresh candidate set", () => {
    const result = validateHubBatchSelectionFreshness({
      selectedTaskIds: ["bd-missing"],
      freshCandidates: [readyTask("bd-a")],
      maxTasks: 3,
    });

    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("not_in_candidate_set");
  });

  it("rejects tasks that are no longer ready_for_agent before claim", () => {
    const result = validateHubBatchSelectionFreshness({
      selectedTaskIds: ["bd-a"],
      freshCandidates: [
        readyTask("bd-a", { hubStatus: "ready_for_human" }),
        readyTask("bd-b"),
      ],
      maxTasks: 3,
    });

    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("not_ready_for_agent");
  });

  it("rejects tasks with active claims before claim", () => {
    const result = validateHubBatchSelectionFreshness({
      selectedTaskIds: ["bd-a"],
      freshCandidates: [
        readyTask("bd-a", { claimState: "active" }),
        readyTask("bd-b"),
      ],
      maxTasks: 3,
    });

    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("active_claim");
  });

  it("falls back to conservative selection when fresh validation fails", () => {
    const initialBatchSelection = planHubFlowBatch({
      candidates: [readyTask("bd-a"), readyTask("bd-b")],
      batchStrategy: "conservative",
      maxTasks: 3,
    });
    const freshCandidates = [
      readyTask("bd-a", { claimState: "active" }),
      readyTask("bd-b"),
    ];

    const resolved = resolveFreshValidatedHubBatchSelection({
      initialSelectedTaskIds: initialBatchSelection.selectedTasks.map(
        (task) => task.id,
      ),
      freshCandidates,
      batchStrategy: "conservative",
      maxTasks: 3,
      batchSelection: initialBatchSelection,
    });

    expect(resolved.selectedTasks.map((task) => task.id)).toEqual(["bd-b"]);
    expect(resolved.batchSelection).toMatchObject({
      batchStrategyRequested: "conservative",
      batchStrategyUsed: "conservative",
      fallbackReason: "active_claim",
    });
    expect(resolved.fallbackReason).toBe("active_claim");
  });
});
