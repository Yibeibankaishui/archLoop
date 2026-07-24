import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { HubTaskEvent } from "./hubExecution.js";
import { readTaskEvents } from "./hubRunEventLog.js";
import {
  collectHubWorktreeLeaseDiagnosticsForTasks,
  type HubWorktreeLeaseDiagnostic,
  type HubWorktreeLeaseDiagnosticReason,
} from "./hubWorktreeLeaseDiagnostics.js";
import { evaluateHubManagedBranchCleanup } from "./hubManagedBranchCleanup.js";
import {
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveArchloopUserDataDir,
} from "./projectStatus.js";
import {
  isCompletedHubStatus,
  loadHubTaskBoard,
  resolveHubTaskBranch,
  resolveHubTaskSelector,
  transitionHubTaskStatus,
  formatHubManagedBranchCleanupDiagnosticsLines,
  type HubTaskProjection,
  type HubTaskStatus,
} from "./taskBoard.js";
import { listWorktreeLeases } from "./worktreeLeaseStore.js";

const execFileAsync = promisify(execFile);

export interface HubTaskStateBranchState {
  readonly exists: boolean;
  readonly hasUnmergedWork: boolean;
}

export interface HubTaskStateWorktreeState {
  readonly dirtySourceFiles: readonly string[];
  readonly dirtyTaskStoreFiles: readonly string[];
}

export type HubTaskStateBranchInspector = (
  branch: string,
  cwd: string,
) => Promise<HubTaskStateBranchState>;

export type HubTaskStateWorktreeInspector = (
  cwd: string,
) => Promise<HubTaskStateWorktreeState>;

export type HubTaskStateDiagnosticReason =
  | "state_inconsistent"
  | "multiple_status_labels"
  | "stale_hub_status_metadata"
  | "missing_claim_fields"
  | "failed_branch_work"
  | "terminal_stale_execution_metadata"
  | "dirty_worktree"
  | "task_sync_push_pending"
  | HubWorktreeLeaseDiagnosticReason;

export interface HubTaskStateDiagnostic {
  readonly taskId: string;
  readonly title: string;
  readonly reason: HubTaskStateDiagnosticReason;
  readonly message: string;
  readonly nextAction: string;
  readonly repairable: boolean;
  readonly currentStatus: HubTaskStatus;
  readonly targetStatus?: HubTaskStatus;
  readonly branch?: string;
  readonly eventType?: HubTaskEvent["type"];
  readonly missingClaimFields?: readonly string[];
  readonly repairClaim?: Readonly<Record<string, unknown>>;
}

export interface DoctorHubTaskStateInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly archloopUserDataDir?: string;
  readonly branchInspector?: HubTaskStateBranchInspector;
  readonly worktreeInspector?: HubTaskStateWorktreeInspector;
  readonly listWorktreeLeases?: typeof listWorktreeLeases;
}

export interface DoctorHubTaskStateResult {
  readonly diagnostics: readonly HubTaskStateDiagnostic[];
  readonly managedBranchCleanupDiagnostics: readonly string[];
}

export interface HubTaskStatePlannedRepair {
  readonly taskId: string;
  readonly title: string;
  readonly targetStatus: HubTaskStatus;
  readonly reason: HubTaskStateDiagnosticReason;
  readonly branch?: string;
}

export interface RepairHubTaskStateInput extends DoctorHubTaskStateInput {
  readonly taskSelector: string;
  readonly yes?: boolean;
}

export interface RepairHubTaskStateResult {
  readonly applied: boolean;
  readonly plannedRepairs: readonly HubTaskStatePlannedRepair[];
}

const HUB_STATUS_LABELS: Readonly<Record<HubTaskStatus, string>> = {
  inbox: "needs-triage",
  needs_info: "needs-info",
  ready_for_agent: "ready-for-agent",
  ready_for_human: "ready-for-human",
  blocked: "blocked",
  implementing: "implementing",
  reviewing: "reviewing",
  waiting_for_merge: "waiting-for-merge",
  merging: "merging",
  failed: "failed",
  done: "done",
  wontfix: "wontfix",
  sync_conflict: "sync-conflict",
};

const normalizeLabel = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const ARCHLOOP_STATUS_LABELS = new Set(
  Object.values(HUB_STATUS_LABELS).map(normalizeLabel),
);
const CLAIM_REQUIRED_STATUSES = new Set<HubTaskStatus>([
  "implementing",
  "reviewing",
  "waiting_for_merge",
  "merging",
]);

