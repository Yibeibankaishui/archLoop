import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isAllowlistedBeadsRuntimePath } from "./hubBeadsRuntimePaths.js";
import type { HubTaskEvent } from "./hubExecution.js";
import { readTaskEvents } from "./hubRunEventLog.js";
import {
  flattenSectionForLog,
  type SectionBadgesBlock,
  type SectionBlock,
  type SectionGroupBlock,
  type SectionHeaderBlock,
  type SectionProseBlock,
} from "./section.js";
import {
  collectHubWorktreeLeaseDiagnosticsForTasks,
  type HubWorktreeLeaseDiagnostic,
  type HubWorktreeLeaseDiagnosticReason,
} from "./hubWorktreeLeaseDiagnostics.js";
import { evaluateHubManagedBranchCleanup } from "./hubManagedBranchCleanup.js";
import {
  findWorktreeLeaseForTask,
  isInterruptedHubTaskExecution,
} from "./hubTaskInterruptedExecutionDetector.js";
import { latestPhaseCompletionEventByTask } from "./hubTaskRecoveryRouter.js";
import { readHubProjectRegistry } from "./hubProjectRegistry.js";
import {
  formatHubLandingReconciliationMessage,
  hubLandingTaskCloseReaderFromTasks,
  inspectHubLandingTransactions,
} from "./hubLandingReconciliation.js";
import { formatHubLegacyLandingHistoryLines } from "./hubLandingLegacyHistory.js";
import { inspectHubCheckoutOutbox } from "./hubCheckoutProjection.js";
import {
  formatHubTaskStoreMigrationMessage,
  inspectHubTaskStoreMigration,
} from "./hubTaskStoreMigration.js";
import {
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveArchloopUserDataDir,
} from "./projectStatus.js";
import {
  isCompletedHubStatus,
  loadHubTaskBoard,
  hubTaskStatusBoardPresentation,
  mapHubStatusToTaskBoardBucket,
  resolveHubTaskBranch,
  resolveHubTaskSelector,
  TASK_BOARD_BUCKETS,
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
  | "interrupted_execution"
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
  readonly taskStoreDiagnostics?: readonly string[];
  readonly landingDiagnostics?: readonly string[];
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
      (path) => !isAllowlistedBeadsRuntimePath(path),
    ),
    dirtyTaskStoreFiles: dirtyFiles.filter(isAllowlistedBeadsRuntimePath),
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

/**
 * Build the `interrupted_execution` diagnostic for a task the shared detector
 * flags as an interrupted run (an executing status with no live worktree lease).
 *
 * It is `repairable: false`: the next action is `archloop tasks recover <id>`,
 * not `repair-state`, so `repairHubTaskState` leaves it alone. The `nextAction`
 * reflects the task's latest phase-completion event (read through the recovery
 * router's wider phase-completion selection, the same source `recoverHubTask`
 * uses, so the doctor's suggested route and the actual recovery route agree): a
 * finished-phase event means a phase already completed and recovery should
 * advance past it; no event means the execution was interrupted mid-flight and
 * recovery should retry it.
 */
