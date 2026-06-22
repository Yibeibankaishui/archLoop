import { Effect, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeError, WorktreeLeaseError } from "./errors.js";

/** Lease file name segment derived from a branch name (matches WorktreeManager). */
export const leaseNameFromBranch = (branch: string): string =>
  branch.replace(/\//g, "-");

/** Host path to the managed worktree directory for a lease/worktree name. */
export const worktreePathForLeaseName = (
  repoDir: string,
  leaseName: string,
): string => join(repoDir, ".archloop", "worktrees", leaseName);

/** Host path to the managed worktree directory for a branch. */
export const worktreePathForBranch = (
  repoDir: string,
  branch: string,
): string => worktreePathForLeaseName(repoDir, leaseNameFromBranch(branch));

/** Host path to the lease lock file for a branch. */
export const leaseLockPath = (repoDir: string, leaseName: string): string =>
  join(repoDir, ".archloop", "locks", `${leaseName}.lock`);

export interface DirectWorktreeLeaseMetadata {
  readonly owner: "direct";
  readonly pid: number;
  readonly branch: string;
  readonly acquiredAt: string;
}

export interface HubWorktreeLeaseMetadata {
  readonly owner: "hub";
  readonly taskId: string;
  readonly flowId: string;
  readonly batchId: string;
  readonly branch: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

export type WorktreeLeaseMetadata =
  | DirectWorktreeLeaseMetadata
  | HubWorktreeLeaseMetadata;

export interface DirectWorktreeLeaseOwnerInput {
  readonly kind: "direct";
}

export interface HubWorktreeLeaseOwnerInput {
  readonly kind: "hub";
  readonly taskId: string;
  readonly flowId: string;
  readonly batchId: string;
}

export type WorktreeLeaseOwnerInput =
  | DirectWorktreeLeaseOwnerInput
  | HubWorktreeLeaseOwnerInput;

export interface AcquireWorktreeLeaseInput {
  readonly branch: string;
  readonly owner?: WorktreeLeaseOwnerInput;
}

export interface AcquiredWorktreeLease {
  readonly branch: string;
  readonly leaseName: string;
  readonly leasePath: string;
  readonly worktreePath: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly owner: WorktreeLeaseMetadata["owner"];
  readonly taskId?: string;
  readonly flowId?: string;
  readonly batchId?: string;
}

const DIRECT_LEASE_METADATA_KEYS = [
  "owner",
  "pid",
  "branch",
  "acquiredAt",
] as const;

const HUB_LEASE_METADATA_KEYS = [
  "owner",
  "taskId",
  "flowId",
  "batchId",
  "branch",
  "pid",
  "acquiredAt",
] as const;

const FORBIDDEN_LEASE_METADATA_KEYS = [
  "prompt",
  "promptFile",
  "commandLine",
  "command",
  "env",
  "environment",
  "agentOutput",
  "stdout",
  "stderr",
  "taskContent",
  "title",
  "description",
] as const;

const LOCK_FILE_SUFFIX = ".lock";

const locksDirectory = (repoDir: string): string =>
  join(repoDir, ".archloop", "locks");

const lockFileNameToLeaseName = (fileName: string): string | null =>
  fileName.endsWith(LOCK_FILE_SUFFIX)
    ? fileName.slice(0, -LOCK_FILE_SUFFIX.length)
    : null;

const readLocksDirectory = (
  fs: FileSystem.FileSystem,
  locksDir: string,
): Effect.Effect<string[], WorktreeError> =>
  fs.readDirectory(locksDir).pipe(
    Effect.map((value): string[] => value),
    Effect.catchSome((error) =>
      error._tag === "SystemError" && error.reason === "NotFound"
        ? Option.some(Effect.succeed([] as string[]))
        : Option.none(),
    ),
    Effect.mapError((error) => mapFsError(error.message)),
  );

/** Returns true when `pid` refers to a live process. */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EPERM") {
      return true;
    }
    return false;
  }
};

/** Build lease metadata from owner input, omitting sensitive execution content. */
export const buildWorktreeLeaseMetadata = (
  branch: string,
  owner: WorktreeLeaseOwnerInput = { kind: "direct" },
  options?: { readonly acquiredAt?: string; readonly pid?: number },
): WorktreeLeaseMetadata => {
  const acquiredAt = options?.acquiredAt ?? new Date().toISOString();
  const pid = options?.pid ?? process.pid;

  if (owner.kind === "hub") {
    return {
      owner: "hub",
      taskId: owner.taskId,
      flowId: owner.flowId,
      batchId: owner.batchId,
      branch,
      pid,
      acquiredAt,
    };
  }

  return {
    owner: "direct",
    pid,
    branch,
    acquiredAt,
  };
};

