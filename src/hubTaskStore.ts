import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { TaskBoardError } from "./errors.js";
import { isBdAvailable, resolveBdExecutable } from "./resolveBdExecutable.js";
import {
  HUB_TASK_STORE_INIT_COMMAND,
  installHubTaskStoreRedirect,
  isBeadsStoreFullyInitialized,
  isBeadsStoreMarkerPresent,
  isHubOwnedTaskStoreKind,
  resolveHubTaskStore,
  resolveManagedHubTaskStoreDir,
  type HubTaskStoreResolution,
} from "./hubTaskStoreResolver.js";

export { HUB_TASK_STORE_INIT_COMMAND };

export const resolveHubTaskStoreDir = (cwd: string): string =>
  join(cwd, ".beads");

/**
 * Embedded Dolt database directory written by `bd init`. Presence of this
 * directory (alongside `metadata.json`) is what proves a real task-store
 * database exists — `metadata.json` alone is just a marker and can be left
 * behind as an orphan if the database is deleted out from under it.
 */
const resolveHubTaskStoreDatabaseDir = (cwd: string): string =>
  join(resolveHubTaskStoreDir(cwd), "embeddeddolt");

export interface HubTaskStoreLocationOptions {
  readonly hubProjectDir?: string;
}

const resolveTaskStoreLocation = (
  cwd: string,
  options: HubTaskStoreLocationOptions = {},
): HubTaskStoreResolution =>
  resolveHubTaskStore({
    repoRoot: cwd,
    hubProjectDir: options.hubProjectDir,
  });

/**
 * Directory used for marker/database presence checks. When the resolver has
 * not classified a live store yet, inspect repository-local `.beads` so an
 * orphaned `metadata.json` is still visible even if `hubProjectDir` is set.
 */
const resolveBeadsDirForPresenceCheck = (
  cwd: string,
  resolution: HubTaskStoreResolution,
): string =>
  resolution.kind === "uninitialized"
    ? resolveHubTaskStoreDir(cwd)
    : resolution.beadsDir;

/**
 * Marker-file check only. True when `.beads/metadata.json` exists, regardless
 * of whether the underlying Dolt database is still present. Use
 * {@link isHubTaskStoreFullyInitialized} when you need to know the store is
 * actually usable (e.g. before skipping `bd init`), so an orphaned
 * `metadata.json` does not mask a missing database.
 *
 * Follows a repository `.beads/redirect` and, when provided, a Hub-owned
 * managed store under `hubProjectDir`.
 */
export const isHubTaskStoreInitialized = (
  cwd: string,
  options: HubTaskStoreLocationOptions = {},
): boolean => {
  const resolution = resolveTaskStoreLocation(cwd, options);
  return (
    !resolution.redirectError &&
    isBeadsStoreMarkerPresent(resolveBeadsDirForPresenceCheck(cwd, resolution))
  );
};

/**
 * True only when both the metadata marker and the embedded Dolt database
 * directory exist. This is the check `tasks init` uses to decide whether a
 * real `bd init` is still needed, so a stale `metadata.json` left behind by a
 * deleted database triggers a genuine re-init instead of a no-op.
 */
export const isHubTaskStoreFullyInitialized = (
  cwd: string,
  options: HubTaskStoreLocationOptions = {},
): boolean => {
  const resolution = resolveTaskStoreLocation(cwd, options);
  return (
    !resolution.redirectError &&
    isBeadsStoreFullyInitialized(
      resolveBeadsDirForPresenceCheck(cwd, resolution),
    )
  );
};

export const seedHubTaskStoreMetadata = (cwd: string): void => {
  const beadsDir = resolveHubTaskStoreDir(cwd);
  mkdirSync(beadsDir, { recursive: true });
  const metadataPath = join(beadsDir, "metadata.json");
  if (!existsSync(metadataPath)) {
    writeFileSync(metadataPath, JSON.stringify({ backend: "dolt" }));
  }
  // Mirror what `bd init` writes: an embedded Dolt database directory. This
  // keeps the seeded store consistent with isHubTaskStoreFullyInitialized so
  // test fixtures that stub the task store read as genuinely initialized.
  mkdirSync(resolveHubTaskStoreDatabaseDir(cwd), { recursive: true });
};

export const formatHubTaskStoreNotInitializedMessage = (
  failureLabel: string,
): string =>
  `archloop ${failureLabel} requires a local task store. Run \`${HUB_TASK_STORE_INIT_COMMAND}\` in this repository first.`;

export const formatHubTaskStoreBdUnavailableMessage = (
  failureLabel: string,
): string =>
  `archloop ${failureLabel} requires the archLoop task runtime. Install dependencies, set ARCHLOOP_BD_PATH, or ensure the bundled Beads runtime is available.`;

const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unable to execute the task store";

const isTaskStoreInitError = (message: string): boolean =>
  /no beads database found/i.test(message) || /\bbd init\b/i.test(message);

export const formatHubTaskStoreCommandFailure = (
  failureLabel: string,
  error: unknown,
  cwd: string,
  options: HubTaskStoreLocationOptions = {},
): string => {
  const resolution = resolveTaskStoreLocation(cwd, options);
  if (resolution.redirectError) {
    return resolution.redirectError;
  }
  const message = readErrorMessage(error);
  if (
    !isBeadsStoreFullyInitialized(
      resolveBeadsDirForPresenceCheck(cwd, resolution),
    ) ||
    isTaskStoreInitError(message)
  ) {
    return formatHubTaskStoreNotInitializedMessage(failureLabel);
  }

  return `archloop ${failureLabel} failed: ${message}`;
};