const HUB_STATUS_VALUES = new Set<string>([
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
]);

const normalizeHubStatusValue = (value: unknown): HubTaskStatus | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeLabel(value);
  return HUB_STATUS_VALUES.has(normalized)
    ? (normalized as HubTaskStatus)
    : undefined;
};

const isMergeReadyEvent = (event: HubTaskEvent): boolean =>
  event.type === "task_review_succeeded" ||
  (event.type === "task_implementation_succeeded" &&
    event.status === "waiting_for_merge");

const latestMergeReadyEventsByTask = (
  events: readonly HubTaskEvent[],
): ReadonlyMap<string, HubTaskEvent> => {
  const byTask = new Map<string, HubTaskEvent>();
  for (const event of events) {
    if (!isMergeReadyEvent(event)) {
      continue;
    }
    byTask.set(event.taskId, event);
  }
  return byTask;
};

const collectMissingClaimFields = (
  task: HubTaskProjection,
): readonly string[] => {
  if (!task.claim) {
    return ["runId", "batchId", "branch"];
  }

  return (["runId", "batchId", "branch"] as const).filter(
    (field) => !task.claim?.[field],
  );
};

const hasStaleClaimFields = (
  task: HubTaskProjection,
  event: HubTaskEvent,
): boolean => {
  if (!task.claim) {
    return false;
  }

  return (["runId", "batchId", "branch"] as const).some((field) => {
    const actualValue = task.claim?.[field];
    const expectedValue =
      field === "runId"
        ? event.runId
        : field === "batchId"
          ? event.batchId
          : event.branch;
    return Boolean(
      actualValue && expectedValue && actualValue !== expectedValue,
    );
  });
};

const defaultBranchInspector: HubTaskStateBranchInspector = async (
  branch,
  cwd,
) => {
  try {
    await execFileAsync(
      "git",
      ["rev-parse", "--verify", `${branch}^{commit}`],
      { cwd },
    );
  } catch {
    return { exists: false, hasUnmergedWork: false };
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", `HEAD..${branch}`],
      { cwd, encoding: "utf8" },
    );
    return {
      exists: true,
      hasUnmergedWork: Number(String(stdout).trim()) > 0,
    };
  } catch {
    return { exists: true, hasUnmergedWork: false };
  }
};

const normalizeGitPath = (path: string): string => path.replace(/\\/g, "/");

const isTaskStoreRuntimePath = (path: string): boolean => {
  const normalized = normalizeGitPath(path);
  return normalized === ".beads" || normalized.startsWith(".beads/");
};

const parseGitStatusPorcelain = (stdout: string): string[] => {
  const entries = stdout.split("\0").filter((entry) => entry.length > 0);
  const paths: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length > 0) {
      paths.push(path);
    }

    if (status.includes("R") || status.includes("C")) {
      index += 1;
      const renamedPath = entries[index];
      if (renamedPath && renamedPath.length > 0) {
        paths.push(renamedPath);
      }
    }
  }

  return paths;
};

const defaultWorktreeInspector: HubTaskStateWorktreeInspector = async (cwd) => {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd, encoding: "utf8" },
  );
  const dirtyFiles = parseGitStatusPorcelain(String(stdout));
  return {
    dirtySourceFiles: dirtyFiles.filter(
      (path) => !isTaskStoreRuntimePath(path),
    ),
    dirtyTaskStoreFiles: dirtyFiles.filter(isTaskStoreRuntimePath),
  };
};

const buildStateInconsistentDiagnostic = (
  task: HubTaskProjection,
  event: HubTaskEvent,
): HubTaskStateDiagnostic => ({
  taskId: task.id,
  title: task.title,
  reason: "state_inconsistent",
  repairable: true,
  currentStatus: task.hubStatus,
  targetStatus: "waiting_for_merge",
  branch: event.branch,
  eventType: event.type,
  missingClaimFields: collectMissingClaimFields(task),
  repairClaim: {
    runId: event.runId,
    batchId: event.batchId,
    branch: event.branch,
    claimedAt: event.createdAt,
  },
  nextAction: `archloop tasks repair-state ${task.id}`,
  message: `Hub run events show ${event.type} for ${event.branch}, but Beads projects ${task.hubStatus}. Repair local task state before rerunning the flow.`,
});

