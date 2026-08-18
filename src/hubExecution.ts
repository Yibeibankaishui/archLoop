import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveArchloopUserDataDir,
} from "./projectStatus.js";

export interface HubRunContext {
  readonly hubProjectDir: string;
  readonly runId: string;
  readonly batchId: string;
  readonly runDir: string;
  readonly eventsDir: string;
  readonly runEventsPath: string;
  readonly batchEventsPath: string;
  readonly taskEventsPath: string;
}

export interface CreateHubRunContextOptions {
  readonly cwd?: string;
  readonly hubProjectDir?: string;
  readonly branch: string;
  readonly runId?: string;
  readonly batchId?: string;
  readonly startedAt?: Date;
  readonly env?: NodeJS.ProcessEnv;
}

export interface HubTaskClaimMetadata {
  readonly runId: string | undefined;
  readonly batchId: string | undefined;
  readonly taskId?: string;
  readonly branch: string | undefined;
  readonly claimedAt: string | undefined;
  readonly baseHead?: string;
  readonly branchExistedBeforeClaim?: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface HubRunStartedEvent {
  readonly type: "run_started";
  readonly runId: string;
  readonly branch: string;
  readonly startedAt: string;
  readonly repoRoot: string;
  readonly hubProjectDir: string;
}

export interface HubRunCompletedBatchResult {
  readonly batchId: string;
  readonly selectedTaskIds: readonly string[];
  readonly completedTaskCount: number;
  readonly batchStatus: "completed" | "failed" | "pending";
}

export type HubRunStopReason =
  | "no_ready_tasks"
  | "max_batches_reached"
  | "batch_failed"
  | "batch_pending";

export interface HubRunCompletedEvent {
  readonly type: "run_completed";
  readonly runId: string;
  readonly flowId: string;
  readonly createdAt: string;
  readonly completedBatchCount: number;
  readonly completedTaskCount: number;
  readonly stopReason: HubRunStopReason;
  readonly batchResults: readonly HubRunCompletedBatchResult[];
}

export interface HubTaskStoreMigrationEvent {
  readonly type: "task_store_migration";
  readonly runId: string;
  readonly createdAt: string;
  readonly kind: "migrated" | "not_needed" | "deferred" | "split_brain";
  readonly phase?: string;
  readonly beadsDir: string;
  readonly message: string;
  readonly reason?: string;
  readonly pendingUntil?: string;
}

export interface HubLandingReconciliationEvent {
  readonly type: "landing_reconciliation";
  readonly runId: string;
  readonly createdAt: string;
  readonly kind: "clean" | "pending" | "reconciled" | "integrity_incident";
  readonly pendingCount: number;
  readonly reconstructedCount?: number;
  readonly message: string;
  readonly integrityIncident?: string;
}

export interface HubBatchStartedEvent {
  readonly type: "batch_started";
  readonly runId: string;
  readonly batchId: string;
  readonly branch: string;
  readonly startedAt: string;
}

export interface HubBatchPlannedEvent {
  readonly type: "batch_planned";
  readonly runId: string;
  readonly batchId: string;
  readonly flowId: string;
  readonly createdAt: string;
  readonly taskIds: readonly string[];
  readonly tasks?: readonly {
    readonly taskId: string;
    readonly title: string;
  }[];
  readonly batchStrategyRequested?: string;
  readonly batchStrategyUsed?: string;
  readonly maxTasks?: number;
  readonly deferredTasks?: readonly {
    readonly taskId: string;
    readonly reason: string;
  }[];
  readonly fallbackReason?: string;
  readonly diagnosticReason?: string;
  readonly rationale?: string;
}

export interface HubBatchMergeStartedEvent {
  readonly type: "batch_merge_started";
  readonly runId: string;
  readonly batchId: string;
  readonly createdAt: string;
  readonly taskIds: readonly string[];
}

export interface HubBatchMergeSelectionEvent {
  readonly type: "batch_merge_selection";
  readonly runId: string;
  readonly batchId: string;
  readonly createdAt: string;
  readonly selectedTaskIds: readonly string[];
  readonly diagnostics: readonly object[];
}

export interface HubBatchMergeCompletedEvent {
  readonly type: "batch_merge_completed";
  readonly runId: string;
  readonly batchId: string;
  readonly createdAt: string;
  readonly taskIds: readonly string[];
  readonly batchStatus: "done" | "partial_failed" | "pending";
  readonly failedTaskId?: string;
  readonly failureReason?: string;
  readonly failureSummary?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  readonly taskResults?: readonly {
    readonly taskId: string;
    readonly outcome: string;
    readonly hubStatus: string;
    readonly reason?: string;
    readonly transactionId?: string;
    readonly sourceOid?: string;
    readonly baseOid?: string;
    readonly candidateOid?: string;
  }[];
}

export interface HubTaskEvent {
  readonly type:
    | "task_claimed"
    | "task_claim_skipped"
    | "task_retry_blocked"
    | "task_provider_retry"
    | "task_notes_applied"
    | "task_notes_rejected"
    | "task_implementation_started"
    | "task_implementation_succeeded"
    | "task_implementation_failed"
    | "task_review_started"
    | "task_review_succeeded"
    | "task_review_failed"
    | "merge_started"
    | "merge_succeeded"
    | "merge_failed"
    | "merge_conflict_resolution_started"
    | "merge_conflict_resolution_succeeded"
    | "merge_conflict_resolution_failed"
    | "integration_candidate_created"
    | "verification_started"
    | "verification_passed"
    | "candidate_verification_passed"
    | "verification_failed"
    | "target_landing_succeeded"
    | "target_landing_rebuild"
    | "target_landing_pending"
    | "target_landing_stale_owner_rejected"
    | "target_quiet_wait"
    | "speculative_suffix_invalidated"
    | "host_contribution_reconciled"
    | "checkout_sync_pending"
    | "checkout_sync_succeeded"
    | "target_publish_pending"
    | "target_publish_succeeded"
    | "task_close_started"
    | "task_closed"
    | "task_close_succeeded"
    | "task_close_failed"
    | "task_branch_cleanup"
    | "task_status_advanced";
  readonly runId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly createdAt: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly failureReason?: string;
  readonly diagnosticSummary?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  readonly commitCount?: number;
  readonly branchHasUnmergedWork?: boolean;
  readonly implementationWork?: "new_commits" | "existing_unmerged_work";
  readonly claim?: HubTaskClaimMetadata;
  readonly cleanup?: {
    readonly policy: "safe_managed";
    readonly outcome: "deleted" | "skipped" | "failed";
    readonly reasonCodes?: readonly string[];
    readonly diagnosticSummary?: string;
    readonly diagnostics?: Readonly<Record<string, unknown>>;
  };
  readonly transactionId?: string;
  readonly sourceOid?: string;
  readonly baseOid?: string;
  readonly candidateOid?: string;
  readonly predecessorOid?: string;
  readonly publishTargetOid?: string;
  readonly expectedTargetOid?: string;
  readonly observedTargetOid?: string;
  readonly expectedFenceOid?: string;
  readonly observedFenceOid?: string;
  readonly fenceOid?: string;
  readonly verifierFingerprint?: string;
  readonly filteredBeadsRuntimePaths?: readonly string[];
  readonly remoteRef?: string;
  readonly expectedRemoteOid?: string;
  readonly fifoPosition?: number;
  readonly verificationConcurrency?: number;
  readonly suffixInvalidatedTaskIds?: readonly string[];
  readonly hostContributionRelation?: string;
}

type HubRunEventData =
  | HubRunStartedEvent
  | HubRunCompletedEvent
  | HubTaskStoreMigrationEvent
  | HubLandingReconciliationEvent
  | HubBatchStartedEvent
  | HubBatchPlannedEvent
  | HubBatchMergeSelectionEvent
  | HubBatchMergeStartedEvent
  | HubBatchMergeCompletedEvent
  | HubTaskEvent;

export type HubRunEvent = HubRunEventData & {
  readonly eventId: string;
  readonly sequence: number;
};

export type HubRunEventObserver = (
  event: HubRunEvent,
) => void | PromiseLike<void>;

const hubRunEventObserver = new AsyncLocalStorage<HubRunEventObserver>();

export const observeHubRunEvents = <T>(
  observer: HubRunEventObserver | undefined,
  operation: () => T,
): T =>
  observer === undefined
    ? operation()
    : hubRunEventObserver.run(observer, operation);

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

const readBoolean = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value === "true") {
        return true;
      }
      if (value === "false") {
        return false;
      }
    }
  }
  return undefined;
};