/**
 * Serialize lease metadata using an allowlist of safe diagnostic fields.
 * Allowlisting is the primary guard; the forbidden-key pass is a backstop if a
 * sensitive field is ever added to an allowlist by mistake.
 */
export const serializeWorktreeLeaseMetadata = (
  metadata: WorktreeLeaseMetadata,
): Record<string, string | number> => {
  const allowedKeys =
    metadata.owner === "hub"
      ? HUB_LEASE_METADATA_KEYS
      : DIRECT_LEASE_METADATA_KEYS;

  const serialized: Record<string, string | number> = {};
  for (const key of allowedKeys) {
    const value = metadata[key as keyof WorktreeLeaseMetadata];
    if (typeof value === "string" || typeof value === "number") {
      serialized[key] = value;
    }
  }

  for (const forbidden of FORBIDDEN_LEASE_METADATA_KEYS) {
    if (forbidden in serialized) {
      delete serialized[forbidden];
    }
  }

  return serialized;
};

const mapFsError = (message: string): WorktreeError =>
  new WorktreeError({ message });

const leaseDiagnostics = (
  repoDir: string,
  branch: string,
): {
  leaseName: string;
  leasePath: string;
  worktreePath: string;
} => {
  const leaseName = leaseNameFromBranch(branch);
  return {
    leaseName,
    leasePath: leaseLockPath(repoDir, leaseName),
    worktreePath: worktreePathForBranch(repoDir, branch),
  };
};

const malformedLeaseError = (
  repoDir: string,
  branch: string,
  detail: string,
): WorktreeLeaseError => {
  const { leasePath, worktreePath } = leaseDiagnostics(repoDir, branch);
  return new WorktreeLeaseError({
    reason: "malformed",
    branch,
    leasePath,
    worktreePath,
    message:
      `Worktree lease at ${leasePath} has invalid metadata (${detail}). ` +
      `Recovery: repair or remove the lease file before reusing worktree at ${worktreePath}.`,
  });
};

const activeLeaseError = (
  metadata: WorktreeLeaseMetadata,
  repoDir: string,
  branch: string,
): WorktreeLeaseError => {
  const { leasePath, worktreePath } = leaseDiagnostics(repoDir, branch);

  if (metadata.owner === "hub") {
    return new WorktreeLeaseError({
      reason: "active",
      branch,
      leasePath,
      worktreePath,
      pid: metadata.pid,
      acquiredAt: metadata.acquiredAt,
      taskId: metadata.taskId,
      flowId: metadata.flowId,
      batchId: metadata.batchId,
      message:
        `Task '${metadata.taskId}' already has active execution ` +
        `(flow ${metadata.flowId}, batch ${metadata.batchId}, branch '${metadata.branch}', ` +
        `process ${metadata.pid}, acquired at ${metadata.acquiredAt}). ` +
        "Wait for that execution to finish, or recover the task if it failed.",
    });
  }

  return new WorktreeLeaseError({
    reason: "active",
    branch,
    leasePath,
    worktreePath,
    pid: metadata.pid,
    acquiredAt: metadata.acquiredAt,
    message:
      `Worktree for branch '${branch}' at ${worktreePath} is in use by process ${metadata.pid} ` +
      `(acquired at ${metadata.acquiredAt}). ` +
      `Next action: wait for that run to finish, or recover the task if it failed.`,
  });
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isDirectWorktreeLeaseMetadata = (
  value: unknown,
): value is DirectWorktreeLeaseMetadata => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.owner === "direct" &&
    isPositiveInteger(record.pid) &&
    isNonEmptyString(record.branch) &&
    isNonEmptyString(record.acquiredAt)
  );
};

const isHubWorktreeLeaseMetadata = (
  value: unknown,
): value is HubWorktreeLeaseMetadata => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.owner === "hub" &&
    isNonEmptyString(record.taskId) &&
    isNonEmptyString(record.flowId) &&
    isNonEmptyString(record.batchId) &&
    isNonEmptyString(record.branch) &&
    isPositiveInteger(record.pid) &&
    isNonEmptyString(record.acquiredAt)
  );
};

const isWorktreeLeaseMetadata = (
  value: unknown,
): value is WorktreeLeaseMetadata =>
  isDirectWorktreeLeaseMetadata(value) || isHubWorktreeLeaseMetadata(value);

const parseLeaseMetadata = (
  raw: string,
  repoDir: string,
  branch: string,
  options?: { readonly requireBranchMatch?: boolean },
): Effect.Effect<WorktreeLeaseMetadata, WorktreeLeaseError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => malformedLeaseError(repoDir, branch, "invalid JSON"),
  }).pipe(
    Effect.flatMap((value) => {
      if (!isWorktreeLeaseMetadata(value)) {
        return Effect.fail(
          malformedLeaseError(repoDir, branch, "missing required fields"),
        );
      }

      if (options?.requireBranchMatch !== false && value.branch !== branch) {
        return Effect.fail(
          malformedLeaseError(
            repoDir,
            branch,
            `branch '${value.branch}' does not match '${branch}'`,
          ),
        );
      }

      return Effect.succeed(value);
    }),
  );

