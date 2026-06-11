import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  resolveGitRepoRoot,
  resolveHubProjectDir,
  resolveSandcastleUserDataDir,
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
  readonly branch: string | undefined;
  readonly claimedAt: string | undefined;
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
}

export interface HubTaskEvent {
  readonly type:
    | "task_claimed"
    | "task_claim_skipped"
    | "task_implementation_started"
    | "task_implementation_succeeded"
    | "task_implementation_failed"
    | "task_review_started"
    | "task_review_succeeded"
    | "task_review_failed"
    | "task_status_advanced";
  readonly runId: string;
  readonly batchId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly createdAt: string;
  readonly status: string;
  readonly reason?: string;
  readonly failureReason?: string;
  readonly commitCount?: number;
  readonly claim?: HubTaskClaimMetadata;
}

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

const appendHubEvent = <T>(
  directory: string,
  path: string,
  event: T,
): string => {
  mkdirSync(directory, { recursive: true });
  writeJsonl(path, event);
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
    readonly claimedAt?: string;
  },
): HubTaskClaimMetadata => {
  const claimedAt = input.claimedAt ?? new Date().toISOString();
  return {
    runId: input.runId,
    batchId: input.batchId,
    branch: input.branch,
    claimedAt,
    raw: {
      runId: input.runId,
      batchId: input.batchId,
      branch: input.branch,
      claimedAt,
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
    resolveHubProjectDir(resolveSandcastleUserDataDir(options.env), repoRoot);
  const identifiers = createHubRunIdentifiers();
  const ids = options.runId
    ? {
        runId: options.runId,
        batchId: options.batchId ?? identifiers.batchId,
      }
    : identifiers;
  const runDir = resolveHubRunDirectory(hubProjectDir, ids.runId);
  const eventsDir = resolveHubRunEventsDirectory(runDir);
  const paths = resolveHubRunEventsPaths(runDir);

  mkdirSync(eventsDir, { recursive: true });

  if (!options.runId) {
    writeJsonl(paths.runEventsPath, {
      type: "run_started",
      runId: ids.runId,
      branch: options.branch,
      startedAt: startedAt.toISOString(),
      repoRoot,
      hubProjectDir,
    } satisfies HubRunStartedEvent);

    writeJsonl(paths.batchEventsPath, {
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
  event: HubRunStartedEvent,
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
  event: HubBatchStartedEvent | HubBatchPlannedEvent,
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
  const branch = readFirstString(claimRecord, ["branch"]);

  return {
    runId,
    batchId,
    branch,
    claimedAt,
    raw: claimRecord,
  };
};

export const isHubTaskClaimActive = (hubStatus: string): boolean =>
  hubStatus === "implementing";

export const resolveHubTaskClaimState = (
  hubStatus: string,
  claim: HubTaskClaimMetadata | undefined,
): "active" | "stale" | undefined => {
  if (!claim) {
    return undefined;
  }

  return isHubTaskClaimActive(hubStatus) ? "active" : "stale";
};
