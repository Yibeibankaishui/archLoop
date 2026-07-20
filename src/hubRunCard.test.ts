import { describe, expect, it } from "vitest";

import type { HubRunDisplayState } from "./hubRunDisplay.js";
import {
  buildRunCardSectionModel,
  resolveHubIdByPrefix,
  runCardModelToBlocks,
  shortHubId,
  type BuildRunCardSectionModelInput,
} from "./hubRunCard.js";

const baseState = (): HubRunDisplayState => ({
  hubProjectName: "autotuneagent",
  flowId: "with-review",
  runId: "run-74cc88e3-6757-4472-b152-f5cf151be9d3",
  runDir:
    "/home/bai/.local/share/archloop/hub/projects/8b382f29c45d/runs/run-74cc88e3-6757-4472-b152-f5cf151be9d3",
  status: "running",
  completedBatchCount: 0,
  completedTaskCount: 0,
  batches: {},
  tasks: {},
  seenEventIds: new Set(),
  eventSequences: { batches: {}, tasks: {} },
});

const build = (
  overrides: Partial<BuildRunCardSectionModelInput> & {
    readonly kind: BuildRunCardSectionModelInput["kind"];
  },
) =>
  buildRunCardSectionModel({
    state: baseState(),
    nowMs: 0,
    startedAtMs: 0,
    phaseStartedAtMs: 0,
    ...overrides,
  });

describe("shortHubId", () => {
  it("takes the leading 8 chars of the UUID portion", () => {
    expect(shortHubId("run-74cc88e3-6757-4472-b152-f5cf151be9d3")).toBe(
      "74cc88e3",
    );
    expect(shortHubId("batch-daca6200-3d0a-4e48-86b4-4253a24b4056")).toBe(
      "daca6200",
    );
    expect(shortHubId("74cc88e3-6757-4472-b152-f5cf151be9d3")).toBe("74cc88e3");
  });
});

describe("resolveHubIdByPrefix", () => {
  const ids = [
    "run-74cc88e3-6757-4472-b152-f5cf151be9d3",
    "run-74cc99aa-1111-2222-3333-444455556666",
    "run-aabbccdd-0000-1111-2222-333344445555",
  ];

  it("resolves an unambiguous 8-char prefix", () => {
    expect(resolveHubIdByPrefix(ids, "aabbccdd")).toBe(ids[2]);
    expect(resolveHubIdByPrefix(ids, "run-aabbccdd")).toBe(ids[2]);
  });

  it("accepts the full id", () => {
    expect(resolveHubIdByPrefix(ids, ids[0]!)).toBe(ids[0]);
  });

  it("errors with candidates when the prefix is ambiguous", () => {
    expect(() => resolveHubIdByPrefix(ids, "74cc")).toThrow(
      /matches 2 runs — pass the full id/,
    );
    expect(() => resolveHubIdByPrefix(ids, "74cc")).toThrow(/74cc88e3/);
    expect(() => resolveHubIdByPrefix(ids, "74cc")).toThrow(/74cc99aa/);
  });
});