const readClaimRecord = (
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined => {
  const nested = readObject(
    metadata.claim ??
      metadata.hubClaim ??
      metadata.hub_claim ??
      metadata.taskClaim,
  );
  if (Object.keys(nested).length > 0) {
    return nested;
  }

  const hasFlatClaimFields = ["runId", "batchId", "branch", "claimedAt"].every(
    (key) => {
      const value = metadata[key];
      return typeof value === "string" && value.trim().length > 0;
    },
  );

  return hasFlatClaimFields ? readObject(metadata) : undefined;
};

const writeJsonl = (path: string, record: unknown): void => {
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
};

const hubRunEventSequences = new Map<string, number>();

const readPersistedHubRunEventSequence = (eventsDir: string): number => {
  let eventCount = 0;
  let maximumSequence = 0;
  for (const filename of ["run.jsonl", "batch.jsonl", "task.jsonl"]) {
    const path = join(eventsDir, filename);
    if (!existsSync(path)) {
      continue;
    }
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.length === 0) {
        continue;
      }
      eventCount += 1;
      try {
        const parsed = JSON.parse(line) as { readonly sequence?: unknown };
        if (typeof parsed.sequence === "number") {
          maximumSequence = Math.max(maximumSequence, parsed.sequence);
        }
      } catch {
        // Existing event readers remain responsible for reporting corrupt JSONL.
      }
    }
  }
  return Math.max(eventCount, maximumSequence);
};

