import type {
  HubConfigSummary,
  HubProjectRunSummary,
  HubProjectStatus,
  HubRunEventsSnapshot,
  HubRuntimeAction,
  HubRuntimeActionPreview,
  HubRuntimeBridgeResult,
  HubRuntimeRequest,
  HubRuntimeRequestMap,
  HubRuntimeResponseMap,
  HubSyncStateSummary,
  HubTaskBoard,
  HubTaskProjection,
  HubTaskStatus,
} from "@yibeibankaishui/archloop/hub-runtime-contract";

import type { HubDesktopRuntimeApi } from "./bridge";

const FIXTURE_REPO_ROOT = "/tmp/archloop-hub-fixture";
const FIXTURE_RUN_DIR =
  "/tmp/archloop-user-data/projects/fixture/runs/run-fixture-1";
const FIXTURE_PROPOSAL_RUN_DIR =
  "/tmp/archloop-user-data/projects/fixture/runs/run-proposal-fixture-1";

const HUB_TASK_STATUSES = [
  "inbox",
  "needs_info",
  "ready_for_agent",
  "ready_for_human",
  "blocked",
  "implementing",
  "reviewing",
  "waiting_for_merge",
  "merging",
  "done",
  "wontfix",
  "failed",
  "sync_conflict",
] as const satisfies readonly HubTaskStatus[];

const ok = <T>(data: T): HubRuntimeBridgeResult<T> => ({ ok: true, data });

const notFound = (message: string): HubRuntimeBridgeResult<never> => ({
  ok: false,
  error: { code: "not_found", message },
});

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

const createFixtureTasks = (): readonly HubTaskProjection[] => [
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

const createTaskBoard = (): HubTaskBoard => {
  const tasks = createFixtureTasks();

  return {
    tasks,
    groups: HUB_TASK_STATUSES.map((status) => ({
      status,
      tasks: tasks.filter((task) => task.hubStatus === status),
    })),
  };
};

const createProjectStatus = (): HubProjectStatus => ({
  repoRoot: FIXTURE_REPO_ROOT,
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
    pushPending: 1,
    conflict: 0,
    localOnly: 1,
    synced: 3,
  },
  activeBatches: [
    {
      runId: "run-fixture-1",
      batchId: "batch-fixture-1",
      runDir: FIXTURE_RUN_DIR,
      status: "merging",
      flowId: "with-review",
      taskCount: 1,
      active: true,
    },
  ],
  runDirectories: [FIXTURE_RUN_DIR, FIXTURE_PROPOSAL_RUN_DIR],
  recentEvents: [
    "run run-fixture-1 started flow with-review",
    "task arch-3 claimed on branch archloop/arch-3-awaiting-merge",
  ],
  worktreeLeaseDiagnostics: [
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
  ],
});

const createRunSummaries = (): readonly HubProjectRunSummary[] => [
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
        status: "merging",
        flowId: "with-review",
        taskCount: 1,
        active: true,
      },
    ],
  },
  {
    runId: "run-proposal-fixture-1",
    runDir: FIXTURE_PROPOSAL_RUN_DIR,
    branch: "proposal/prd-decomposition",
    startedAt: "2026-06-23T11:00:00.000Z",
    batches: [],
  },
];

const createRunEvents = (runDir: string): HubRunEventsSnapshot => {
  if (runDir === FIXTURE_PROPOSAL_RUN_DIR) {
    return {
      runDir,
      events: [
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
      ],
    };
  }

  return {
    runDir,
    events: [
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
        file: "batch.jsonl",
        lineNumber: 3,
        event: {
          type: "batch_merge_started",
          runId: "run-fixture-1",
          batchId: "batch-fixture-1",
          createdAt: "2026-06-23T10:38:00.000Z",
          taskIds: ["arch-3"],
        },
      },
    ],
  };
};