describe("buildRunCardSectionModel", () => {
  it("emits run.started header + logs tip footer and waiting spinner text", () => {
    const model = build({ kind: "run.started" });

    expect(model.kind).toBe("run.started");
    expect(model.header).toEqual({
      kind: "header",
      title: "archLoop",
      subtitle: "autotuneagent · with-review",
      right: "run 74cc88e3 · 0s",
    });
    expect(model.batches).toEqual([]);
    expect(model.footer).toEqual({
      kind: "footer",
      label: "tip",
      commands: ["…/runs/run-74cc88e3/", "press o to open · l to tail"],
    });
    expect(model.spinnerText).toBe("◐ waiting · plan · 0s · run 74cc88e3");
  });

  it("collapses completed batches on batch.started and shows the new current batch", () => {
    const state: HubRunDisplayState = {
      ...baseState(),
      batches: {
        "batch-daca6200-3d0a-4e48-86b4-4253a24b4056": {
          batchId: "batch-daca6200-3d0a-4e48-86b4-4253a24b4056",
          selectedTaskIds: ["AutoTuneAgent-2mr"],
          status: "done",
          stage: "Completed",
        },
        "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b": {
          batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
          selectedTaskIds: ["AutoTuneAgent-abc"],
          status: "planning",
          stage: "Planning",
        },
      },
    };

    const model = build({
      kind: "batch.started",
      state,
      nowMs: 60_000,
      phaseStartedAtMs: 60_000,
      batchDurationsMs: {
        "batch-daca6200-3d0a-4e48-86b4-4253a24b4056": 17 * 60_000 + 26_000,
      },
    });

    expect(model.batches).toHaveLength(2);
    expect(model.batches[0]).toEqual({
      kind: "collapsed",
      summary: "✓ batch daca6200   1 task   done · 17:26",
    });
    expect(model.batches[1]).toMatchObject({
      kind: "current",
      line: {
        kind: "group",
        symbol: "◐",
        name: "batch fd3cdf79",
        count: 1,
        rightHint: "planning",
        items: [],
      },
    });
    expect(model.spinnerText).toBe(
      "◐ batch fd3cdf79 · planning · 0s · run 74cc88e3",
    );
  });

  it("shows the active task indented-block on task.started", () => {
    const state: HubRunDisplayState = {
      ...baseState(),
      batches: {
        "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b": {
          batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
          selectedTaskIds: ["AutoTuneAgent-2mr"],
          taskTitles: {
            "AutoTuneAgent-2mr":
              "Slice 2: Remove TaskOrchestrator and legacy Test Task model",
          },
          status: "planning",
          stage: "Planning",
        },
      },
      tasks: {
        "AutoTuneAgent-2mr": {
          taskId: "AutoTuneAgent-2mr",
          batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
          status: "implementing",
          stage: "Implementing",
        },
      },
    };

    const model = build({
      kind: "task.started",
      state,
      nowMs: 0,
      phaseStartedAtMs: 0,
      activeTaskId: "AutoTuneAgent-2mr",
    });

    expect(model.batches).toHaveLength(1);
    const current = model.batches[0];
    expect(current).toMatchObject({
      kind: "current",
      current: {
        kind: "indented-block",
        leading: "↳",
        leadingSeverity: "info",
        id: "AutoTuneAgent-2mr",
        title:
          "Slice 2: Remove TaskOrchestrator and legacy Test Task model",
        subLines: ["implementing · 0s in this step"],
      },
    });
    expect(model.spinnerText).toBe(
      "◐ AutoTuneAgent-2mr · implementing · 0s · run 74cc88e3",
    );
  });

  it("emits run.failed with ✗ section and retry fix footer", () => {
    const state: HubRunDisplayState = {
      ...baseState(),
      status: "failed",
      batches: {
        "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b": {
          batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
          selectedTaskIds: ["AutoTuneAgent-2mr"],
          taskTitles: {
            "AutoTuneAgent-2mr": "Slice 2",
          },
          status: "partial_failed",
          stage: "Completed with failures",
        },
      },
      tasks: {
        "AutoTuneAgent-2mr": {
          taskId: "AutoTuneAgent-2mr",
          batchId: "batch-fd3cdf79-1786-4647-8899-d5f80fd8255b",
          status: "failed",
          stage: "Failed",
          detail: {
            taskId: "AutoTuneAgent-2mr",
            stage: "Implementation failed",
            diagnostic: "typecheck failed after 3 retries · exit=2",
          },
        },
      },
    };

    const model = build({
      kind: "run.failed",
      state,
      nowMs: 29 * 60_000 + 30_000,
      failureReason: "typecheck failed after 3 retries · exit=2",
      activeTaskId: "AutoTuneAgent-2mr",
    });

    expect(model.header.right).toBe("run 74cc88e3 · ✗ 29m30s");
    expect(model.spinnerText).toBeUndefined();
    expect(model.footer).toEqual({
      kind: "footer",
      label: "fix",
      command: "archloop run --resume 74cc88e3 --only-failed",
    });
    const blocks = runCardModelToBlocks(model);
    expect(blocks.some((b) => b.kind === "indented-block")).toBe(true);
  });
});
