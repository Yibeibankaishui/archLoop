import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TaskBoardError } from "./errors.js";
import { isBdAvailable, resolveBdExecutable } from "./resolveBdExecutable.js";

export const HUB_TASK_STORE_INIT_COMMAND = "archloop tasks init";

export const resolveHubTaskStoreDir = (cwd: string): string =>
  join(cwd, ".beads");

const resolveHubTaskStoreMetadataPath = (cwd: string): string =>
  join(resolveHubTaskStoreDir(cwd), "metadata.json");

/**
 * Embedded Dolt database directory written by `bd init`. Presence of this
 * directory (alongside `metadata.json`) is what proves a real task-store
 * database exists — `metadata.json` alone is just a marker and can be left
 * behind as an orphan if the database is deleted out from under it.
 */
const resolveHubTaskStoreDatabaseDir = (cwd: string): string =>
  join(resolveHubTaskStoreDir(cwd), "embeddeddolt");

const isHubTaskStoreDatabasePresent = (cwd: string): boolean =>
  existsSync(resolveHubTaskStoreDatabaseDir(cwd));

/**
 * Marker-file check only. True when `.beads/metadata.json` exists, regardless
 * of whether the underlying Dolt database is still present. Use
 * {@link isHubTaskStoreFullyInitialized} when you need to know the store is
 * actually usable (e.g. before skipping `bd init`), so an orphaned
 * `metadata.json` does not mask a missing database.
 */
export const isHubTaskStoreInitialized = (cwd: string): boolean =>
  existsSync(resolveHubTaskStoreMetadataPath(cwd));

/**
 * True only when both the metadata marker and the embedded Dolt database
 * directory exist. This is the check `tasks init` uses to decide whether a
 * real `bd init` is still needed, so a stale `metadata.json` left behind by a
 * deleted database triggers a genuine re-init instead of a no-op.
 */
export const isHubTaskStoreFullyInitialized = (cwd: string): boolean =>
  isHubTaskStoreInitialized(cwd) && isHubTaskStoreDatabasePresent(cwd);

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
): string => {
  const message = readErrorMessage(error);
  if (!isHubTaskStoreFullyInitialized(cwd) || isTaskStoreInitError(message)) {
    return formatHubTaskStoreNotInitializedMessage(failureLabel);
  }

  return `archloop ${failureLabel} failed: ${message}`;
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
): void => {
  if (isHubTaskStoreInitialized(cwd)) {
    return;
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
): string => {
  if (!isBdAvailable(env)) {
    throw new TaskBoardError({
      message: formatHubTaskStoreBdUnavailableMessage(failureLabel),
    });
  }

  assertHubTaskStoreInitialized(cwd, failureLabel);

  try {
    return execBdText(cwd, args, env);
  } catch (error) {
    throw new TaskBoardError({
      message: formatHubTaskStoreCommandFailure(failureLabel, error, cwd),
    });
  }
};

export interface InitHubTaskStoreResult {
  readonly alreadyInitialized: boolean;
  readonly output: string;
}

export const initHubTaskStore = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): InitHubTaskStoreResult => {
  if (!isBdAvailable(env)) {
    throw new TaskBoardError({
      message: formatHubTaskStoreBdUnavailableMessage("tasks init"),
    });
  }

  if (isHubTaskStoreFullyInitialized(cwd)) {
    return { alreadyInitialized: true, output: "" };
  }

  try {
    const output = execBdText(cwd, ["init", "--non-interactive"], env);

    if (!isHubTaskStoreFullyInitialized(cwd)) {
      throw new TaskBoardError({
        message:
          "archloop tasks init reported success, but the local task store is still missing. Retry after checking repository permissions.",
      });
    }

    return { alreadyInitialized: false, output };
  } catch (error) {
    if (error instanceof TaskBoardError) {
      throw error;
    }

    throw new TaskBoardError({
      message: formatHubTaskStoreCommandFailure("tasks init", error, cwd),
    });
  }
};