const readLeaseMetadata = (
  repoDir: string,
  branch: string,
): Effect.Effect<
  WorktreeLeaseMetadata,
  WorktreeLeaseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { leasePath } = leaseDiagnostics(repoDir, branch);
    const raw = yield* fs
      .readFileString(leasePath)
      .pipe(
        Effect.mapError(() =>
          malformedLeaseError(repoDir, branch, "lease file unreadable"),
        ),
      );
    return yield* parseLeaseMetadata(raw, repoDir, branch);
  });

const removeLeaseFile = (
  repoDir: string,
  branch: string,
): Effect.Effect<void, WorktreeError, FileSystem.FileSystem> =>
  removeLeaseFileByPath(leaseDiagnostics(repoDir, branch).leasePath);

const removeLeaseFileByPath = (
  leasePath: string,
): Effect.Effect<void, WorktreeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(leasePath).pipe(
      Effect.catchTag("SystemError", (error) =>
        error.reason === "NotFound"
          ? Effect.void
          : Effect.fail(mapFsError(error.message)),
      ),
      Effect.mapError((error) => mapFsError(error.message)),
    );
  });

const createLeaseFileAtomic = (
  repoDir: string,
  branch: string,
  metadata: WorktreeLeaseMetadata,
): Effect.Effect<
  void,
  WorktreeLeaseError | WorktreeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const locksDir = locksDirectory(repoDir);
    yield* fs
      .makeDirectory(locksDir, { recursive: true })
      .pipe(Effect.mapError((error) => mapFsError(error.message)));

    const { leasePath } = leaseDiagnostics(repoDir, branch);
    const content = `${JSON.stringify(serializeWorktreeLeaseMetadata(metadata))}\n`;

    const created = yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(leasePath, "wx");
        try {
          await handle.writeFile(content, "utf-8");
        } finally {
          await handle.close();
        }
        return true;
      },
      catch: (error) => error as NodeJS.ErrnoException,
    }).pipe(
      Effect.catchAll((error) =>
        error.code === "EEXIST"
          ? Effect.succeed(false)
          : Effect.fail(mapFsError(error.message)),
      ),
    );

    if (!created) {
      return yield* Effect.fail(
        new WorktreeLeaseError({
          reason: "recovery",
          branch,
          leasePath,
          worktreePath: worktreePathForBranch(repoDir, branch),
          message: `Worktree lease at ${leasePath} already exists.`,
        }),
      );
    }
  });

const worktreeDirectoryExists = (
  repoDir: string,
  branch: string,
): Effect.Effect<boolean, WorktreeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const worktreePath = worktreePathForBranch(repoDir, branch);
    const stat = yield* fs.stat(worktreePath).pipe(Effect.option);
    return Option.match(stat, {
      onNone: () => false,
      onSome: (entry) => entry.type === "Directory",
    });
  });

/**
 * Removes a stale lease when the owner process is gone or the worktree path is
 * missing. Never deletes or resets the worktree directory itself.
 */
export const recoverStaleWorktreeLeaseIfNeeded = (
  repoDir: string,
  branch: string,
): Effect.Effect<
  "removed" | "active" | "absent",
  WorktreeLeaseError | WorktreeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { leasePath } = leaseDiagnostics(repoDir, branch);
    const exists = yield* fs
      .exists(leasePath)
      .pipe(Effect.mapError((error) => mapFsError(error.message)));
    if (!exists) {
      return "absent" as const;
    }

    const worktreeExists = yield* worktreeDirectoryExists(repoDir, branch);
    if (!worktreeExists) {
      yield* removeLeaseFile(repoDir, branch);
      return "removed" as const;
    }

    const metadata = yield* readLeaseMetadata(repoDir, branch);
    if (isProcessAlive(metadata.pid)) {
      return "active" as const;
    }

    yield* removeLeaseFile(repoDir, branch);
    return "removed" as const;
  });

const ensureLeaseNotActive = (
  repoDir: string,
  branch: string,
): Effect.Effect<
  void,
  WorktreeLeaseError | WorktreeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* checkWorktreeLeaseBeforeHubRetry(repoDir, branch).pipe(
      Effect.asVoid,
    );
  });

/**
 * Clears stale leases when needed and fails fast when a live lease still owns
 * the branch worktree. Used by Hub task retry before starting a new attempt.
 */
