import type { HubProjectStatus } from "./projectStatus.js";
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

export const createHubDesktopFixtureTasks = (): readonly HubTaskProjection[] => [
  fixtureTask({
    id: "arch-1",
    title: "Wire project overview",
    hubStatus: "ready_for_agent",
    labels: ["hub-gui"],
  }),
  fixtureTask({
    id: "arch-2",
    title: "Recover stale claim",
    hubStatus: "failed",
    labels: ["recovery"],
    metadata: { failure_reason: "agent_failed" },
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

export const createHubDesktopFixtureProjectStatus = (): HubProjectStatus => ({
  repoRoot: HUB_DESKTOP_FIXTURE_REPO_ROOT,
  archloopUserDataDir: "/tmp/archloop-user-data",
  hubProjectDir: "/tmp/archloop-user-data/projects/fixture",
  projectRegistered: true,
  beadsAvailable: true,
  taskStoreInitialized: true,
  taskCounts: { ready: 1, total: 3 },
  statusCounts: {
    ready_for_agent: 1,
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
  worktreeLeaseDiagnostics: [],
});
