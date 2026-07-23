import { describe, expect, it } from "vitest";

import {
  detectInterruptedHubTaskExecutions,
  findWorktreeLeaseForTask,
  isInterruptedHubTaskExecution,
  type InterruptedExecutionDetection,
  type InterruptedExecutionPhase,
} from "./hubTaskInterruptedExecutionDetector.js";
import type { HubTaskProjection } from "./taskBoard.js";
import type { WorktreeLeaseRecord } from "./worktreeLeaseStore.js";

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

const claim = (branch: string) => ({
  runId: "run-1",
  batchId: "batch-1",
  branch,
  claimedAt: "2026-06-22T10:00:00.000Z",
  raw: {},
});

const branchFor = (task: Pick<HubTaskProjection, "id" | "title">): string =>
  `archloop/${task.id}-${task.title.toLowerCase().replace(/\s+/g, "-")}`;

const INTERRUPTED_PHASES: readonly InterruptedExecutionPhase[] = [
  "implementing",
  "reviewing",
  "merging",
];

describe("isInterruptedHubTaskExecution", () => {
  describe.each(INTERRUPTED_PHASES)("execution status %s", (hubStatus) => {
    it("is interrupted when there is no worktree lease for the branch", () => {
      const task = createTask({
        id: "bd-1",
        title: "Killed run",
        hubStatus,
        claim: claim("archloop/bd-1-killed-run"),
      });

      const result = isInterruptedHubTaskExecution(task, undefined);
      expect(result).toEqual<InterruptedExecutionDetection>({
        interrupted: true,
        phase: hubStatus,
      });
    });

    it("is interrupted when the worktree lease is stale", () => {
      const branch = "archloop/bd-1-killed-run";
      const task = createTask({
        id: "bd-1",
        title: "Killed run",
        hubStatus,
        claim: claim(branch),
      });
      const lease = createLease({ branch, state: "stale" });

      const result = isInterruptedHubTaskExecution(task, lease);
      expect(result).toEqual<InterruptedExecutionDetection>({
        interrupted: true,
        phase: hubStatus,
      });
    });

    it("is not interrupted when the worktree lease is active", () => {
      const branch = "archloop/bd-1-live-run";
      const task = createTask({
        id: "bd-1",
        title: "Live run",
        hubStatus,
        claim: claim(branch),
      });
      const lease = createLease({ branch, state: "active" });

      const result = isInterruptedHubTaskExecution(task, lease);
      expect(result).toEqual<InterruptedExecutionDetection>({
        interrupted: false,
        phase: undefined,
      });
    });
  });

  it("treats a malformed lease as stale (interrupted), since a corrupt lease cannot prove a live execution", () => {
    const branch = "archloop/bd-1-corrupt-lease";
    const task = createTask({
      id: "bd-1",
      title: "Corrupt lease",
      hubStatus: "implementing",
      claim: claim(branch),
    });
    const lease = createLease({
      branch,
      state: "stale",
      malformed: true,
      pid: -1,
    });

    const result = isInterruptedHubTaskExecution(task, lease);
    expect(result.interrupted).toBe(true);
    expect(result.phase).toBe("implementing");
  });

  describe("non-execution statuses are never interrupted", () => {
    it.each([
      "inbox",
      "needs_info",
      "ready_for_agent",
      "ready_for_human",
      "blocked",
      "waiting_for_merge",
      "done",
      "wontfix",
      "failed",
      "sync_conflict",
    ])("is not interrupted for hub status %s with no lease", (hubStatus) => {
      const task = createTask({
        id: "bd-2",
        title: "Idle task",
        hubStatus: hubStatus as HubTaskProjection["hubStatus"],
      });

      const result = isInterruptedHubTaskExecution(task, undefined);
      expect(result).toEqual<InterruptedExecutionDetection>({
        interrupted: false,
        phase: undefined,
      });
    });

    it.each(["ready_for_agent", "waiting_for_merge", "failed"])(
      "is not interrupted for hub status %s even with a stale lease",
      (hubStatus) => {
        const branch = "archloop/bd-2-idle-task";
        const task = createTask({
          id: "bd-2",
          title: "Idle task",
          hubStatus: hubStatus as HubTaskProjection["hubStatus"],
          claim: claim(branch),
        });
        const lease = createLease({ branch, state: "stale" });

        const result = isInterruptedHubTaskExecution(task, lease);
        expect(result.interrupted).toBe(false);
        expect(result.phase).toBeUndefined();
      },
    );
  });

  describe("does not rely on claimState alone", () => {
    it("flags a reviewing task with claimState 'stale' and an active lease as NOT interrupted (legitimate in-progress review)", () => {
      // claimState currently misclassifies reviewing/merging as stale even
      // mid-legitimate-execution (see the isHubTaskClaimActive fix). The
      // detector must trust the live lease, not claimState.
      const branch = "archloop/bd-3-active-review";
      const task = createTask({
        id: "bd-3",
        title: "Active review",
        hubStatus: "reviewing",
        claimState: "stale",
        claim: claim(branch),
      });
      const lease = createLease({ branch, state: "active" });

      const result = isInterruptedHubTaskExecution(task, lease);
      expect(result.interrupted).toBe(false);
    });

    it("flags a merging task with claimState 'stale' and an active lease as NOT interrupted (legitimate in-progress merge)", () => {
      const branch = "archloop/bd-4-active-merge";
      const task = createTask({
        id: "bd-4",
        title: "Active merge",
        hubStatus: "merging",
        claimState: "stale",
        claim: claim(branch),
      });
      const lease = createLease({ branch, state: "active" });

      const result = isInterruptedHubTaskExecution(task, lease);
      expect(result.interrupted).toBe(false);
    });

    it("flags an implementing task with no claim at all but a stale lease as interrupted (claimState alone would say 'not interrupted' because there is no claim)", () => {
      const branch = "archloop/bd-5-orphan-lease";
      const task = createTask({
        id: "bd-5",
        title: "Orphan lease",
        hubStatus: "implementing",
        claim: undefined,
        claimState: undefined,
      });
      const lease = createLease({ branch, state: "stale" });

      const result = isInterruptedHubTaskExecution(task, lease);
      expect(result.interrupted).toBe(true);
      expect(result.phase).toBe("implementing");
    });
  });
});

