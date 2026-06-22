import { describe, expect, it } from "vitest";

import {
  buildHubWorktreeLeaseDiagnostic,
  collectHubWorktreeLeaseDiagnosticsForTasks,
} from "./hubWorktreeLeaseDiagnostics.js";
import type { HubTaskProjection } from "./taskBoard.js";
import type { WorktreeLeaseRecord } from "./worktreeLease.js";

const createTask = (
  overrides: Partial<HubTaskProjection> &
    Pick<HubTaskProjection, "id" | "title">,
): HubTaskProjection => ({
  beadsStatus: "open",
  hubStatus: "inbox",
  claim: undefined,
  claimState: undefined,
  labels: [],
  metadata: {},
  description: undefined,
  notes: undefined,
  comments: [],
  remoteRefs: [],
  runRefs: [],
  ...overrides,
});

const createLease = (
  overrides: Partial<WorktreeLeaseRecord> &
    Pick<WorktreeLeaseRecord, "branch" | "state">,
): WorktreeLeaseRecord => ({
  lockFileName: "archloop-bd-1-task.lock",
  worktreeName: "archloop-bd-1-task",
  pid: 4242,
  acquiredAt: "2026-06-22T10:00:00.000Z",
  malformed: false,
  ...overrides,
});

describe("hubWorktreeLeaseDiagnostics", () => {
  it("reports claim active plus lease active with wait guidance", () => {
    const task = createTask({
      id: "bd-1",
      title: "Active task",
      hubStatus: "implementing",
      claimState: "active",
      claim: {
        runId: "run-1",
        batchId: "batch-1",
        branch: "archloop/bd-1-active-task",
        claimedAt: "2026-06-22T10:00:00.000Z",
        raw: {},
      },
    });
    const lease = createLease({
      branch: "archloop/bd-1-active-task",
      state: "active",
      owner: {
        kind: "hub",
        taskId: "bd-1",
        flowId: "no-review",
        batchId: "batch-1",
        runId: "run-1",
      },
    });

    const diagnostic = buildHubWorktreeLeaseDiagnostic(task, lease);
    expect(diagnostic).toEqual(
      expect.objectContaining({
        reason: "worktree_lease_active_execution",
        claimState: "active",
        leaseState: "active",
        nextAction: expect.stringContaining("Wait"),
      }),
    );
  });

  it("reports claim active plus no lease with rerun guidance", () => {
    const task = createTask({
      id: "bd-2",
      title: "Missing lease",
      hubStatus: "implementing",
      claimState: "active",
      claim: {
        runId: "run-2",
        batchId: "batch-2",
        branch: "archloop/bd-2-missing-lease",
        claimedAt: "2026-06-22T10:00:00.000Z",
        raw: {},
      },
    });

    const diagnostic = buildHubWorktreeLeaseDiagnostic(task, undefined);
    expect(diagnostic).toEqual(
      expect.objectContaining({
        reason: "worktree_lease_missing",
        claimState: "active",
        leaseState: "missing",
        nextAction: expect.stringContaining("Rerun the flow"),
      }),
    );
  });

  it("reports failed claim plus active lease with wait guidance", () => {
    const task = createTask({
      id: "bd-3",
      title: "Failed but running",
      hubStatus: "failed",
      claimState: "stale",
      claim: {
        runId: "run-3",
        batchId: "batch-3",
        branch: "archloop/bd-3-failed-but-running",
        claimedAt: "2026-06-22T10:00:00.000Z",
        raw: {},
      },
    });
    const lease = createLease({
      branch: "archloop/bd-3-failed-but-running",
      state: "active",
      owner: { kind: "hub", taskId: "bd-3" },
    });

    const diagnostic = buildHubWorktreeLeaseDiagnostic(task, lease);
    expect(diagnostic).toEqual(
      expect.objectContaining({
        reason: "worktree_lease_active_with_failed_claim",
        claimState: "stale",
        leaseState: "active",
        nextAction: expect.stringContaining("Wait"),
      }),
    );
  });

  it("reports failed claim plus stale lease with recover guidance", () => {
    const task = createTask({
      id: "bd-4",
      title: "Failed stale",
      hubStatus: "failed",
      claimState: "stale",
      claim: {
        runId: "run-4",
        batchId: "batch-4",
        branch: "archloop/bd-4-failed-stale",
        claimedAt: "2026-06-22T10:00:00.000Z",
        raw: {},
      },
    });
    const lease = createLease({
      branch: "archloop/bd-4-failed-stale",
      state: "stale",
      owner: { kind: "hub", taskId: "bd-4" },
    });

    const diagnostic = buildHubWorktreeLeaseDiagnostic(task, lease);
    expect(diagnostic).toEqual(
      expect.objectContaining({
        reason: "worktree_lease_stale_with_failed_claim",
        claimState: "stale",
        leaseState: "stale",
        nextAction: expect.stringContaining("archloop tasks recover bd-4"),
      }),
    );
  });

  it("reports lease active without Hub claim", () => {
    const task = createTask({
      id: "bd-5",
      title: "Ready task",
      hubStatus: "ready_for_agent",
      claimState: undefined,
    });
    const lease = createLease({
      branch: "archloop/bd-5-ready-task",
      state: "active",
      owner: { kind: "hub", taskId: "bd-5" },
    });

    const diagnostics = collectHubWorktreeLeaseDiagnosticsForTasks(
      [task],
      [lease],
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        taskId: "bd-5",
        reason: "worktree_lease_active_without_claim",
        claimState: "missing",
        leaseState: "active",
        nextAction: expect.stringContaining("Wait"),
      }),
    );
  });
});
