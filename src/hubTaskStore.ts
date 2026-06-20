import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TaskBoardError } from "./errors.js";
import { isBdAvailable, resolveBdExecutable } from "./resolveBdExecutable.js";

export const HUB_TASK_STORE_INIT_COMMAND = "sandcastle tasks init";

export const resolveHubTaskStoreDir = (cwd: string): string =>
  join(cwd, ".beads");

export const isHubTaskStoreInitialized = (cwd: string): boolean =>
  existsSync(join(resolveHubTaskStoreDir(cwd), "metadata.json"));

export const seedHubTaskStoreMetadata = (cwd: string): void => {
  const beadsDir = resolveHubTaskStoreDir(cwd);
  mkdirSync(beadsDir, { recursive: true });
  const metadataPath = join(beadsDir, "metadata.json");
  if (!existsSync(metadataPath)) {
    writeFileSync(metadataPath, JSON.stringify({ backend: "dolt" }));
  }
};

export const formatHubTaskStoreNotInitializedMessage = (
  failureLabel: string,
): string =>
  `sandcastle ${failureLabel} requires a local task store. Run \`${HUB_TASK_STORE_INIT_COMMAND}\` in this repository first.`;

export const formatHubTaskStoreBdUnavailableMessage = (
  failureLabel: string,
): string =>
  `sandcastle ${failureLabel} requires the Sandcastle task runtime. Install dependencies, set SANDCASTLE_BD_PATH, or ensure the bundled Beads runtime is available.`;

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
  if (!isHubTaskStoreInitialized(cwd) || isTaskStoreInitError(message)) {
    return formatHubTaskStoreNotInitializedMessage(failureLabel);
  }

  return `sandcastle ${failureLabel} failed: ${message}`;
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

  if (isHubTaskStoreInitialized(cwd)) {
    return { alreadyInitialized: true, output: "" };
  }

  try {
    const output = execBdText(cwd, ["init", "--non-interactive"], env);

    if (!isHubTaskStoreInitialized(cwd)) {
      throw new TaskBoardError({
        message:
          "sandcastle tasks init reported success, but the local task store is still missing. Retry after checking repository permissions.",
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