const createProposalSession =
  (): HubRuntimeResponseMap["proposal.readSession"] => ({
    preparedContext: {
      prdRef: "docs/prd/hub-gui.md",
      summary: "Hub GUI v0 proposal session review",
      prdTitle: "archLoop Hub GUI v0",
    },
    transcript: [
      {
        role: "assistant",
        content:
          "Drafted two tracer-bullet slices for the proposal session vertical slice.",
        createdAt: "2026-06-23T11:01:00.000Z",
        phase: "draft",
      },
      {
        role: "assistant",
        content:
          "Final proposal ready for maintainer review before local Beads writes.",
        createdAt: "2026-06-23T11:05:00.000Z",
        phase: "finalization",
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
          description:
            "Review proposal session layout against Stitch reference.",
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

const createConfigSummary = (): HubConfigSummary => ({
  hubEnvPath: "/tmp/archloop-user-data/projects/fixture/.env",
  configuredKeys: ["ARCHLOOP_PROVIDER", "ARCHLOOP_MODEL"],
  missingKeys: [],
});

const createSyncState = (): HubSyncStateSummary => ({
  pushPending: 1,
  pullPending: 0,
  conflict: 0,
  localOnly: 1,
  synced: 3,
  cliFallback: "archloop tasks sync",
});

const createPreview = (
  action: HubRuntimeActionPreview["action"],
  summary: string,
  confirmToken: string,
  cliFallback?: string,
): HubRuntimeActionPreview => ({
  action,
  summary,
  confirmToken,
  cliFallback,
});

const resolveFixtureRequest = (
  request: HubRuntimeRequest,
): HubRuntimeBridgeResult<HubRuntimeResponseMap[HubRuntimeAction]> => {
  switch (request.action) {
    case "project.getStatus":
      return ok(createProjectStatus());
    case "taskBoard.load":
      return ok(createTaskBoard());
    case "task.get": {
      const params = request.params as HubRuntimeRequestMap["task.get"];
      const task = createFixtureTasks().find(
        (item) => item.id === params.taskId,
      );
      return task
        ? ok(task)
        : notFound(`Fixture task not found: ${params.taskId}`);
    }
    case "run.listSummaries":
      return ok(createRunSummaries());
    case "run.readEvents": {
      const params = request.params as HubRuntimeRequestMap["run.readEvents"];
      return ok(createRunEvents(params.runDir));
    }
    case "proposal.readSession":
      return ok(createProposalSession());
    case "config.getSummary":
      return ok(createConfigSummary());
    case "sync.getState":
      return ok(createSyncState());
    case "recover.preview": {
      const params = request.params as HubRuntimeRequestMap["recover.preview"];
      return ok(
        createPreview(
          "recover.execute",
          `Recover ${params.taskId} to ready_for_agent in fixture mode.`,
          `fixture-recover-${params.taskId}`,
          `archloop tasks recover ${params.taskId}`,
        ),
      );
    }
    case "sync.pushPreview":
      return ok(
        createPreview(
          "sync.pushExecute",
          "Push one pending local task update in fixture mode.",
          "fixture-sync-push",
          "archloop tasks push",
        ),
      );
    case "sync.pullPreview":
      return ok(
        createPreview(
          "sync.pullExecute",
          "Pull remote task changes in fixture mode.",
          "fixture-sync-pull",
          "archloop tasks pull",
        ),
      );
    case "task.createPreview": {
      const params =
        request.params as HubRuntimeRequestMap["task.createPreview"];
      return ok(
        createPreview(
          "task.createExecute",
          `Create fixture task "${params.title}".`,
          "fixture-task-create",
          `archloop tasks create ${JSON.stringify(params.title)}`,
        ),
      );
    }
    case "recover.execute": {
      const params = request.params as HubRuntimeRequestMap["recover.execute"];
      return ok({ taskId: params.taskId, status: "queued_for_cli" });
    }
    case "sync.pushExecute":
    case "sync.pullExecute":
      return ok({ status: "queued_for_cli" });
    case "task.createExecute": {
      const params =
        request.params as HubRuntimeRequestMap["task.createExecute"];
      return ok(
        fixtureTask({
          id: "arch-fixture-new",
          title: params.title,
          description: params.description,
          hubStatus: "inbox",
          metadata: { sync_state: "local_only" },
        }),
      );
    }
    default: {
      const exhaustive: never = request.action;
      return exhaustive;
    }
  }
};

export const createHubDesktopBrowserFixtureRuntime =
  (): HubDesktopRuntimeApi => ({
    invoke: async <A extends HubRuntimeRequest["action"]>(
      request: HubRuntimeRequest<A>,
    ): Promise<HubRuntimeBridgeResult<HubRuntimeResponseMap[A]>> =>
      resolveFixtureRequest(
        request as HubRuntimeRequest,
      ) as HubRuntimeBridgeResult<HubRuntimeResponseMap[A]>,
  });