const buildDirtyWorktreeDiagnostic = (
  task: HubTaskProjection,
  dirtySourceFiles: readonly string[],
): HubTaskStateDiagnostic => ({
  taskId: task.id,
  title: task.title,
  reason: "dirty_worktree",
  repairable: false,
  currentStatus: task.hubStatus,
  branch: task.claim?.branch,
  nextAction:
    "Commit, stash, or discard dirty source files, then rerun the flow.",
  message: `Git safety gate: dirty source files (${dirtySourceFiles.join(", ")}) block merge selection. This is not repairable Beads task-state pollution.`,
});

const buildMultipleStatusLabelsDiagnostic = (
  task: HubTaskProjection,
  statusLabels: readonly string[],
): HubTaskStateDiagnostic => ({
  taskId: task.id,
  title: task.title,
  reason: "multiple_status_labels",
  repairable: true,
  currentStatus: task.hubStatus,
  targetStatus: task.hubStatus,
  branch: task.claim?.branch,
  nextAction: `archloop tasks repair-state ${task.id}`,
  message: `Beads labels contain multiple archLoop status labels (${statusLabels.join(", ")}). Repair rewrites only archLoop-managed status labels and preserves user labels.`,
});

const buildStaleHubStatusMetadataDiagnostic = (
  task: HubTaskProjection,
  metadataStatus: HubTaskStatus,
): HubTaskStateDiagnostic => ({
  taskId: task.id,
  title: task.title,
  reason: "stale_hub_status_metadata",
  repairable: true,
  currentStatus: task.hubStatus,
  targetStatus: task.hubStatus,
  branch: task.claim?.branch,
  nextAction: `archloop tasks repair-state ${task.id}`,
  message: `Beads metadata.hubStatus is ${metadataStatus}, but the Hub task board projects ${task.hubStatus}. Repair rewrites archLoop-managed metadata only.`,
});

const buildMissingClaimFieldsDiagnostic = (
  task: HubTaskProjection,
  missingClaimFields: readonly string[],
): HubTaskStateDiagnostic => ({
  taskId: task.id,
  title: task.title,
  reason: "missing_claim_fields",
  repairable: false,
  currentStatus: task.hubStatus,
  missingClaimFields,
  nextAction:
    "Rerun the flow to recreate execution claim metadata, or recover the task if the execution was abandoned.",
  message: `Hub status ${task.hubStatus} requires execution claim metadata, but missing ${missingClaimFields.join(", ")}.`,
});

const buildFailedBranchWorkDiagnostic = (
  task: HubTaskProjection,
): HubTaskStateDiagnostic => ({
  taskId: task.id,
  title: task.title,
  reason: "failed_branch_work",
  repairable: false,
  currentStatus: task.hubStatus,
  branch: task.claim?.branch,
  nextAction: `archloop tasks recover ${task.id}`,
  message: `Failed task still has unmerged branch work on ${task.claim?.branch ?? "<missing>"}. Use recovery policy rather than repair-state.`,
});

const buildTerminalStaleExecutionMetadataDiagnostic = (
  task: HubTaskProjection,
): HubTaskStateDiagnostic => ({
  taskId: task.id,
  title: task.title,
  reason: "terminal_stale_execution_metadata",
  repairable: true,
  currentStatus: task.hubStatus,
  targetStatus: task.hubStatus,
  branch: task.claim?.branch,
  nextAction: `archloop tasks repair-state ${task.id}`,
  message: `Terminal task ${task.hubStatus} still has execution claim metadata. Repair clears stale execution metadata without changing completion state.`,
});

const buildTaskSyncPushPendingDiagnostic = (
  task: HubTaskProjection,
): HubTaskStateDiagnostic => ({
  taskId: task.id,
  title: task.title,
  reason: "task_sync_push_pending",
  repairable: false,
  currentStatus: task.hubStatus,
  nextAction: "archloop tasks push",
  message:
    "Local task state is pending remote sync. Use task sync push; doctor and repair-state do not mutate remote GitHub issues.",
});

