import { describe, expect, it } from "vitest";

import { HubFlowError } from "./errors.js";
import {
  HUB_BATCH_DEFAULT_MAX_TASKS,
  HUB_BATCH_DEFAULT_STRATEGY,
  HUB_BATCH_MAX_TASKS_UPPER_LIMIT,
  parseHubBatchMaxTasks,
  parseHubBatchPlannerOutput,
  parseHubBatchStrategy,
  planHubFlowBatch,
  resolveEffectiveHubBatchSelection,
  resolveFreshValidatedHubBatchSelection,
  resolveHubBatchSelectionOptions,
  selectHubFlowTasksWithBatchOptions,
  validateHubBatchPlannerOutput,
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

const plannerStdout = (output: {
  readonly selectedTaskIds: readonly string[];
  readonly deferred?: readonly {
    readonly taskId: string;
    readonly reason: string;
  }[];
  readonly rationale?: string;
}): string =>
  `<batch-plan>${JSON.stringify({
    deferred: [],
    ...output,
  })}</batch-plan>`;

const createTempHubTaskStoreRepo = async (input: {
  readonly listRecords: readonly unknown[];
}): Promise<{ repoDir: string; env: NodeJS.ProcessEnv }> => {
  const { mkdtemp, writeFile, mkdir, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-planner-"));
  await execAsync("git init -b main", { cwd: repoDir });
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "ready" && args.includes("--json")) {
  const records = ${JSON.stringify(input.listRecords)}.filter(
    (task) => task.status === "open" && task.labels?.includes("ready-for-agent"),
  );
  process.stdout.write(JSON.stringify(records));
  process.exit(0);
}
if (args[0] === "list" && args.includes("--json")) {
  process.stdout.write(JSON.stringify(${JSON.stringify(input.listRecords)}));
  process.exit(0);
}
process.exit(1);
`,
  );
  await chmod(bdPath, 0o755);
  await mkdir(join(repoDir, ".beads"), { recursive: true });
  await writeFile(
    join(repoDir, ".beads", "metadata.json"),
    JSON.stringify({ backend: "dolt" }),
  );

  return {
    repoDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCHLOOP_BD_PATH: bdPath,
    },
  };
};

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
    expect(parseHubBatchStrategy(" Limited ")).toBe("limited");
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

  it("selects ready queue order up to max tasks for limited strategy", async () => {
    const candidates = [
      readyTask("bd-a"),
      readyTask("bd-b"),
      readyTask("bd-c"),
      readyTask("bd-d"),
    ];

    const result = await planHubFlowBatch({
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

  it("falls back to conservative when planned strategy has no planner", async () => {
    const candidates = [readyTask("bd-a"), readyTask("bd-b")];

    const result = await planHubFlowBatch({
      candidates,
      batchStrategy: "planned",
      maxTasks: HUB_BATCH_DEFAULT_MAX_TASKS,
    });

    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-a"]);
    expect(result.batchStrategyRequested).toBe("planned");
    expect(result.batchStrategyUsed).toBe("conservative");
    expect(result.fallbackReason).toBe("planner_unavailable");
  });

  it("preserves ready queue order for conservative selection", async () => {
    const { selectedTasks } = await selectHubFlowTasksWithBatchOptions({
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

  it("falls back to conservative selection when fresh validation fails", async () => {
    const initialBatchSelection = await planHubFlowBatch({
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

  it("recovers invalid explicit_blocker deferrals when the candidate has no effective blockers", async () => {
    const { repoDir, env } = await createTempHubTaskStoreRepo({
      listRecords: [
        {
          id: "bd-github-152",
          title: "Closed blocker",
          hub_status: "done",
          remoteRefs: [{ url: "github#152" }],
        },
        {
          id: "bd-first",
          title: "First ready task",
          status: "open",
          labels: ["ready-for-agent"],
          metadata: {},
        },
        {
          id: "bd-second",
          title: "Second ready task",
          status: "open",
          labels: ["ready-for-agent"],
          metadata: {},
          description: "## Blocked by\n\n- #152",
        },
        {
          id: "bd-third",
          title: "Third ready task",
          status: "open",
          labels: ["ready-for-agent"],
          metadata: {},
          description: "## Blocked by\n\n- #152",
        },
      ],
    });

    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: repoDir,
      env,
      runDir: "/tmp/run",
      candidates: [
        readyTask("bd-first"),
        readyTask("bd-second", {
          description: "## Blocked by\n\n- #152",
        }),
        readyTask("bd-third", {
          description: "## Blocked by\n\n- #152",
        }),
      ],
      batchStrategy: "planned",
      maxTasks: 3,
      batchPlanner: async () =>
        plannerStdout({
          selectedTaskIds: ["bd-first"],
          deferred: [
            { taskId: "bd-second", reason: "explicit_blocker" },
            { taskId: "bd-third", reason: "explicit_blocker" },
          ],
        }),
    });

    expect(result.batchStrategyUsed).toBe("planned");
    expect(result.selectedTasks.map((task) => task.id)).toEqual([
      "bd-first",
      "bd-second",
      "bd-third",
    ]);
    expect(result.deferredTasks).toEqual([]);
    expect(result.diagnosticReason).toBe("invalid_explicit_blocker_deferral");
  });

  it("keeps explicit_blocker deferrals when the candidate is a dependency of a selected task", async () => {
    const { repoDir, env } = await createTempHubTaskStoreRepo({
      listRecords: [
        {
          id: "bd-first",
          title: "First ready task",
          status: "open",
          labels: ["ready-for-agent"],
          metadata: {},
          description: "## Blocked by\n\n- bd-second",
        },
        {
          id: "bd-second",
          title: "Second ready task",
          status: "open",
          labels: ["ready-for-agent"],
          metadata: {},
        },
      ],
    });

    const result = await planHubFlowBatch({
      flowId: "no-review",
      cwd: repoDir,
      env,
      runDir: "/tmp/run",
      candidates: [
        readyTask("bd-first", {
          description: "## Blocked by\n\n- bd-second",
        }),
        readyTask("bd-second"),
      ],
      batchStrategy: "planned",
      maxTasks: 3,
      batchPlanner: async () =>
        plannerStdout({
          selectedTaskIds: ["bd-first"],
          deferred: [{ taskId: "bd-second", reason: "explicit_blocker" }],
        }),
    });

    expect(result.selectedTasks.map((task) => task.id)).toEqual(["bd-first"]);
    expect(result.deferredTasks).toEqual([
      { taskId: "bd-second", reason: "explicit_blocker" },
    ]);
    expect(result.diagnosticReason).toBeUndefined();
  });

  it("selects at most max-tasks eligible ready tasks for limited strategy", async () => {
    const candidates = [
      readyTask("bd-first"),
      readyTask("bd-second"),
      readyTask("bd-third"),
      readyTask("bd-claimed", { claimState: "active" }),
      readyTask("bd-human", { hubStatus: "ready_for_human" }),
    ];

    const result = await planHubFlowBatch({
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

  it("limited selection follows ready queue order rather than task id order", async () => {
    const candidates = [
      readyTask("bd-z-last-alphabetically"),
      readyTask("bd-m-middle"),
      readyTask("bd-a-first-alphabetically"),
    ];

    const result = await planHubFlowBatch({
      candidates,
      batchStrategy: "limited",
      maxTasks: 2,
    });

    expect(result.selectedTasks.map((task) => task.id)).toEqual([
      "bd-z-last-alphabetically",
      "bd-m-middle",
    ]);
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