const appendHubEvent = <T extends HubRunEventData>(
  directory: string,
  path: string,
  event: T,
): string => {
  mkdirSync(directory, { recursive: true });
  const currentSequence =
    hubRunEventSequences.get(directory) ??
    readPersistedHubRunEventSequence(directory);
  const sequence = currentSequence + 1;
  hubRunEventSequences.set(directory, sequence);
  const observedEvent = {
    ...event,
    eventId: `${event.runId}:${sequence}`,
    sequence,
  } as HubRunEvent;
  writeJsonl(path, observedEvent);
  try {
    const observation = hubRunEventObserver.getStore()?.(observedEvent);
    if (observation !== undefined) {
      void Promise.resolve(observation).catch(() => undefined);
    }
  } catch {
    // Presentation failures must not change the persisted run lifecycle.
  }
  return path;
};

export const createHubRunIdentifiers = (): {
  readonly runId: string;
  readonly batchId: string;
} => ({
  runId: `run-${randomUUID()}`,
  batchId: `batch-${randomUUID()}`,
});

export const resolveHubRunDirectory = (
  hubProjectDir: string,
  runId: string,
): string => join(hubProjectDir, "runs", runId);

export const resolveHubRunEventsDirectory = (runDir: string): string =>
  join(runDir, "events");

export const resolveHubRunEventsPaths = (
  runDir: string,
): {
  readonly runEventsPath: string;
  readonly batchEventsPath: string;
  readonly taskEventsPath: string;
} => {
  const eventsDir = resolveHubRunEventsDirectory(runDir);
  return {
    runEventsPath: join(eventsDir, "run.jsonl"),
    batchEventsPath: join(eventsDir, "batch.jsonl"),
    taskEventsPath: join(eventsDir, "task.jsonl"),
  };
};

export const createHubTaskClaimMetadata = (
  input: Pick<HubTaskClaimMetadata, "runId" | "batchId" | "branch"> & {
    readonly taskId?: string;
    readonly claimedAt?: string;
    readonly baseHead?: string;
    readonly branchExistedBeforeClaim?: boolean;
  },
): HubTaskClaimMetadata => {
  const claimedAt = input.claimedAt ?? new Date().toISOString();
  return {
    runId: input.runId,
    batchId: input.batchId,
    taskId: input.taskId,
    branch: input.branch,
    claimedAt,
    baseHead: input.baseHead,
    branchExistedBeforeClaim: input.branchExistedBeforeClaim,
    raw: {
      runId: input.runId,
      batchId: input.batchId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      branch: input.branch,
      claimedAt,
      ...(input.baseHead === undefined ? {} : { baseHead: input.baseHead }),
      ...(input.branchExistedBeforeClaim === undefined
        ? {}
        : {
            branchExistedBeforeClaim: input.branchExistedBeforeClaim,
          }),
    },
  };
};

export const createHubRunContext = (
  options: CreateHubRunContextOptions,
): HubRunContext => {
  const startedAt = options.startedAt ?? new Date();
  const repoRoot =
    options.cwd !== undefined
      ? resolveGitRepoRoot(options.cwd)
      : resolveGitRepoRoot(process.cwd());
  const hubProjectDir =
    options.hubProjectDir ??
    resolveHubProjectDir(resolveArchloopUserDataDir(options.env), repoRoot);
  const identifiers = createHubRunIdentifiers();
  const ids = {
    runId: options.runId ?? identifiers.runId,
    batchId: options.batchId ?? identifiers.batchId,
  };
  const runDir = resolveHubRunDirectory(hubProjectDir, ids.runId);
  const eventsDir = resolveHubRunEventsDirectory(runDir);
  const paths = resolveHubRunEventsPaths(runDir);

  mkdirSync(eventsDir, { recursive: true });

  if (!options.runId) {
    appendHubEvent(eventsDir, paths.runEventsPath, {
      type: "run_started",
      runId: ids.runId,
      branch: options.branch,
      startedAt: startedAt.toISOString(),
      repoRoot,
      hubProjectDir,
    } satisfies HubRunStartedEvent);

    appendHubEvent(eventsDir, paths.batchEventsPath, {
      type: "batch_started",
      runId: ids.runId,
      batchId: ids.batchId,
      branch: options.branch,
      startedAt: startedAt.toISOString(),
    } satisfies HubBatchStartedEvent);
  }

  return {
    hubProjectDir,
    runId: ids.runId,
    batchId: ids.batchId,
    runDir,
    eventsDir,
    ...paths,
  };
};