const buildWorktreeLeaseDiagnostic = (
  diagnostic: HubWorktreeLeaseDiagnostic,
  task: HubTaskProjection | undefined,
): HubTaskStateDiagnostic => ({
  taskId: diagnostic.taskId,
  title: diagnostic.title,
  reason: diagnostic.reason,
  repairable: false,
  currentStatus: task?.hubStatus ?? "inbox",
  branch: diagnostic.branch,
  nextAction: diagnostic.nextAction,
  message: diagnostic.message,
});

const collectArchLoopStatusLabels = (
  task: HubTaskProjection,
): readonly string[] =>
  task.labels.filter((label) =>
    ARCHLOOP_STATUS_LABELS.has(normalizeLabel(label)),
  );

export const doctorHubTaskState = async (
  input: DoctorHubTaskStateInput,
): Promise<DoctorHubTaskStateResult> => {
  const repoRoot = resolveGitRepoRoot(input.cwd);
  const hubProjectDir = resolveHubProjectDir(
    input.archloopUserDataDir ??
      resolveArchloopUserDataDir(input.env ?? process.env),
    repoRoot,
  );
  const board = loadHubTaskBoard(repoRoot, input.env);
  const mergeReadyEvents = latestMergeReadyEventsByTask(
    readTaskEvents(hubProjectDir),
  );
  const branchInspector = input.branchInspector ?? defaultBranchInspector;
  const worktreeState = await (
    input.worktreeInspector ?? defaultWorktreeInspector
  )(repoRoot);
  const leases = (input.listWorktreeLeases ?? listWorktreeLeases)(repoRoot);
  const managedBranchCleanupEvaluation = await evaluateHubManagedBranchCleanup({
    cwd: input.cwd,
    env: input.env,
    hubProjectDir,
  });

  const diagnostics: HubTaskStateDiagnostic[] = [];
  for (const leaseDiagnostic of collectHubWorktreeLeaseDiagnosticsForTasks(
    board.tasks,
    leases,
  )) {
    diagnostics.push(
      buildWorktreeLeaseDiagnostic(
        leaseDiagnostic,
        board.tasks.find((task) => task.id === leaseDiagnostic.taskId),
      ),
    );
  }

  for (const task of board.tasks) {
    const statusLabels = collectArchLoopStatusLabels(task);
    if (statusLabels.length > 1) {
      diagnostics.push(buildMultipleStatusLabelsDiagnostic(task, statusLabels));
    }

    if (task.hubStatus === "failed" && task.claim?.branch) {
      const branchState = await branchInspector(task.claim.branch, repoRoot);
      if (branchState.exists && branchState.hasUnmergedWork) {
        diagnostics.push(buildFailedBranchWorkDiagnostic(task));
      }
    }

    if (isCompletedHubStatus(task.hubStatus) && task.claim) {
      diagnostics.push(buildTerminalStaleExecutionMetadataDiagnostic(task));
    }

    if (
      task.metadata.sync_state === "push_pending" ||
      task.metadata.syncState === "push_pending"
    ) {
      diagnostics.push(buildTaskSyncPushPendingDiagnostic(task));
    }

    const metadataStatus = normalizeHubStatusValue(task.metadata.hubStatus);
    if (metadataStatus && metadataStatus !== task.hubStatus) {
      diagnostics.push(
        buildStaleHubStatusMetadataDiagnostic(task, metadataStatus),
      );
    }

    if (
      task.hubStatus === "waiting_for_merge" &&
      task.claim?.branch &&
      worktreeState.dirtySourceFiles.length > 0
    ) {
      const branchState = await branchInspector(task.claim.branch, repoRoot);
      if (branchState.exists && branchState.hasUnmergedWork) {
        diagnostics.push(
          buildDirtyWorktreeDiagnostic(task, worktreeState.dirtySourceFiles),
        );
        continue;
      }
    }

    const event = mergeReadyEvents.get(task.id);
    const missingClaimFields = collectMissingClaimFields(task);
    if (
      !event &&
      CLAIM_REQUIRED_STATUSES.has(task.hubStatus) &&
      missingClaimFields.length > 0
    ) {
      diagnostics.push(
        buildMissingClaimFieldsDiagnostic(task, missingClaimFields),
      );
    }

    if (!event || isCompletedHubStatus(task.hubStatus)) {
      continue;
    }

    const branchState = await branchInspector(event.branch, repoRoot);
    if (
      branchState.exists &&
      branchState.hasUnmergedWork &&
      (task.hubStatus !== "waiting_for_merge" ||
        missingClaimFields.length > 0 ||
        hasStaleClaimFields(task, event))
    ) {
      diagnostics.push(buildStateInconsistentDiagnostic(task, event));
    }
  }

  return {
    diagnostics,
    managedBranchCleanupDiagnostics:
      formatHubManagedBranchCleanupDiagnosticsLines(
        managedBranchCleanupEvaluation,
      ),
  };
};