const buildInterruptedExecutionDiagnostic = (
  task: HubTaskProjection,
  leaseState: "active" | "stale" | "missing",
  latestEvent: HubTaskEvent | undefined,
  branch: string,
): HubTaskStateDiagnostic => {
  const phase = task.hubStatus;
  let nextAction: string;
  let message: string;
  if (latestEvent !== undefined) {
    nextAction = `Review/merge already finished — run archloop tasks recover ${task.id} to advance.`;
    message = `Task ${task.id} is stuck in ${phase} with a ${leaseState} worktree lease, but its ${latestEvent.type} event shows a phase already finished; recover to advance instead of redoing finished work.`;
  } else {
    nextAction = `Implement was interrupted — run archloop tasks recover ${task.id} to retry.`;
    message = `Task ${task.id} is stuck in ${phase} with a ${leaseState} worktree lease and no phase-completion event; recover to retry the interrupted execution.`;
  }

  return {
    taskId: task.id,
    title: task.title,
    reason: "interrupted_execution",
    repairable: false,
    currentStatus: task.hubStatus,
    branch,
    eventType: latestEvent?.type,
    nextAction,
    message,
  };
};

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
  const env = input.env ?? process.env;
  const registeredProject = readHubProjectRegistry({ env }).find(
    (project) => project.repoRoot === repoRoot,
  );
  const hubProjectDir =
    registeredProject?.hubProjectDir ??
    resolveHubProjectDir(
      input.archloopUserDataDir ?? resolveArchloopUserDataDir(env),
      repoRoot,
    );
  const board = loadHubTaskBoard(repoRoot, input.env);
  const taskEvents = readTaskEvents(hubProjectDir);
  const mergeReadyEvents = latestMergeReadyEventsByTask(taskEvents);
  // The interrupted-execution next action is enriched with the task's latest
  // phase-completion event via the recovery router's wider selection (it also
  // recognizes the reviewer-flow `task_implementation_succeeded` → reviewing
  // signal), so the doctor's suggested route matches the route `recoverHubTask`
  // would actually take. The doctor's own `mergeReadyEvents` (narrower) stays
  // unchanged for the state_inconsistent / missing_claim_fields paths.
  const phaseCompletionEvents = latestPhaseCompletionEventByTask(taskEvents);
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
  // Tasks already covered by a worktree-lease diagnostic. interrupted_execution
  // dedupes against these (e.g. implementing + active claim + absent lease is
  // already worktree_lease_missing) so a task is never reported twice.
  const leaseDiagnosedTaskIds = new Set<string>();
  for (const leaseDiagnostic of collectHubWorktreeLeaseDiagnosticsForTasks(
    board.tasks,
    leases,
  )) {
    leaseDiagnosedTaskIds.add(leaseDiagnostic.taskId);
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

    // An interrupted execution (executing status with no live worktree lease)
    // that no lease diagnostic already covers falls through to
    // interrupted_execution — the fall-through cases like implementing with a
    // stale lease, or reviewing/merging with a claim and a missing or stale
    // lease. It dedupes against the lease diagnostics above (which already
    // cover implementing + active claim + absent lease as worktree_lease_missing).
    if (!leaseDiagnosedTaskIds.has(task.id)) {
      const lease = findWorktreeLeaseForTask(task, leases);
      const detection = isInterruptedHubTaskExecution(task, lease);
      if (detection.interrupted) {
        const leaseState = lease?.state ?? "missing";
        diagnostics.push(
          buildInterruptedExecutionDiagnostic(
            task,
            leaseState,
            phaseCompletionEvents.get(task.id),
            lease?.branch ??
              task.claim?.branch ??
              resolveHubTaskBranch(task.id, task.title),
          ),
        );
      }
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

  const taskStoreMigration = inspectHubTaskStoreMigration({
    repoRoot,
    hubProjectDir,
  });
  const taskStoreDiagnostics: string[] = [];
  if (
    taskStoreMigration.integrityIncident ||
    taskStoreMigration.pendingReason
  ) {
    taskStoreDiagnostics.push(
      formatHubTaskStoreMigrationMessage(taskStoreMigration),
    );
    if (taskStoreMigration.nextAction) {
      taskStoreDiagnostics.push(
        `Next action: ${taskStoreMigration.nextAction}`,
      );
    }
  }

  const landingReconciliation = inspectHubLandingTransactions({
    repoRoot,
    hubProjectDir,
    readTaskClose: hubLandingTaskCloseReaderFromTasks(board.tasks),
    tasks: board.tasks,
    events: taskEvents,
  });
  const landingDiagnostics: string[] = [];
  if (landingReconciliation.kind !== "clean") {
    landingDiagnostics.push(
      formatHubLandingReconciliationMessage(landingReconciliation),
    );
    landingDiagnostics.push(`Next action: ${landingReconciliation.nextAction}`);
  }
  for (const line of formatHubLegacyLandingHistoryLines(
    landingReconciliation.legacyHistory,
  )) {
    if (!landingDiagnostics.includes(line)) {
      landingDiagnostics.push(line);
    }
  }
  const checkoutSync = inspectHubCheckoutOutbox({ hubProjectDir });
  if (checkoutSync.pendingCount > 0) {
    landingDiagnostics.push(checkoutSync.message);
    landingDiagnostics.push(`Next action: ${checkoutSync.nextAction}`);
  }

  return {
    diagnostics,
    managedBranchCleanupDiagnostics:
      formatHubManagedBranchCleanupDiagnosticsLines(
        managedBranchCleanupEvaluation,
      ),
    taskStoreDiagnostics,
    landingDiagnostics,
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

/** Presentation severity for `archloop tasks doctor` (see `severityColor` in ansi.ts). */
export type HubTaskStateDiagnosticSeverity = "error" | "warn" | "info";

/**
 * Reason → severity. Interrupted/failed work is error; stale claims / pending
 * sync are warn; orphaned or informational cleanup is info. Severity is the
 * grouping axis (`repairable` is not used here).
 */
const DOCTOR_SEVERITY_BY_REASON: Record<
  HubTaskStateDiagnosticReason,
  HubTaskStateDiagnosticSeverity
> = {
  interrupted_execution: "error",
  failed_branch_work: "error",
  worktree_lease_missing: "error",
  worktree_lease_active_with_failed_claim: "error",
  worktree_lease_stale_with_failed_claim: "error",
  state_inconsistent: "warn",
  multiple_status_labels: "warn",
  stale_hub_status_metadata: "warn",
  missing_claim_fields: "warn",
  dirty_worktree: "warn",
  task_sync_push_pending: "warn",
  worktree_lease_active_without_claim: "warn",
  terminal_stale_execution_metadata: "info",
  worktree_lease_active_execution: "info",
};

const DOCTOR_SEVERITY_SYMBOL: Record<
  HubTaskStateDiagnosticSeverity,
  SectionGroupBlock["symbol"]
> = {
  error: "✗",
  warn: "!",
  info: "●",
};

/** Fixed group/badge order: most severe first. */
const DOCTOR_SEVERITY_ORDER: readonly HubTaskStateDiagnosticSeverity[] = [
  "error",
  "warn",
  "info",
];

export interface HubTaskStateDoctorModel {
  readonly header: SectionHeaderBlock;
  readonly badges: SectionBadgesBlock;
  readonly emptyMessage?: SectionProseBlock;
  readonly groups: readonly SectionGroupBlock[];
}

/** Group item shape: id=taskId, title=reason, trailing=nextAction, detail=message. */
interface DoctorDiagnosticItem {
  readonly id: string;
  readonly title: string;
  readonly trailingDim: string;
  readonly detailDim: string;
}

const toDoctorGroupItem = (
  diagnostic: HubTaskStateDiagnostic,
): DoctorDiagnosticItem => ({
  id: diagnostic.taskId,
  title: diagnostic.reason,
  trailingDim: diagnostic.nextAction,
  detailDim: diagnostic.message,
});

const buildDoctorGroup = (
  severity: HubTaskStateDiagnosticSeverity,
  items: readonly DoctorDiagnosticItem[],
): SectionGroupBlock => ({
  kind: "group",
  symbol: DOCTOR_SEVERITY_SYMBOL[severity],
  severity,
  name: severity,
  count: items.length,
  items: [...items].sort((left, right) => left.id.localeCompare(right.id)),
});

const EMPTY_DOCTOR_BADGES: SectionBadgesBlock = {
  kind: "badges",
  badges: [],
};

/**
 * Build the doctor section model from diagnostics. Managed branch cleanup lines
 * stay out of the model — the CLI appends them after `d.section`.
 */
export const buildHubTaskStateDoctorModel = (
  result: DoctorHubTaskStateResult,
): HubTaskStateDoctorModel => {
  const header: SectionHeaderBlock = {
    kind: "header",
    title: "Hub task state doctor",
    right: `${result.diagnostics.length} issues`,
  };

  if (result.diagnostics.length === 0) {
    return {
      header,
      badges: EMPTY_DOCTOR_BADGES,
      emptyMessage: { kind: "prose", body: "No task state issues found." },
      groups: [],
    };
  }

  const bySeverity = new Map<
    HubTaskStateDiagnosticSeverity,
    DoctorDiagnosticItem[]
  >();
  for (const diagnostic of result.diagnostics) {
    const severity = DOCTOR_SEVERITY_BY_REASON[diagnostic.reason];
    const items = bySeverity.get(severity) ?? [];
    items.push(toDoctorGroupItem(diagnostic));
    bySeverity.set(severity, items);
  }

  const groups = DOCTOR_SEVERITY_ORDER.flatMap((severity) => {
    const items = bySeverity.get(severity);
    return items === undefined ? [] : [buildDoctorGroup(severity, items)];
  });

  return {
    header,
    badges: {
      kind: "badges",
      badges: groups.map((group) => ({
        symbol: group.symbol,
        count: group.count,
        label: group.name,
        severity: group.severity,
      })),
    },
    groups,
  };
};

/** Map the doctor model to blocks for `d.section` / `renderSection`. */
export const hubTaskStateDoctorModelToBlocks = (
  model: HubTaskStateDoctorModel,
): readonly SectionBlock[] => [
  model.header,
  ...(model.emptyMessage
    ? [model.emptyMessage]
    : [model.badges, ...model.groups]),
];

/**
 * Plain, grep-friendly doctor text via `flattenSectionForLog`, then append
 * managed branch cleanup lines verbatim. Live CLI uses the same blocks through
 * `d.section` (palette already degrades under NO_COLOR / non-TTY / `--plain`).
 */
export const formatHubTaskStateDoctorLines = (
  result: DoctorHubTaskStateResult,
): readonly string[] => {
  const blocks = hubTaskStateDoctorModelToBlocks(
    buildHubTaskStateDoctorModel(result),
  );
  return [
    ...flattenSectionForLog(blocks),
    ...(result.taskStoreDiagnostics ?? []),
    ...(result.landingDiagnostics ?? []),
    ...result.managedBranchCleanupDiagnostics,
  ];
};

export interface HubTaskStateRepairModel {
  readonly header: SectionHeaderBlock;
  readonly emptyMessage?: SectionProseBlock;
  readonly groups: readonly SectionGroupBlock[];
  readonly guidance?: SectionProseBlock;
}

interface RepairGroupItem {
  readonly id: string;
  readonly title: string;
  readonly trailingDim: string;
}

const resolveRepairBranch = (repair: HubTaskStatePlannedRepair): string =>
  repair.branch ?? resolveHubTaskBranch(repair.taskId, repair.title);

const toRepairGroupItem = (
  repair: HubTaskStatePlannedRepair,
): RepairGroupItem => ({
  id: repair.taskId,
  title: repair.reason,
  trailingDim: resolveRepairBranch(repair),
});

const buildRepairStatusGroup = (
  targetStatus: HubTaskStatus,
  items: readonly RepairGroupItem[],
): SectionGroupBlock => {
  const { symbol, severity } = hubTaskStatusBoardPresentation(targetStatus);
  return {
    kind: "group",
    symbol,
    severity,
    name: targetStatus,
    count: items.length,
    items: [...items].sort((left, right) => left.id.localeCompare(right.id)),
  };
};

const formatRepairCount = (count: number): string =>
  count === 1 ? "1 repair" : `${count} repairs`;

const compareRepairTargetStatuses = (
  left: HubTaskStatus,
  right: HubTaskStatus,
): number => {
  const bucketDiff =
    TASK_BOARD_BUCKETS.indexOf(mapHubStatusToTaskBoardBucket(left)) -
    TASK_BOARD_BUCKETS.indexOf(mapHubStatusToTaskBoardBucket(right));
  return bucketDiff !== 0 ? bucketDiff : left.localeCompare(right);
};

/**
 * Build the repair-state section model. Groups planned/applied repairs by
 * target Hub status; each group's severity/symbol comes from the shared
 * board-bucket presentation (`hubTaskStatusBoardPresentation`).
 */
export const buildHubTaskStateRepairModel = (
  result: RepairHubTaskStateResult,
): HubTaskStateRepairModel => {
  const header: SectionHeaderBlock = {
    kind: "header",
    title: "Hub task state repair",
  };

  if (result.plannedRepairs.length === 0) {
    return {
      header,
      emptyMessage: {
        kind: "prose",
        body: "No repairable task state issues found.",
      },
      groups: [],
    };
  }

  const byTarget = new Map<HubTaskStatus, RepairGroupItem[]>();
  for (const repair of result.plannedRepairs) {
    const items = byTarget.get(repair.targetStatus) ?? [];
    items.push(toRepairGroupItem(repair));
    byTarget.set(repair.targetStatus, items);
  }

  const groups = [...byTarget.entries()]
    .sort(([left], [right]) => compareRepairTargetStatuses(left, right))
    .map(([status, items]) => buildRepairStatusGroup(status, items));

  return {
    header: {
      ...header,
      subtitle: result.applied ? "Applied repairs" : "Planned repairs",
      right: formatRepairCount(result.plannedRepairs.length),
    },
    groups,
    guidance: result.applied
      ? undefined
      : {
          kind: "prose",
          body: "Re-run with --yes to apply these local Beads mutations.",
        },
  };
};

/** Map the repair model to blocks for `d.section` / `renderSection`. */
export const hubTaskStateRepairModelToBlocks = (
  model: HubTaskStateRepairModel,
): readonly SectionBlock[] => {
  if (model.emptyMessage) {
    return [model.header, model.emptyMessage];
  }
  return [
    model.header,
    ...model.groups,
    ...(model.guidance ? [model.guidance] : []),
  ];
};

/**
 * Plain, grep-friendly repair text via `flattenSectionForLog`. Live CLI uses
 * the same blocks through `d.section` (palette already degrades under NO_COLOR /
 * non-TTY / `--plain`).
 */
export const formatHubTaskStateRepairLines = (
  result: RepairHubTaskStateResult,
): readonly string[] =>
  flattenSectionForLog(
    hubTaskStateRepairModelToBlocks(buildHubTaskStateRepairModel(result)),
  );
