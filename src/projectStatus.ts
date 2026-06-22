import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isBdAvailable, resolveBdExecutable } from "./resolveBdExecutable.js";
import {
  HUB_TASK_STORE_INIT_COMMAND,
  isHubTaskStoreInitialized,
} from "./hubTaskStore.js";
import {
  collectHubWorktreeLeaseDiagnosticsForTasks,
  type HubWorktreeLeaseDiagnostic,
} from "./hubWorktreeLeaseDiagnostics.js";
import {
  loadHubTaskBoard,
  type HubFailureReason,
  type HubTaskBoard,
  type HubTaskProjection,
  type HubTaskStatus,
} from "./taskBoard.js";
import { listWorktreeLeases } from "./worktreeLeaseStore.js";

export interface HubProjectTaskCounts {
  readonly ready: number;
  readonly total: number;
}

export interface HubProjectSyncCounts {
  readonly pushPending: number;
  readonly conflict: number;
  readonly localOnly: number;
  readonly synced: number;
}

export interface HubProjectFailedTask {
  readonly id: string;
  readonly title: string;
  readonly failureReason: HubFailureReason | undefined;
  readonly nextAction: string;
}

export interface HubProjectBatchSummary {
  readonly runId: string;
  readonly batchId: string;
  readonly runDir: string;
  readonly status:
    | "started"
    | "planned"
    | "merging"
    | "done"
    | "partial_failed";
  readonly flowId?: string;
  readonly taskCount?: number;
  readonly active: boolean;
}

export interface HubProjectRunSummary {
  readonly runId: string;
  readonly runDir: string;
  readonly branch?: string;
  readonly startedAt?: string;
  readonly batches: readonly HubProjectBatchSummary[];
}

export interface HubProjectStatus {
  readonly repoRoot: string;
  readonly archloopUserDataDir: string;
  readonly hubProjectDir: string;
  readonly projectRegistered: boolean;
  readonly beadsAvailable: boolean;
  readonly taskStoreInitialized: boolean;
  readonly taskCounts: HubProjectTaskCounts;
  readonly statusCounts: Partial<Record<HubTaskStatus, number>>;
  readonly failedTasks: readonly HubProjectFailedTask[];
  readonly syncCounts: HubProjectSyncCounts;
  readonly activeBatches: readonly HubProjectBatchSummary[];
  readonly runDirectories: readonly string[];
  readonly recentEvents: readonly string[];
  readonly worktreeLeaseDiagnostics: readonly HubWorktreeLeaseDiagnostic[];
}

export interface HubProjectStatusOptions {
  readonly cwd?: string;
  readonly archloopUserDataDir?: string;
  readonly resolveRepoRoot?: (cwd: string) => string;
  readonly detectBeadsAvailable?: () => boolean;
  readonly detectTaskStoreInitialized?: (repoRoot: string) => boolean;
  readonly countReadyTasks?: (repoRoot: string) => number;
  readonly countTotalTasks?: (repoRoot: string) => number;
  readonly ensureHubProjectDir?: (hubProjectDir: string) => boolean;
  readonly loadTaskBoard?: (repoRoot: string) => HubTaskBoard;
  readonly listRunSummaries?: (
    hubProjectDir: string,
  ) => readonly HubProjectRunSummary[];
  readonly listWorktreeLeases?: typeof listWorktreeLeases;
}

const BD_JSON_COUNT_KEYS = [
  "total_count",
  "totalCount",
  "count",
  "ready_count",
  "readyCount",
  "open_count",
  "openCount",
  "tasks",
  "items",
] as const;

const EMPTY_SYNC_COUNTS: HubProjectSyncCounts = {
  pushPending: 0,
  conflict: 0,
  localOnly: 0,
  synced: 0,
};

type MutableHubProjectSyncCounts = {
  pushPending: number;
  conflict: number;
  localOnly: number;
  synced: number;
};

