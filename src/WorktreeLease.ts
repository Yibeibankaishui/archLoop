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

export interface AcquiredWorktreeLease {
  readonly branch: string;
  readonly leaseName: string;
  readonly leasePath: string;
  readonly worktreePath: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

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
  metadata: DirectWorktreeLeaseMetadata,
  repoDir: string,
  branch: string,
): WorktreeLeaseError => {
  const { leasePath, worktreePath } = leaseDiagnostics(repoDir, branch);
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

const isDirectLeaseMetadata = (
  value: unknown,
): value is DirectWorktreeLeaseMetadata =>
  typeof value === "object" &&
  value !== null &&
  (value as { owner?: unknown }).owner === "direct" &&
  typeof (value as { pid?: unknown }).pid === "number" &&
  Number.isInteger((value as { pid: number }).pid) &&
  (value as { pid: number }).pid > 0 &&
  typeof (value as { branch?: unknown }).branch === "string" &&
  (value as { branch: string }).branch.length > 0 &&
  typeof (value as { acquiredAt?: unknown }).acquiredAt === "string" &&
  (value as { acquiredAt: string }).acquiredAt.length > 0;

const parseLeaseMetadata = (
  raw: string,
  repoDir: string,
  branch: string,
  options?: { readonly matchBranch?: boolean },
): Effect.Effect<DirectWorktreeLeaseMetadata, WorktreeLeaseError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => malformedLeaseError(repoDir, branch, "invalid JSON"),
  }).pipe(
    Effect.flatMap((value) => {
      if (!isDirectLeaseMetadata(value)) {
        return Effect.fail(
          malformedLeaseError(repoDir, branch, "missing required fields"),
        );
      }

      const matchBranch = options?.matchBranch ?? true;
      if (matchBranch && value.branch !== branch) {
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
  DirectWorktreeLeaseMetadata,
  WorktreeLeaseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { leasePath } = leaseDiagnostics(repoDir, branch);
    const raw = yield* fs.readFileString(leasePath).pipe(
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
  metadata: DirectWorktreeLeaseMetadata,
): Effect.Effect<void, WorktreeLeaseError | WorktreeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const locksDir = locksDirectory(repoDir);
    yield* fs
      .makeDirectory(locksDir, { recursive: true })
      .pipe(Effect.mapError((error) => mapFsError(error.message)));

    const { leasePath } = leaseDiagnostics(repoDir, branch);
    const content = `${JSON.stringify(metadata)}\n`;

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
    const exists = yield* fs.exists(leasePath).pipe(
      Effect.mapError((error) => mapFsError(error.message)),
    );
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

const failOnActiveLease = (
  repoDir: string,
  branch: string,
): Effect.Effect<void, WorktreeLeaseError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const existing = yield* readLeaseMetadata(repoDir, branch);
    return yield* Effect.fail(activeLeaseError(existing, repoDir, branch));
  });

const recoverStaleLeaseOrFailOnActive = (
  repoDir: string,
  branch: string,
): Effect.Effect<void, WorktreeLeaseError | WorktreeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const recovery = yield* recoverStaleWorktreeLeaseIfNeeded(repoDir, branch);
    if (recovery === "active") {
      return yield* failOnActiveLease(repoDir, branch);
    }
  });

/**
 * Acquire an exclusive worktree lease for `branch`, recovering stale lease
 * files when the recorded owner process is no longer alive.
 */
export const acquireWorktreeLease = (
  repoDir: string,
  input: { readonly branch: string },
): Effect.Effect<
  AcquiredWorktreeLease,
  WorktreeLeaseError | WorktreeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const branch = input.branch;
    const { leaseName, leasePath, worktreePath } = leaseDiagnostics(
      repoDir,
      branch,
    );
    const metadata: DirectWorktreeLeaseMetadata = {
      owner: "direct",
      pid: process.pid,
      branch,
      acquiredAt: new Date().toISOString(),
    };

    const tryAcquire = (): Effect.Effect<
      void,
      WorktreeLeaseError | WorktreeError,
      FileSystem.FileSystem
    > => createLeaseFileAtomic(repoDir, branch, metadata);

    yield* recoverStaleLeaseOrFailOnActive(repoDir, branch);

    yield* tryAcquire().pipe(
      Effect.catchTag("WorktreeLeaseError", (error) =>
        error.reason === "recovery"
          ? recoverStaleLeaseOrFailOnActive(repoDir, branch).pipe(
              Effect.andThen(tryAcquire),
            )
          : Effect.fail(error),
      ),
    );

    return {
      branch,
      leaseName,
      leasePath,
      worktreePath,
      pid: metadata.pid,
      acquiredAt: metadata.acquiredAt,
    };
  });

/** Release the worktree lease for `branch` if present. */
export const releaseWorktreeLease = (
  repoDir: string,
  branch: string,
): Effect.Effect<void, WorktreeError, FileSystem.FileSystem> =>
  removeLeaseFile(repoDir, branch);

/** Map lease errors to WorktreeError for callers that surface a single error type. */
export const mapWorktreeLeaseError = (
  error: WorktreeLeaseError | WorktreeError,
): WorktreeError => new WorktreeError({ message: error.message });

/** Best-effort lease release; ignores missing files and I/O errors. */
export const releaseHeldWorktreeLease = (
  repoDir: string,
  branch: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  releaseWorktreeLease(repoDir, branch).pipe(Effect.catchAll(() => Effect.void));

/**
 * Tracks a worktree lease held for a long-lived handle (`createWorktree`,
 * `createSandbox`). Call `acquire` during setup and `release` on close or
 * setup failure.
 */
export interface HeldWorktreeLease {
  readonly acquire: (
    repoDir: string,
    branch: string,
  ) => Effect.Effect<void, WorktreeError, FileSystem.FileSystem>;
  readonly release: () => Effect.Effect<void, never, FileSystem.FileSystem>;
}

export const createHeldWorktreeLease = (): HeldWorktreeLease => {
  let repoDir: string | undefined;
  let branch: string | undefined;
  let held = false;

  return {
    acquire: (dir, leaseBranch) =>
      acquireWorktreeLease(dir, { branch: leaseBranch }).pipe(
        Effect.mapError(mapWorktreeLeaseError),
        Effect.tap(() =>
          Effect.sync(() => {
            repoDir = dir;
            branch = leaseBranch;
            held = true;
          }),
        ),
      ),
    release: () => {
      if (!held || repoDir === undefined || branch === undefined) {
        return Effect.void;
      }
      const dir = repoDir;
      const leaseBranch = branch;
      held = false;
      repoDir = undefined;
      branch = undefined;
      return releaseHeldWorktreeLease(dir, leaseBranch);
    },
  };
};

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
): Effect.Effect<void, WorktreeError | WorktreeLeaseError, FileSystem.FileSystem> =>
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

      const metadata = yield* parseLeaseMetadata(raw.value, repoDir, leaseName, {
        matchBranch: false,
      }).pipe(Effect.option);

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