export const checkWorktreeLeaseBeforeHubRetry = (
  repoDir: string,
  branch: string,
): Effect.Effect<
  { readonly staleLeaseCleared: boolean },
  WorktreeLeaseError | WorktreeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const recovery = yield* recoverStaleWorktreeLeaseIfNeeded(repoDir, branch);
    if (recovery === "active") {
      const existing = yield* readLeaseMetadata(repoDir, branch);
      return yield* Effect.fail(activeLeaseError(existing, repoDir, branch));
    }

    return { staleLeaseCleared: recovery === "removed" };
  });

const toAcquiredWorktreeLease = (
  branch: string,
  leaseName: string,
  leasePath: string,
  worktreePath: string,
  metadata: WorktreeLeaseMetadata,
): AcquiredWorktreeLease => {
  const base = {
    branch,
    leaseName,
    leasePath,
    worktreePath,
    pid: metadata.pid,
    acquiredAt: metadata.acquiredAt,
    owner: metadata.owner,
  };

  if (metadata.owner === "hub") {
    return {
      ...base,
      taskId: metadata.taskId,
      flowId: metadata.flowId,
      batchId: metadata.batchId,
    };
  }

  return base;
};

/**
 * Acquire an exclusive worktree lease for `branch`, recovering stale lease
 * files when the recorded owner process is no longer alive.
 */
export const acquireWorktreeLease = (
  repoDir: string,
  input: AcquireWorktreeLeaseInput,
): Effect.Effect<
  AcquiredWorktreeLease,
  WorktreeLeaseError | WorktreeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const branch = input.branch;
    const owner: WorktreeLeaseOwnerInput = input.owner ?? { kind: "direct" };
    const { leaseName, leasePath, worktreePath } = leaseDiagnostics(
      repoDir,
      branch,
    );
    const metadata = buildWorktreeLeaseMetadata(branch, owner);

    const tryAcquire = (): Effect.Effect<
      void,
      WorktreeLeaseError | WorktreeError,
      FileSystem.FileSystem
    > => createLeaseFileAtomic(repoDir, branch, metadata);

    yield* ensureLeaseNotActive(repoDir, branch);

    yield* tryAcquire().pipe(
      Effect.catchTag("WorktreeLeaseError", (error) =>
        error.reason === "recovery"
          ? ensureLeaseNotActive(repoDir, branch).pipe(
              Effect.flatMap(() => tryAcquire()),
            )
          : Effect.fail(error),
      ),
    );

    return toAcquiredWorktreeLease(
      branch,
      leaseName,
      leasePath,
      worktreePath,
      metadata,
    );
  });

/** Release the worktree lease for `branch` if present. */
export const releaseWorktreeLease = (
  repoDir: string,
  branch: string,
): Effect.Effect<void, WorktreeError, FileSystem.FileSystem> =>
  removeLeaseFile(repoDir, branch);

/**
 * Remove lease files whose managed worktree directory no longer exists.
 * Does not delete worktree directories.
 */
export const pruneOrphanWorktreeLeases = (
  repoDir: string,
): Effect.Effect<void, WorktreeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const locksDir = locksDirectory(repoDir);
    const entries = yield* readLocksDirectory(fs, locksDir);

    for (const entry of entries) {
      const leaseName = lockFileNameToLeaseName(entry);
      if (leaseName === null) {
        continue;
      }
      const worktreePath = worktreePathForLeaseName(repoDir, leaseName);
      const worktreeExists = yield* fs.stat(worktreePath).pipe(
        Effect.map((stat) => stat.type === "Directory"),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (!worktreeExists) {
        yield* removeLeaseFileByPath(join(locksDir, entry));
      }
    }
  });

/**
 * Remove stale and orphan worktree lease files. Never deletes worktree
 * directories.
 */
export const pruneStaleWorktreeLeases = (
  repoDir: string,
): Effect.Effect<
  void,
  WorktreeError | WorktreeLeaseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* pruneOrphanWorktreeLeases(repoDir);

    const fs = yield* FileSystem.FileSystem;
    const locksDir = locksDirectory(repoDir);
    const entries = yield* readLocksDirectory(fs, locksDir);

    for (const entry of entries) {
      const leaseName = lockFileNameToLeaseName(entry);
      if (leaseName === null) {
        continue;
      }
      const leasePath = join(locksDir, entry);
      const raw = yield* fs.readFileString(leasePath).pipe(Effect.option);
      if (Option.isNone(raw)) {
        continue;
      }

      const metadata = yield* parseLeaseMetadata(
        raw.value,
        repoDir,
        leaseName,
        {
          requireBranchMatch: false,
        },
      ).pipe(Effect.option);

      if (Option.isNone(metadata)) {
        continue;
      }

      yield* recoverStaleWorktreeLeaseIfNeeded(
        repoDir,
        metadata.value.branch,
      ).pipe(
        Effect.catchTag("WorktreeLeaseError", (error) =>
          error.reason === "malformed" ? Effect.void : Effect.fail(error),
        ),
      );
    }
  });