const beadsEnvForResolution = (
  env: NodeJS.ProcessEnv,
  resolution: HubTaskStoreResolution,
): NodeJS.ProcessEnv => {
  if (isHubOwnedTaskStoreKind(resolution.kind)) {
    return {
      ...env,
      BEADS_DIR: resolution.beadsDir,
    };
  }
  return env;
};

const execBdText = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string =>
  execFileSync(resolveBdExecutable(env), [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

export const assertHubTaskStoreInitialized = (
  cwd: string,
  failureLabel: string,
  options: HubTaskStoreLocationOptions = {},
): HubTaskStoreResolution => {
  const resolution = resolveTaskStoreLocation(cwd, options);
  if (resolution.redirectError) {
    throw new TaskBoardError({
      message: resolution.redirectError,
    });
  }

  if (
    isBeadsStoreMarkerPresent(resolveBeadsDirForPresenceCheck(cwd, resolution))
  ) {
    return resolution;
  }

  throw new TaskBoardError({
    message: formatHubTaskStoreNotInitializedMessage(failureLabel),
  });
};

export const runBdTextForHubTaskStore = (
  cwd: string,
  args: readonly string[],
  failureLabel: string,
  env: NodeJS.ProcessEnv = process.env,
  options: HubTaskStoreLocationOptions = {},
): string => {
  if (!isBdAvailable(env)) {
    throw new TaskBoardError({
      message: formatHubTaskStoreBdUnavailableMessage(failureLabel),
    });
  }

  const resolution = assertHubTaskStoreInitialized(cwd, failureLabel, options);

  try {
    return execBdText(cwd, args, beadsEnvForResolution(env, resolution));
  } catch (error) {
    throw new TaskBoardError({
      message: formatHubTaskStoreCommandFailure(
        failureLabel,
        error,
        cwd,
        options,
      ),
    });
  }
};

export interface InitHubTaskStoreResult {
  readonly alreadyInitialized: boolean;
  readonly output: string;
}

export interface InitHubTaskStoreOptions extends HubTaskStoreLocationOptions {
  readonly projectName?: string;
}

const sanitizeBeadsPrefix = (
  projectName: string | undefined,
  cwd: string,
): string => {
  const source = projectName?.trim() || basename(cwd);
  const sanitized = source.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (sanitized.length === 0) {
    return "hub";
  }
  return /^[0-9]/.test(sanitized)
    ? `hub${sanitized}`.slice(0, 40)
    : sanitized.slice(0, 40);
};

const INIT_STILL_MISSING_MESSAGE =
  "archloop tasks init reported success, but the local task store is still missing. Retry after checking repository permissions.";

const initLegacyHubTaskStore = (
  cwd: string,
  env: NodeJS.ProcessEnv,
): InitHubTaskStoreResult => {
  if (isHubTaskStoreFullyInitialized(cwd)) {
    return { alreadyInitialized: true, output: "" };
  }

  const output = execBdText(cwd, ["init", "--non-interactive"], env);

  if (!isHubTaskStoreFullyInitialized(cwd)) {
    throw new TaskBoardError({
      message: INIT_STILL_MISSING_MESSAGE,
    });
  }

  return { alreadyInitialized: false, output };
};

const initManagedHubTaskStore = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  hubProjectDir: string,
  projectName: string | undefined,
): InitHubTaskStoreResult => {
  const managedBeadsDir = resolveManagedHubTaskStoreDir(hubProjectDir);
  const alreadyInitialized = isBeadsStoreFullyInitialized(managedBeadsDir);
  let output = "";

  if (!alreadyInitialized) {
    output = execBdText(
      cwd,
      [
        "init",
        "--non-interactive",
        "--skip-agents",
        "--skip-hooks",
        "--prefix",
        sanitizeBeadsPrefix(projectName, cwd),
      ],
      {
        ...env,
        BEADS_DIR: managedBeadsDir,
      },
    );

    if (!isBeadsStoreFullyInitialized(managedBeadsDir)) {
      throw new TaskBoardError({
        message: INIT_STILL_MISSING_MESSAGE,
      });
    }
  }

  installHubTaskStoreRedirect(cwd, managedBeadsDir);
  return { alreadyInitialized, output };
};

export const initHubTaskStore = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: InitHubTaskStoreOptions = {},
): InitHubTaskStoreResult => {
  if (!isBdAvailable(env)) {
    throw new TaskBoardError({
      message: formatHubTaskStoreBdUnavailableMessage("tasks init"),
    });
  }

  try {
    const hasLegacyStore = isBeadsStoreFullyInitialized(
      resolveHubTaskStoreDir(cwd),
    );
    if (options.hubProjectDir && !hasLegacyStore) {
      return initManagedHubTaskStore(
        cwd,
        env,
        options.hubProjectDir,
        options.projectName,
      );
    }

    return initLegacyHubTaskStore(cwd, env);
  } catch (error) {
    if (error instanceof TaskBoardError) {
      throw error;
    }

    throw new TaskBoardError({
      message: formatHubTaskStoreCommandFailure(
        "tasks init",
        error,
        cwd,
        options,
      ),
    });
  }
};
