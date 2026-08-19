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

export type CliTestIsolationEnv = {
  readonly XDG_DATA_HOME: string;
  readonly XDG_CONFIG_HOME: string;
  readonly XDG_CACHE_HOME: string;
};

export const createCliTestIsolationEnv = (rootDir: string): CliTestIsolationEnv => ({
  XDG_DATA_HOME: join(rootDir, CLI_TEST_XDG_DATA_DIRNAME),
  XDG_CONFIG_HOME: join(rootDir, CLI_TEST_XDG_CONFIG_DIRNAME),
  XDG_CACHE_HOME: join(rootDir, CLI_TEST_XDG_CACHE_DIRNAME),
});

const CLI_TEST_XDG_KEYS = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const satisfies readonly (keyof CliTestIsolationEnv)[];

const applyIsolatedXdgRootsWhenEmpty = (
  env: NodeJS.ProcessEnv,
  isolatedRoots: CliTestIsolationEnv,
): void => {
  for (const key of CLI_TEST_XDG_KEYS) {
    if (!env[key]?.trim()) {
      env[key] = isolatedRoots[key];
    }
  }
};

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

const parseWithBdEnvArgs = (
  repoDirOrEnv?: string | NodeJS.ProcessEnv,
  maybeEnv?: NodeJS.ProcessEnv,
): { readonly repoDir?: string; readonly mergedEnv: NodeJS.ProcessEnv } => {
  if (typeof repoDirOrEnv === "string") {
    return { repoDir: repoDirOrEnv, mergedEnv: maybeEnv ?? {} };
  }
  return { repoDir: undefined, mergedEnv: repoDirOrEnv ?? {} };
};

export const withBdEnv = (
  bdPath: string,
  repoDirOrEnv?: string | NodeJS.ProcessEnv,
  maybeEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const { repoDir, mergedEnv } = parseWithBdEnvArgs(repoDirOrEnv, maybeEnv);

  if (repoDir) {
    seedHubTaskStoreMetadata(repoDir);
  }

  const isolatedRoots = repoDir ? createCliTestIsolationEnv(repoDir) : undefined;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(isolatedRoots ?? {}),
    ...mergedEnv,
    PATH: `${dirname(bdPath)}:${mergedEnv.PATH ?? process.env.PATH ?? ""}`,
    ARCHLOOP_BD_PATH: bdPath,
  };

  if (isolatedRoots && repoDir) {
    applyIsolatedXdgRootsWhenEmpty(env, isolatedRoots);
    ensureTaskBoardProjectRegistered(repoDir, env);
  }

  return env;
};