export const repairHubTaskState = async (
  input: RepairHubTaskStateInput,
): Promise<RepairHubTaskStateResult> => {
  const repoRoot = resolveGitRepoRoot(input.cwd);
  const task = resolveHubTaskSelector(repoRoot, input.taskSelector, input.env);
  const doctorResult = await doctorHubTaskState(input);
  const plannedRepairs = doctorResult.diagnostics
    .filter((diagnostic) => diagnostic.taskId === task.id)
    .filter(
      (
        diagnostic,
      ): diagnostic is HubTaskStateDiagnostic & {
        readonly targetStatus: HubTaskStatus;
      } => diagnostic.repairable && diagnostic.targetStatus !== undefined,
    )
    .map((diagnostic) => ({
      taskId: diagnostic.taskId,
      title: diagnostic.title,
      targetStatus: diagnostic.targetStatus,
      reason: diagnostic.reason,
      branch: diagnostic.branch,
    }));

  if (!input.yes) {
    return { applied: false, plannedRepairs };
  }

  for (const repair of plannedRepairs) {
    const diagnostic = doctorResult.diagnostics.find(
      (entry) =>
        entry.taskId === repair.taskId && entry.reason === repair.reason,
    );
    transitionHubTaskStatus({
      cwd: repoRoot,
      taskId: repair.taskId,
      hubStatus: repair.targetStatus,
      metadata: {
        claim: diagnostic?.repairClaim,
      },
      replaceClaimMetadata: diagnostic?.repairClaim !== undefined,
      env: input.env,
    });
  }

  return { applied: plannedRepairs.length > 0, plannedRepairs };
};

const actionLabel = (diagnostic: HubTaskStateDiagnostic): string => {
  if (diagnostic.nextAction.startsWith("archloop tasks repair-state")) {
    return "repair state";
  }
  if (diagnostic.nextAction.startsWith("archloop tasks recover")) {
    return "recover failed task";
  }
  if (diagnostic.nextAction.startsWith("archloop tasks push")) {
    return "push task sync";
  }
  if (diagnostic.nextAction.startsWith("Wait")) {
    return "wait for execution";
  }
  if (diagnostic.nextAction.includes("Rerun the flow")) {
    return "rerun flow";
  }
  return "rerun flow";
};

export const formatHubTaskStateDoctorLines = (
  result: DoctorHubTaskStateResult,
): readonly string[] => {
  const lines = ["Hub task state doctor"];
  if (result.diagnostics.length === 0) {
    lines.push("No task state issues found.");
  } else {
    lines.push(`Issues found: ${result.diagnostics.length}`);
    for (const diagnostic of result.diagnostics) {
      const branch = diagnostic.branch ? ` ${diagnostic.branch}` : "";
      lines.push(
        `  ${diagnostic.taskId}: ${diagnostic.reason}${branch}; next action: ${actionLabel(diagnostic)} (${diagnostic.nextAction})`,
      );
      lines.push(`    ${diagnostic.message}`);
    }
  }
  for (const line of result.managedBranchCleanupDiagnostics) {
    lines.push(line);
  }
  return lines;
};

export const formatHubTaskStateRepairLines = (
  result: RepairHubTaskStateResult,
): readonly string[] => {
  const lines = ["Hub task state repair"];
  if (result.plannedRepairs.length === 0) {
    lines.push("No repairable task state issues found.");
    return lines;
  }

  lines.push(result.applied ? "Applied repairs:" : "Planned repairs:");
  for (const repair of result.plannedRepairs) {
    const branch =
      repair.branch ?? resolveHubTaskBranch(repair.taskId, repair.title);
    lines.push(
      `  ${repair.taskId}: ${repair.reason} -> ${repair.targetStatus} (${branch})`,
    );
  }
  if (!result.applied) {
    lines.push("Re-run with --yes to apply these local Beads mutations.");
  }
  return lines;
};