const ACTIVE_RUN_TASK_STATUSES = new Set<HubTaskProjection["hubStatus"]>([
  "failed",
  "implementing",
  "reviewing",
  "merging",
]);

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readFirstString = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

const readJsonl = (path: string): unknown[] => {
  if (!existsSync(path)) {
    return [];
  }

  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
};

const readFailureReason = (
  task: HubTaskProjection,
): HubFailureReason | undefined => {
  const value = task.metadata.failureReason ?? task.metadata.failure_reason;
  if (typeof value !== "string") {
    return undefined;
  }

  switch (value) {
    case "agent_failed":
    case "sandbox_failed":
    case "merge_conflict":
    case "merge_failed":
    case "verification_failure":
    case "close_failed":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
};

const readSyncState = (
  metadata: Readonly<Record<string, unknown>>,
): keyof HubProjectSyncCounts | undefined => {
  const value = metadata.sync_state ?? metadata.syncState;
  if (value === "push_pending") {
    return "pushPending";
  }
  if (value === "conflict") {
    return "conflict";
  }
  if (value === "local_only") {
    return "localOnly";
  }
  if (value === "synced") {
    return "synced";
  }
  return undefined;
};

const createEmptySyncCounts = (): MutableHubProjectSyncCounts => ({
  ...EMPTY_SYNC_COUNTS,
});

const readTaskCount = (value: unknown): number | undefined =>
  Array.isArray(value) ? value.length : undefined;

export const resolveFailedTaskNextAction = (
  task: Pick<HubTaskProjection, "id">,
  failureReason: HubFailureReason | undefined,
): string => {
  const recoverCmd = `archloop tasks recover ${task.id}`;
  switch (failureReason) {
    case "agent_failed":
    case "sandbox_failed":
      return `${recoverCmd} to reset and retry agent work`;
    case "merge_conflict":
      return `${recoverCmd} or resolve the merge conflict manually`;
    case "merge_failed":
      return `${recoverCmd} to inspect and retry the merge`;
    case "verification_failure":
      return `${recoverCmd} or fix verification and recover`;
    case "close_failed":
      return `${recoverCmd} to verify merge and retry local close`;
    default:
      return `${recoverCmd} to inspect and repair execution state`;
  }
};

const summarizeTaskBoard = (
  board: HubTaskBoard | undefined,
): {
  readonly statusCounts: Partial<Record<HubTaskStatus, number>>;
  readonly failedTasks: readonly HubProjectFailedTask[];
  readonly syncCounts: HubProjectSyncCounts;
} => {
  if (!board || board.tasks.length === 0) {
    return {
      statusCounts: {},
      failedTasks: [],
      syncCounts: createEmptySyncCounts(),
    };
  }

  const statusCounts: Partial<Record<HubTaskStatus, number>> = {};
  for (const task of board.tasks) {
    statusCounts[task.hubStatus] = (statusCounts[task.hubStatus] ?? 0) + 1;
  }

  const failedTasks = board.tasks
    .filter((task) => task.hubStatus === "failed")
    .map((task) => {
      const failureReason = readFailureReason(task);
      return {
        id: task.id,
        title: task.title,
        failureReason,
        nextAction: resolveFailedTaskNextAction(task, failureReason),
      };
    });

  const syncCounts = createEmptySyncCounts();
  for (const task of board.tasks) {
    const syncState = readSyncState(task.metadata);
    if (task.hubStatus === "sync_conflict") {
      syncCounts.conflict += 1;
      continue;
    }
    if (syncState) {
      syncCounts[syncState] += 1;
    }
  }

  return { statusCounts, failedTasks, syncCounts };
};

const readBatchSummary = (
  runId: string,
  runDir: string,
  batchId: string,
  events: readonly unknown[],
): HubProjectBatchSummary => {
  const status = resolveBatchStatus(events);
  const plannedEvent = events.find(
    (event) => readObject(event).type === "batch_planned",
  );
  const plannedRecord = readObject(plannedEvent);

  return {
    runId,
    batchId,
    runDir,
    status,
    flowId: readFirstString(plannedRecord, ["flowId", "flow_id"]),
    taskCount: readTaskCount(plannedRecord.taskIds),
    active: status !== "done",
  };
};

const resolveBatchStatus = (
  events: readonly unknown[],
): HubProjectBatchSummary["status"] => {
  let status: HubProjectBatchSummary["status"] = "started";
  for (const event of events) {
    const record = readObject(event);
    switch (record.type) {
      case "batch_planned":
        status = "planned";
        break;
      case "batch_merge_started":
        status = "merging";
        break;
      case "batch_merge_completed":
        status =
          record.batchStatus === "partial_failed" ? "partial_failed" : "done";
        break;
      default:
        break;
    }
  }
  return status;
};

const groupBatchEvents = (
  events: readonly unknown[],
): Map<string, unknown[]> => {
  const grouped = new Map<string, unknown[]>();
  for (const event of events) {
    const record = readObject(event);
    const batchId = readFirstString(record, ["batchId", "batch_id"]);
    if (!batchId) {
      continue;
    }
    const existing = grouped.get(batchId) ?? [];
    existing.push(event);
    grouped.set(batchId, existing);
  }
  return grouped;
};

const formatRecentEvent = (event: unknown): string | undefined => {
  const record = readObject(event);
  const type = readFirstString(record, ["type"]);
  const createdAt = readFirstString(record, ["createdAt", "startedAt"]);
  const taskId = readFirstString(record, ["taskId", "task_id"]);
  const batchId = readFirstString(record, ["batchId", "batch_id"]);
  if (!type) {
    return undefined;
  }

  const parts = [createdAt, type, taskId, batchId ? `(${batchId})` : undefined]
    .filter((part) => part !== undefined)
    .join(" ");
  return parts.length > 0 ? parts : undefined;
};

export const listHubRunSummaries = (
  hubProjectDir: string,
): readonly HubProjectRunSummary[] => {
  const runsDir = join(hubProjectDir, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }

  const summaries: HubProjectRunSummary[] = [];
  for (const runId of readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const runDir = join(runsDir, runId);
    const eventsDir = join(runDir, "events");
    const runEvents = readJsonl(join(eventsDir, "run.jsonl"));
    const batchEvents = readJsonl(join(eventsDir, "batch.jsonl"));
    const runStarted = readObject(runEvents[0]);
    const batches = [...groupBatchEvents(batchEvents).entries()].map(
      ([batchId, events]) => readBatchSummary(runId, runDir, batchId, events),
    );

    summaries.push({
      runId,
      runDir,
      branch: readFirstString(runStarted, ["branch"]),
      startedAt: readFirstString(runStarted, ["startedAt", "started_at"]),
      batches,
    });
  }

  return summaries;
};

const collectRecentEvents = (
  runSummaries: readonly HubProjectRunSummary[],
  limit = 5,
): readonly string[] => {
  const events: Array<{ createdAt: string; line: string }> = [];
  for (const run of runSummaries) {
    const eventsDir = join(run.runDir, "events");
    for (const fileName of ["task.jsonl", "batch.jsonl"]) {
      for (const event of readJsonl(join(eventsDir, fileName))) {
        const record = readObject(event);
        const line = formatRecentEvent(event);
        const createdAt = readFirstString(record, ["createdAt", "startedAt"]);
        if (line && createdAt) {
          events.push({ createdAt, line });
        }
      }
    }
  }

  return events
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
    .map((entry) => entry.line);
};

const collectRunDirectories = (
  runSummaries: readonly HubProjectRunSummary[],
  failedTasks: readonly HubProjectFailedTask[],
  board: HubTaskBoard | undefined,
): readonly string[] => {
  const directories = new Set<string>();
  for (const run of runSummaries) {
    if (run.batches.some((batch) => batch.active)) {
      directories.add(run.runDir);
    }
  }

  for (const task of board?.tasks ?? []) {
    const runId = task.claim?.runId;
    if (!runId || !ACTIVE_RUN_TASK_STATUSES.has(task.hubStatus)) {
      continue;
    }

    const run = runSummaries.find((summary) => summary.runId === runId);
    if (run) {
      directories.add(run.runDir);
    }
  }

  if (directories.size === 0 && failedTasks.length > 0) {
    for (const run of runSummaries) {
      directories.add(run.runDir);
    }
  }

  return [...directories].sort();
};

const appendTaskCountLines = (lines: string[], status: HubProjectStatus) => {
  lines.push("Task counts by Hub status");
  if (!status.beadsAvailable) {
    lines.push(
      "  archLoop task runtime unavailable — install dependencies, set ARCHLOOP_BD_PATH, or ensure the bundled Beads runtime is available.",
    );
    return;
  }

  if (!status.taskStoreInitialized) {
    lines.push(
      `  Local task store not initialized — run \`${HUB_TASK_STORE_INIT_COMMAND}\` in this repository first.`,
    );
    return;
  }

  if (Object.keys(status.statusCounts).length === 0) {
    lines.push("  No Hub tasks found.");
    return;
  }

  for (const [hubStatus, count] of Object.entries(status.statusCounts).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    lines.push(`  ${hubStatus}: ${count}`);
  }
};

const appendActiveBatchLines = (
  lines: string[],
  activeBatches: readonly HubProjectBatchSummary[],
) => {
  lines.push("Active runs and batch status");
  if (activeBatches.length === 0) {
    lines.push("  No active Hub runs.");
    return;
  }

  for (const batch of activeBatches) {
    const details = [
      batch.flowId ? `flow ${batch.flowId}` : undefined,
      batch.taskCount !== undefined ? `${batch.taskCount} tasks` : undefined,
    ]
      .filter((detail) => detail !== undefined)
      .join(", ");
    lines.push(
      `  ${batch.runId} / ${batch.batchId}: ${batch.status}${details ? ` (${details})` : ""}`,
    );
    lines.push(`    Run directory: ${batch.runDir}`);
  }
};

const appendFailedTaskLines = (
  lines: string[],
  failedTasks: readonly HubProjectFailedTask[],
) => {
  lines.push("Failed tasks");
  if (failedTasks.length === 0) {
    lines.push("  No failed tasks.");
    return;
  }

  for (const task of failedTasks) {
    lines.push(
      `  ${task.id}: ${task.failureReason ?? "unknown"} — ${task.nextAction}`,
    );
  }
};

const appendSyncStateLines = (
  lines: string[],
  syncCounts: HubProjectSyncCounts,
) => {
  lines.push("Sync state");
  const syncTotal =
    syncCounts.pushPending +
    syncCounts.conflict +
    syncCounts.localOnly +
    syncCounts.synced;
  if (syncTotal === 0) {
    lines.push(
      "  No sync metadata — GitHub sync may be unconfigured or no remote-linked tasks.",
    );
    return;
  }

  if (syncCounts.pushPending > 0) {
    lines.push(`  push_pending: ${syncCounts.pushPending}`);
  }
  if (syncCounts.conflict > 0) {
    lines.push(`  conflict: ${syncCounts.conflict}`);
  }
  if (syncCounts.localOnly > 0) {
    lines.push(`  local_only: ${syncCounts.localOnly}`);
  }
  if (syncCounts.synced > 0) {
    lines.push(`  synced: ${syncCounts.synced}`);
  }
};

const appendRecentEventLines = (
  lines: string[],
  recentEvents: readonly string[],
) => {
  if (recentEvents.length === 0) {
    return;
  }

  lines.push("");
  lines.push("Recent Hub events");
  for (const event of recentEvents) {
    lines.push(`  ${event}`);
  }
};

const appendRunDirectoryLines = (
  lines: string[],
  runDirectories: readonly string[],
) => {
  lines.push("");
  lines.push("Hub run directories");
  if (runDirectories.length === 0) {
    lines.push("  No Hub run directories yet.");
    return;
  }

  for (const runDir of runDirectories) {
    lines.push(`  ${runDir}`);
  }
};

const appendWorktreeLeaseLines = (
  lines: string[],
  diagnostics: readonly HubWorktreeLeaseDiagnostic[],
) => {
  lines.push("");
  lines.push("Worktree lease diagnostics");
  if (diagnostics.length === 0) {
    lines.push("  No active or inconsistent worktree leases.");
    return;
  }

  for (const diagnostic of diagnostics) {
    const pid =
      diagnostic.pid !== undefined ? ` pid ${diagnostic.pid}` : "";
    lines.push(
      `  ${diagnostic.taskId}: ${diagnostic.reason} on ${diagnostic.branch}${pid}`,
    );
    lines.push(`    ${diagnostic.message}`);
    lines.push(`    Next action: ${diagnostic.nextAction}`);
  }
};

export const formatHubProjectStatusLines = (
  status: HubProjectStatus,
): readonly string[] => {
  const lines: string[] = [];
  appendTaskCountLines(lines, status);
  lines.push("");
  appendActiveBatchLines(lines, status.activeBatches);
  lines.push("");
  appendFailedTaskLines(lines, status.failedTasks);
  lines.push("");
  appendSyncStateLines(lines, status.syncCounts);
  appendRecentEventLines(lines, status.recentEvents);
  appendRunDirectoryLines(lines, status.runDirectories);
  appendWorktreeLeaseLines(lines, status.worktreeLeaseDiagnostics);

  return lines;
};

export const resolveArchloopUserDataDir = (
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string => {
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  const baseDir =
    xdgDataHome && xdgDataHome.length > 0
      ? xdgDataHome
      : join(homeDir, ".local", "share");
  return join(baseDir, "archloop");
};

export const resolveHubProjectDir = (
  archloopUserDataDir: string,
  repoRoot: string,
): string => {
  const projectId = createHash("sha256")
    .update(repoRoot)
    .digest("hex")
    .slice(0, 12);
  return join(archloopUserDataDir, "hub", "projects", projectId);
};

export const resolveGitRepoRoot = (cwd: string): string => {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return stdout.trim();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "unable to resolve git repo root";
    throw new Error(
      `archloop project status requires a git repository: ${message}`,
    );
  }
};

const parseJsonCount = (output: string): number => {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.length;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of BD_JSON_COUNT_KEYS) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (Array.isArray(value)) {
          return value.length;
        }
      }
    }
  } catch {
    // Fall through to zero for unreadable output.
  }
  return 0;
};