export const appendHubRunEvent = (
  runDir: string,
  event:
    | HubRunStartedEvent
    | HubRunCompletedEvent
    | HubTaskStoreMigrationEvent
    | HubLandingReconciliationEvent,
): string => {
  const { runEventsPath } = resolveHubRunEventsPaths(runDir);
  return appendHubEvent(
    resolveHubRunEventsDirectory(runDir),
    runEventsPath,
    event,
  );
};

export const appendHubBatchEvent = (
  runDir: string,
  event:
    | HubBatchStartedEvent
    | HubBatchPlannedEvent
    | HubBatchMergeSelectionEvent
    | HubBatchMergeStartedEvent
    | HubBatchMergeCompletedEvent,
): string => {
  const { batchEventsPath } = resolveHubRunEventsPaths(runDir);
  return appendHubEvent(
    resolveHubRunEventsDirectory(runDir),
    batchEventsPath,
    event,
  );
};

export const appendHubTaskEvent = (
  runDir: string,
  event: HubTaskEvent,
): string => {
  const { taskEventsPath } = resolveHubRunEventsPaths(runDir);
  return appendHubEvent(
    resolveHubRunEventsDirectory(runDir),
    taskEventsPath,
    event,
  );
};

export interface RecordHubTaskStatusAdvancedInput {
  readonly runId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly createdAt: string;
  readonly status: string;
  readonly reason?: string;
  readonly failureReason?: string;
  readonly commitCount?: number;
  readonly branchHasUnmergedWork?: boolean;
  readonly implementationWork?: "new_commits" | "existing_unmerged_work";
}

export const recordHubTaskStatusAdvanced = (
  runDir: string,
  input: RecordHubTaskStatusAdvancedInput,
): void => {
  appendHubTaskEvent(runDir, {
    type: "task_status_advanced",
    runId: input.runId,
    batchId: input.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: input.createdAt,
    status: input.status,
    reason: input.reason,
    failureReason: input.failureReason,
    commitCount: input.commitCount,
    branchHasUnmergedWork: input.branchHasUnmergedWork,
    implementationWork: input.implementationWork,
  });
};

export const readHubTaskClaim = (
  metadata: Readonly<Record<string, unknown>>,
): HubTaskClaimMetadata | undefined => {
  const claimRecord = readClaimRecord(metadata);
  if (!claimRecord) {
    return undefined;
  }

  const claimedAt = readFirstString(claimRecord, ["claimedAt", "claimed_at"]);
  const runId = readFirstString(claimRecord, ["runId", "run_id"]);
  const batchId = readFirstString(claimRecord, ["batchId", "batch_id"]);
  const taskId = readFirstString(claimRecord, ["taskId", "task_id"]);
  const branch = readFirstString(claimRecord, ["branch"]);
  const baseHead = readFirstString(claimRecord, ["baseHead", "base_head"]);
  const branchExistedBeforeClaim = readBoolean(claimRecord, [
    "branchExistedBeforeClaim",
    "branch_existed_before_claim",
  ]);

  return {
    runId,
    batchId,
    taskId,
    branch,
    claimedAt,
    baseHead,
    branchExistedBeforeClaim,
    raw: claimRecord,
  };
};

// Execution-phase Hub statuses during which a task holds an active claim and
// is still being worked by a Hub flow (implement -> review -> waiting-for-merge
// -> merge). A claim held against any of these is in-flight, not stale, and the
// task must not be re-claimed.
//
// Matches CLAIM_REQUIRED_STATUSES in taskBoard.ts and hubTaskStateDoctor.ts
// exactly. It deliberately diverges from two related sets, so do not
// "reconcile" them: CLAIM_PRESERVING_STATUSES (taskBoard.ts) additionally
// preserves `failed`, whose claim metadata is kept but treated as stale and
// released by recovery; INTERRUPTED_EXECUTION_STATUSES (the shared detector,
// also used by recoverHubTask) omits `waiting_for_merge`, a stable
// external-wait pause rather than an orphaned process state needing reset.
const ACTIVE_HUB_TASK_CLAIM_STATUSES = new Set([
  "implementing",
  "reviewing",
  "waiting_for_merge",
  "merging",
]);

export const isHubTaskClaimActive = (hubStatus: string): boolean =>
  ACTIVE_HUB_TASK_CLAIM_STATUSES.has(hubStatus);

export const resolveHubTaskClaimState = (
  hubStatus: string,
  claim: HubTaskClaimMetadata | undefined,
): "active" | "stale" | undefined => {
  if (!claim) {
    return undefined;
  }

  return isHubTaskClaimActive(hubStatus) ? "active" : "stale";
};
