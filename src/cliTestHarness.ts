import { execSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

import {
  readHubProjectRegistry,
  registerHubProject,
} from "./hubProjectRegistry.js";
import { resolveGitRepoRoot } from "./projectStatus.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";

export const TEST_PROJECT_TIMESTAMP = new Date("2026-07-04T12:00:00.000Z");

export const CLI_TEST_XDG_DATA_DIRNAME = ".test-xdg-data";
export const CLI_TEST_XDG_CONFIG_DIRNAME = ".test-xdg-config";
export const CLI_TEST_XDG_CACHE_DIRNAME = ".test-xdg-cache";

export const createCliTestIsolationEnv = (
  rootDir: string,
): NodeJS.ProcessEnv => ({
  XDG_DATA_HOME: join(rootDir, CLI_TEST_XDG_DATA_DIRNAME),
  XDG_CONFIG_HOME: join(rootDir, CLI_TEST_XDG_CONFIG_DIRNAME),
  XDG_CACHE_HOME: join(rootDir, CLI_TEST_XDG_CACHE_DIRNAME),
});

export const hasInitialCommit = (repoDir: string): boolean => {
  try {
    execSync("git rev-parse --verify HEAD", {
      cwd: repoDir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
};

export const ensureTaskBoardProjectRegistered = (
  repoDir: string,
  env: NodeJS.ProcessEnv,
) => {
  if (!hasInitialCommit(repoDir)) {
    return;
  }

  const repoRoot = resolveGitRepoRoot(repoDir);
  const alreadyRegistered = readHubProjectRegistry({ env }).some(
    (project) => project.repoRoot === repoRoot,
  );
  if (alreadyRegistered) {
    return;
  }

  registerHubProject({
    repoPath: repoRoot,
    projectName: basename(repoRoot),
    env,
    now: TEST_PROJECT_TIMESTAMP,
  });
};

export const withBdEnv = (
  bdPath: string,
  repoDirOrEnv?: string | NodeJS.ProcessEnv,
  maybeEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  let repoDir: string | undefined;
  let mergedEnv: NodeJS.ProcessEnv = {};

  if (typeof repoDirOrEnv === "string") {
    repoDir = repoDirOrEnv;
    mergedEnv = maybeEnv ?? {};
  } else if (repoDirOrEnv) {
    mergedEnv = repoDirOrEnv;
  }

  if (repoDir) {
    seedHubTaskStoreMetadata(repoDir);
  }

  const isolatedRoots = repoDir ? createCliTestIsolationEnv(repoDir) : {};

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...isolatedRoots,
    ...mergedEnv,
    PATH: `${dirname(bdPath)}:${mergedEnv.PATH ?? process.env.PATH ?? ""}`,
    ARCHLOOP_BD_PATH: bdPath,
  };

  if (!env.XDG_DATA_HOME?.trim() && isolatedRoots.XDG_DATA_HOME) {
    env.XDG_DATA_HOME = isolatedRoots.XDG_DATA_HOME;
  }
  if (!env.XDG_CONFIG_HOME?.trim() && isolatedRoots.XDG_CONFIG_HOME) {
    env.XDG_CONFIG_HOME = isolatedRoots.XDG_CONFIG_HOME;
  }
  if (!env.XDG_CACHE_HOME?.trim() && isolatedRoots.XDG_CACHE_HOME) {
    env.XDG_CACHE_HOME = isolatedRoots.XDG_CACHE_HOME;
  }

  if (repoDir) {
    ensureTaskBoardProjectRegistered(repoDir, env);
  }

  return env;
};
