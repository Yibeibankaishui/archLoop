import type { HubRunEventRecord } from "./hubRuntimeBridge.js";
import type {
  HubProjectRunSummary,
  HubProjectStatus,
} from "./projectStatus.js";
import type { HubTaskBoard, HubTaskProjection } from "./taskBoard.js";
import { HUB_TASK_STATUSES } from "./taskBoard.js";

export const HUB_DESKTOP_FIXTURE_REPO_ROOT = "/tmp/archloop-hub-fixture";

const fixtureTask = (
  overrides: Partial<HubTaskProjection> &
    Pick<HubTaskProjection, "id" | "title" | "hubStatus">,
): HubTaskProjection => ({
  beadsStatus: "open",
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

export const createHubDesktopFixtureTasks =
  (): readonly HubTaskProjection[] => [
    fixtureTask({
      id: "arch-1",
      title: "Wire project overview",
      hubStatus: "ready_for_agent",
      labels: ["hub-gui"],
      metadata: { sync_state: "synced" },
      remoteRefs: ["github#140"],
    }),
    fixtureTask({
      id: "arch-2",
      title: "Recover stale claim",
      hubStatus: "failed",
      labels: ["recovery"],
      metadata: {
        failure_reason: "agent_failed",
        sync_state: "push_pending",
      },
      comments: [
        {
          author: "operator",
          body: "Agent run failed during implementation.",
          createdAt: "2026-06-23T09:45:00.000Z",
        },
      ],
      runRefs: ["run-fixture-1"],
    }),
    fixtureTask({
      id: "arch-3",
      title: "Awaiting merge",
      hubStatus: "waiting_for_merge",
      claim: {
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        branch: "archloop/arch-3-awaiting-merge",
        claimedAt: "2026-06-23T10:00:00.000Z",
        raw: {},
      },
      claimState: "active",
      metadata: { sync_state: "synced" },
      runRefs: ["run-fixture-1"],
    }),
    fixtureTask({
      id: "arch-4",
      title: "Blocked by dependency",
      hubStatus: "blocked",
      labels: ["hub-gui"],
      metadata: {
        blocked_reason: "blocked by arch-1",
        blocked_by: "arch-1",
        sync_state: "local_only",
      },
    }),
    fixtureTask({
      id: "arch-5",
      title: "Remote-linked inbox task",
      hubStatus: "inbox",
      labels: ["prd-warning-medium"],
      metadata: {
        sync_state: "synced",
        slice_temp_id: "slice-5",
        warning_severity: "medium",
        warning_message: "Acceptance criteria need review",
        remote_refs: ["github#156"],
      },
      remoteRefs: ["github#156"],
      runRefs: ["run-proposal-fixture-1"],
      comments: [
        {
          author: "maintainer",
          body: "Needs clearer acceptance criteria before triage.",
          createdAt: "2026-06-23T08:00:00.000Z",
        },
      ],
    }),
  ];

export const createHubDesktopFixtureTaskBoard = (): HubTaskBoard => {
  const tasks = createHubDesktopFixtureTasks();
  return {
    tasks,
    groups: HUB_TASK_STATUSES.map((status) => ({
      status,
      tasks: tasks.filter((task) => task.hubStatus === status),
    })),
  };
};

export const createHubDesktopFixtureProjectStatus = (options?: {
  readonly includeStaleLeaseDiagnostic?: boolean;
}): HubProjectStatus => ({
  repoRoot: HUB_DESKTOP_FIXTURE_REPO_ROOT,
  archloopUserDataDir: "/tmp/archloop-user-data",
  hubProjectDir: "/tmp/archloop-user-data/projects/fixture",
  projectRegistered: true,
  beadsAvailable: true,
  taskStoreInitialized: true,
  taskCounts: { ready: 1, total: 5 },
  statusCounts: {
    inbox: 1,
    ready_for_agent: 1,
    blocked: 1,
    failed: 1,
    waiting_for_merge: 1,
  },
  failedTasks: [
    {
      id: "arch-2",
      title: "Recover stale claim",
      failureReason: "agent_failed",
      nextAction: "archloop tasks recover arch-2",
    },
  ],
  syncCounts: {
    pushPending: 0,
    conflict: 0,
    localOnly: 1,
    synced: 2,
  },
  activeBatches: [
    {
      runId: "run-fixture-1",
      batchId: "batch-fixture-1",
      runDir: "/tmp/archloop-user-data/projects/fixture/runs/run-fixture-1",
      status: "started",
      flowId: "with-review",
      taskCount: 1,
      active: true,
    },
  ],
  runDirectories: [
    "/tmp/archloop-user-data/projects/fixture/runs/run-fixture-1",
  ],
  recentEvents: [
    "run run-fixture-1 started flow with-review",
    "task arch-3 claimed on branch archloop/arch-3-awaiting-merge",
  ],
  worktreeLeaseDiagnostics: options?.includeStaleLeaseDiagnostic
    ? [
        {
          taskId: "arch-2",
          title: "Recover stale claim",
          reason: "worktree_lease_stale_with_failed_claim",
          message: "Worktree lease is stale while task arch-2 remains failed.",
          nextAction: "Recover arch-2 before reclaiming the worktree.",
          branch: "archloop/arch-2-recover-stale-claim",
          worktreeName: "archloop-arch-2-recover-stale-claim",
          leaseState: "stale",
          claimState: "stale",
        },
      ]
    : [],
});

const FIXTURE_RUN_DIR =
  "/tmp/archloop-user-data/projects/fixture/runs/run-fixture-1";

export const createHubDesktopFixtureRunSummaries = (options?: {
  readonly batchStatus?: HubProjectRunSummary["batches"][number]["status"];
}): readonly HubProjectRunSummary[] => [
  {
    runId: "run-fixture-1",
    runDir: FIXTURE_RUN_DIR,
    branch: "archloop/arch-3-awaiting-merge",
    startedAt: "2026-06-23T10:00:00.000Z",
    batches: [
      {
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        runDir: FIXTURE_RUN_DIR,
        status: options?.batchStatus ?? "merging",
        flowId: "with-review",
        taskCount: 1,
        active: options?.batchStatus !== "done",
      },
    ],
  },
];

export const createHubDesktopFixtureRunEvents = (options?: {
  readonly runDir?: string;
  readonly completed?: boolean;
  readonly includeMergeConflict?: boolean;
  readonly includeFailedTask?: boolean;
}): {
  readonly runDir: string;
  readonly events: readonly HubRunEventRecord[];
} => {
  const events: HubRunEventRecord[] = [
    {
      file: "run.jsonl",
      lineNumber: 1,
      event: {
        type: "run_started",
        runId: "run-fixture-1",
        branch: "archloop/arch-3-awaiting-merge",
        startedAt: "2026-06-23T10:00:00.000Z",
      },
    },
    {
      file: "batch.jsonl",
      lineNumber: 1,
      event: {
        type: "batch_started",
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        branch: "archloop/arch-3-awaiting-merge",
        startedAt: "2026-06-23T10:00:00.000Z",
      },
    },
    {
      file: "batch.jsonl",
      lineNumber: 2,
      event: {
        type: "batch_planned",
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        flowId: "with-review",
        createdAt: "2026-06-23T10:00:30.000Z",
        taskIds: ["arch-3"],
        batchStrategyUsed: "ready_queue",
        rationale: "Fixture batch for desktop run workbench",
        commits: ["c79d9a4", "71b7bec"],
        deferredTasks: [{ taskId: "arch-4", reason: "blocked_dependency" }],
      },
    },
    {
      file: "task.jsonl",
      lineNumber: 1,
      event: {
        type: "task_claimed",
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        taskId: "arch-3",
        branch: "archloop/arch-3-awaiting-merge",
        createdAt: "2026-06-23T10:01:00.000Z",
        status: "implementing",
      },
    },
    {
      file: "task.jsonl",
      lineNumber: 2,
      event: {
        type: "task_implementation_started",
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        taskId: "arch-3",
        createdAt: "2026-06-23T10:05:00.000Z",
        status: "implementing",
      },
    },
  ];

  if (options?.includeMergeConflict) {
    events.push({
      file: "task.jsonl",
      lineNumber: 3,
      event: {
        type: "merge_conflict_resolution_failed",
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        taskId: "arch-3",
        createdAt: "2026-06-23T10:39:00.000Z",
        message: "Automatic conflict resolution failed",
        status: "merging",
      },
    });
  }

  if (options?.includeFailedTask) {
    events.push({
      file: "task.jsonl",
      lineNumber: 4,
      event: {
        type: "task_implementation_failed",
        runId: "run-fixture-1",
        batchId: "batch-fixture-1",
        taskId: "arch-2",
        createdAt: "2026-06-23T09:30:00.000Z",
        status: "failed",
        failureReason: "agent_failed",
      },
    });
  }

  if (options?.completed) {
    events.push(
      {
        file: "task.jsonl",
        lineNumber: 3,
        event: {
          type: "task_implementation_succeeded",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          taskId: "arch-3",
          createdAt: "2026-06-23T10:20:00.000Z",
          status: "reviewing",
        },
      },
      {
        file: "task.jsonl",
        lineNumber: 4,
        event: {
          type: "task_review_started",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          taskId: "arch-3",
          createdAt: "2026-06-23T10:25:00.000Z",
          status: "reviewing",
        },
      },
      {
        file: "task.jsonl",
        lineNumber: 5,
        event: {
          type: "task_review_succeeded",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          taskId: "arch-3",
          createdAt: "2026-06-23T10:35:00.000Z",
          status: "waiting_for_merge",
        },
      },
      {
        file: "task.jsonl",
        lineNumber: 6,
        event: {
          type: "verification_started",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          taskId: "arch-3",
          createdAt: "2026-06-23T10:36:00.000Z",
          status: "waiting_for_merge",
        },
      },
      {
        file: "task.jsonl",
        lineNumber: 7,
        event: {
          type: "verification_passed",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          taskId: "arch-3",
          createdAt: "2026-06-23T10:37:00.000Z",
          status: "waiting_for_merge",
        },
      },
      {
        file: "batch.jsonl",
        lineNumber: 8,
        event: {
          type: "batch_merge_started",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          createdAt: "2026-06-23T10:38:00.000Z",
          taskIds: ["arch-3"],
        },
      },
      {
        file: "batch.jsonl",
        lineNumber: 9,
        event: {
          type: "batch_merge_completed",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          createdAt: "2026-06-23T10:45:00.000Z",
          taskIds: ["arch-3"],
          batchStatus: "done",
        },
      },
      {
        file: "task.jsonl",
        lineNumber: 10,
        event: {
          type: "task_close_started",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          taskId: "arch-3",
          createdAt: "2026-06-23T10:46:00.000Z",
          status: "merging",
        },
      },
      {
        file: "task.jsonl",
        lineNumber: 11,
        event: {
          type: "task_closed",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          taskId: "arch-3",
          createdAt: "2026-06-23T10:47:00.000Z",
          status: "done",
        },
      },
    );
  }

  return {
    runDir: options?.runDir ?? FIXTURE_RUN_DIR,
    events,
  };
};

export const FIXTURE_PROPOSAL_RUN_DIR =
  "/tmp/archloop-user-data/projects/fixture/runs/run-proposal-fixture-1";

export const createHubDesktopFixtureProposalRunSummaries =
  (): readonly HubProjectRunSummary[] => [
    {
      runId: "run-proposal-fixture-1",
      runDir: FIXTURE_PROPOSAL_RUN_DIR,
      branch: "proposal/prd-decomposition",
      startedAt: "2026-06-23T11:00:00.000Z",
      batches: [],
    },
  ];

export const createHubDesktopFixtureProposalSessionArtifacts = () => ({
  preparedContext: {
    prdRef: "docs/prd/hub-gui.md",
    summary: "Hub GUI v0 proposal session review",
    prdTitle: "archLoop Hub GUI v0",
  },
  transcript: [
    {
      role: "assistant" as const,
      content:
        "Drafted two tracer-bullet slices for the proposal session vertical slice.",
      createdAt: "2026-06-23T11:01:00.000Z",
      phase: "draft" as const,
    },
    {
      role: "assistant" as const,
      content:
        "Final proposal ready for maintainer review before local Beads writes.",
      createdAt: "2026-06-23T11:05:00.000Z",
      phase: "finalization" as const,
    },
  ],
  finalProposal: {
    prdRef: "docs/prd/hub-gui.md",
    prdTitle: "archLoop Hub GUI v0",
    summary: "Two slices for proposal session desktop review.",
    slices: [
      {
        tempId: "slice-1",
        title: "Build proposal session slice",
        description: "Wire proposal session model and desktop view.",
        sliceType: "AFK",
        acceptanceCriteria: [
          "Proposal session loads real bridge artifacts",
          "Validation and apply states are visible",
        ],
        rationale:
          "Tracer-bullet slice for maintainer review before local writes.",
      },
      {
        tempId: "slice-2",
        title: "Confirm Stitch alignment with maintainer",
        description: "Review proposal session layout against Stitch reference.",
        sliceType: "HITL",
        acceptanceCriteria: ["Maintainer confirms Stitch alignment"],
        rationale: "Human checkpoint before broad rollout.",
      },
    ],
    dependencies: [{ dependentTempId: "slice-2", blockerTempId: "slice-1" }],
    warnings: [],
  },
  applyResult: undefined,
});

export const createHubDesktopFixtureProposalSessionEvents = (options?: {
  readonly includeSessionCompleted?: boolean;
  readonly includeMutationDetected?: boolean;
}): {
  readonly runDir: string;
  readonly events: readonly HubRunEventRecord[];
} => {
  const events: HubRunEventRecord[] = [
    {
      file: "proposal.jsonl",
      lineNumber: 1,
      event: {
        type: "session_started",
        flowId: "prd-decomposition",
        runId: "run-proposal-fixture-1",
        createdAt: "2026-06-23T11:00:00.000Z",
      },
    },
    {
      file: "proposal.jsonl",
      lineNumber: 2,
      event: {
        type: "draft_succeeded",
        flowId: "prd-decomposition",
        runId: "run-proposal-fixture-1",
        createdAt: "2026-06-23T11:01:00.000Z",
        assistantMessage: "Drafted proposal slices.",
      },
    },
    {
      file: "proposal.jsonl",
      lineNumber: 3,
      event: {
        type: "finalization_succeeded",
        flowId: "prd-decomposition",
        runId: "run-proposal-fixture-1",
        createdAt: "2026-06-23T11:05:00.000Z",
      },
    },
  ];

  if (options?.includeMutationDetected) {
    events.push({
      file: "proposal.jsonl",
      lineNumber: 4,
      event: {
        type: "mutation_detected",
        flowId: "prd-decomposition",
        runId: "run-proposal-fixture-1",
        createdAt: "2026-06-23T11:05:30.000Z",
        reason: "Beads task store changed during proposal session.",
      },
    });
  }

  if (options?.includeSessionCompleted) {
    events.push({
      file: "proposal.jsonl",
      lineNumber: events.length + 1,
      event: {
        type: "session_completed",
        flowId: "prd-decomposition",
        runId: "run-proposal-fixture-1",
        createdAt: "2026-06-23T11:06:00.000Z",
      },
    });
  }

  return {
    runDir: FIXTURE_PROPOSAL_RUN_DIR,
    events,
  };
};