describe("findWorktreeLeaseForTask", () => {
  it("matches a lease by the claim branch", () => {
    const branch = "archloop/bd-1-by-branch";
    const task = createTask({
      id: "bd-1",
      title: "By branch",
      hubStatus: "implementing",
      claim: claim(branch),
    });
    const leases = [
      createLease({ branch: "archloop/other", state: "active" }),
      createLease({ branch, state: "stale" }),
    ];

    expect(findWorktreeLeaseForTask(task, leases)).toBe(leases[1]);
  });

  it("matches a lease by the task id on the hub owner when there is no branch claim", () => {
    const branch = "archloop/bd-2-derived-branch";
    const task = createTask({
      id: "bd-2",
      title: "Derived branch",
      hubStatus: "implementing",
      claim: undefined,
    });
    const lease = createLease({
      branch,
      state: "stale",
      owner: { kind: "hub", taskId: "bd-2" },
    });

    expect(findWorktreeLeaseForTask(task, [lease])).toBe(lease);
  });

  it("matches a lease by the derived worktree name when there is no claim and no owner task id", () => {
    const task = createTask({
      id: "bd-3",
      title: "Derived worktree",
      hubStatus: "implementing",
      claim: undefined,
    });
    const branch = branchFor(task);
    const lease = createLease({ branch, state: "stale" });

    expect(findWorktreeLeaseForTask(task, [lease])).toBe(lease);
  });

  it("returns undefined when no lease matches the task", () => {
    const task = createTask({
      id: "bd-4",
      title: "No lease",
      hubStatus: "implementing",
      claim: claim("archloop/bd-4-no-lease"),
    });

    expect(findWorktreeLeaseForTask(task, [])).toBeUndefined();
  });
});

describe("detectInterruptedHubTaskExecutions", () => {
  it("returns only the interrupted tasks with their stuck phase", () => {
    const activeImplementingBranch = "archloop/bd-1-active";
    const staleReviewingBranch = "archloop/bd-2-stale";
    const liveReadyBranch = "archloop/bd-3-ready";

    const tasks = [
      createTask({
        id: "bd-1",
        title: "Active implementing",
        hubStatus: "implementing",
        claim: claim(activeImplementingBranch),
      }),
      createTask({
        id: "bd-2",
        title: "Stale reviewing",
        hubStatus: "reviewing",
        claim: claim(staleReviewingBranch),
      }),
      createTask({
        id: "bd-3",
        title: "Ready agent",
        hubStatus: "ready_for_agent",
        claim: claim(liveReadyBranch),
      }),
    ];
    const leases = [
      createLease({ branch: activeImplementingBranch, state: "active" }),
      createLease({ branch: staleReviewingBranch, state: "stale" }),
      createLease({ branch: liveReadyBranch, state: "active" }),
    ];

    const detected = detectInterruptedHubTaskExecutions(tasks, leases);
    expect(detected).toEqual([
      expect.objectContaining({
        taskId: "bd-2",
        phase: "reviewing",
      }),
    ]);
  });

  it("flags an executing task with no lease at all as interrupted", () => {
    const tasks = [
      createTask({
        id: "bd-9",
        title: "No lease implementing",
        hubStatus: "implementing",
        claim: claim("archloop/bd-9-no-lease"),
      }),
    ];

    const detected = detectInterruptedHubTaskExecutions(tasks, []);
    expect(detected).toEqual([
      expect.objectContaining({
        taskId: "bd-9",
        phase: "implementing",
      }),
    ]);
  });

  it("returns an empty list when every executing task has a live lease", () => {
    const branch = "archloop/bd-7-live";
    const tasks = [
      createTask({
        id: "bd-7",
        title: "Live implementing",
        hubStatus: "implementing",
        claim: claim(branch),
      }),
    ];
    const leases = [createLease({ branch, state: "active" })];

    expect(detectInterruptedHubTaskExecutions(tasks, leases)).toEqual([]);
  });
});