const countBdJsonResult = (args: readonly string[], cwd: string): number => {
  try {
    const stdout = execFileSync(resolveBdExecutable(), [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseJsonCount(stdout);
  } catch {
    return 0;
  }
};

const registerHubProjectDir = (hubProjectDir: string): boolean => {
  const existedBeforeRegistration = existsSync(hubProjectDir);
  mkdirSync(hubProjectDir, { recursive: true });
  return existedBeforeRegistration;
};

const resolveBeadsAvailable = (
  detectBeadsAvailable: HubProjectStatusOptions["detectBeadsAvailable"],
): boolean => (detectBeadsAvailable ?? (() => isBdAvailable()))();

const resolveTaskStoreInitialized = (
  repoRoot: string,
  beadsAvailable: boolean,
  detectTaskStoreInitialized: HubProjectStatusOptions["detectTaskStoreInitialized"],
): boolean =>
  beadsAvailable
    ? (detectTaskStoreInitialized ?? isHubTaskStoreInitialized)(repoRoot)
    : false;

const resolveTaskCounts = (
  repoRoot: string,
  beadsAvailable: boolean,
  taskStoreInitialized: boolean,
  countReadyTasks: HubProjectStatusOptions["countReadyTasks"],
  countTotalTasks: HubProjectStatusOptions["countTotalTasks"],
): HubProjectTaskCounts =>
  beadsAvailable && taskStoreInitialized
    ? {
        ready: (
          countReadyTasks ??
          ((repoRootPath) =>
            countBdJsonResult(["ready", "--json"], repoRootPath))
        )(repoRoot),
        total: (
          countTotalTasks ??
          ((repoRootPath) =>
            countBdJsonResult(["list", "--json"], repoRootPath))
        )(repoRoot),
      }
    : { ready: 0, total: 0 };

const resolveProjectRegistration = (
  hubProjectDir: string,
  ensureHubProjectDir: HubProjectStatusOptions["ensureHubProjectDir"],
): boolean => (ensureHubProjectDir ?? registerHubProjectDir)(hubProjectDir);

const resolveRepoRoot = (
  cwd: string,
  resolveRepoRootOption: HubProjectStatusOptions["resolveRepoRoot"],
): string =>
  resolveRepoRootOption ? resolveRepoRootOption(cwd) : resolveGitRepoRoot(cwd);

const resolveUserDataDir = (
  archloopUserDataDir: HubProjectStatusOptions["archloopUserDataDir"],
): string => archloopUserDataDir ?? resolveArchloopUserDataDir();

const loadTaskBoardSafe = (
  repoRoot: string,
  beadsAvailable: boolean,
  taskStoreInitialized: boolean,
  loadTaskBoard: HubProjectStatusOptions["loadTaskBoard"],
): HubTaskBoard | undefined => {
  if (!beadsAvailable || !taskStoreInitialized) {
    return undefined;
  }

  if (loadTaskBoard) {
    return loadTaskBoard(repoRoot);
  }

  try {
    return loadHubTaskBoard(repoRoot);
  } catch {
    return { tasks: [], groups: [] };
  }
};

export const resolveHubProjectStatus = (
  options: HubProjectStatusOptions = {},
): HubProjectStatus => {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd, options.resolveRepoRoot);
  const archloopUserDataDir = resolveUserDataDir(options.archloopUserDataDir);
  const hubProjectDir = resolveHubProjectDir(archloopUserDataDir, repoRoot);
  const projectRegistered = resolveProjectRegistration(
    hubProjectDir,
    options.ensureHubProjectDir,
  );
  const beadsAvailable = resolveBeadsAvailable(options.detectBeadsAvailable);
  const taskStoreInitialized = resolveTaskStoreInitialized(
    repoRoot,
    beadsAvailable,
    options.detectTaskStoreInitialized,
  );
  const taskCounts = resolveTaskCounts(
    repoRoot,
    beadsAvailable,
    taskStoreInitialized,
    options.countReadyTasks,
    options.countTotalTasks,
  );
  const board = loadTaskBoardSafe(
    repoRoot,
    beadsAvailable,
    taskStoreInitialized,
    options.loadTaskBoard,
  );
  const { statusCounts, failedTasks, syncCounts } = summarizeTaskBoard(board);
  const runSummaries =
    options.listRunSummaries?.(hubProjectDir) ??
    listHubRunSummaries(hubProjectDir);
  const activeBatches = runSummaries.flatMap((run) =>
    run.batches.filter((batch) => batch.active),
  );
  const recentEvents = collectRecentEvents(runSummaries);
  const runDirectories = collectRunDirectories(
    runSummaries,
    failedTasks,
    board,
  );
  const worktreeLeaseDiagnostics =
    board === undefined
      ? []
      : collectHubWorktreeLeaseDiagnosticsForTasks(
          board.tasks,
          (options.listWorktreeLeases ?? listWorktreeLeases)(repoRoot),
        );

  return {
    repoRoot,
    archloopUserDataDir,
    hubProjectDir,
    projectRegistered,
    beadsAvailable,
    taskStoreInitialized,
    taskCounts,
    statusCounts,
    failedTasks,
    syncCounts,
    activeBatches,
    runDirectories,
    recentEvents,
    worktreeLeaseDiagnostics,
  };
};
