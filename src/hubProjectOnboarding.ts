import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  DEFAULT_PROJECT_PROFILE_NAME,
  getProjectProfile,
  type ProjectProfileEntry,
} from "./InitService.js";
import { HubProjectRegistryError } from "./errors.js";
import { resolveGitRepoRoot } from "./projectStatus.js";

const PROJECT_PROFILE_SIGNAL_FILES = {
  node: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  python: ["pyproject.toml", "poetry.lock", "uv.lock", "requirements.txt"],
  cpp: ["CMakeLists.txt", "Makefile", "makefile"],
} as const;
const PROJECT_PROFILE_SIGNAL_PRIORITY = ["node", "python", "cpp"] as const;
const DEFAULT_PROFILE_REASON =
  "No obvious stack signals were observed in the repository root.";
const PROJECT_ADD_REPO_GUIDANCE =
  'Run `git init`, stage your files, and `git commit -m "Initial commit"` before retrying.';

type SupportedProjectProfileName =
  (typeof PROJECT_PROFILE_SIGNAL_PRIORITY)[number];

export interface HubProjectProfileRecommendation {
  readonly projectProfileName: string;
  readonly observedSignals: readonly string[];
  readonly reason: string;
}

const readJsonObject = (path: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const readPackageJsonName = (repoRoot: string): string | undefined => {
  const packageJson = readJsonObject(join(repoRoot, "package.json"));
  const name = packageJson?.name;
  return typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : undefined;
};

const isFriendlyProjectName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

const readObservedSignals = (
  repoRoot: string,
  profileName: SupportedProjectProfileName,
): readonly string[] =>
  PROJECT_PROFILE_SIGNAL_FILES[profileName].filter((signal) =>
    existsSync(join(repoRoot, signal)),
  );

const listProfileSignalCandidates = (
  repoRoot: string,
): ReadonlyArray<{
  readonly projectProfileName: SupportedProjectProfileName;
  readonly observedSignals: readonly string[];
}> =>
  PROJECT_PROFILE_SIGNAL_PRIORITY.map((projectProfileName) => ({
    projectProfileName,
    observedSignals: readObservedSignals(repoRoot, projectProfileName),
  }));

const compareProfileSignalCandidates = (
  left: {
    readonly projectProfileName: SupportedProjectProfileName;
    readonly observedSignals: readonly string[];
  },
  right: {
    readonly projectProfileName: SupportedProjectProfileName;
    readonly observedSignals: readonly string[];
  },
): number => {
  const signalCountDelta =
    right.observedSignals.length - left.observedSignals.length;
  if (signalCountDelta !== 0) {
    return signalCountDelta;
  }

  return (
    PROJECT_PROFILE_SIGNAL_PRIORITY.indexOf(left.projectProfileName) -
    PROJECT_PROFILE_SIGNAL_PRIORITY.indexOf(right.projectProfileName)
  );
};

const formatProjectAddRepoValidationMessage = (repoPath: string): string =>
  `archloop project add requires ${repoPath} to point at an existing git repository with at least one commit. ${PROJECT_ADD_REPO_GUIDANCE}`;

const assertRepoHasInitialCommit = (
  repoRoot: string,
  repoPath: string,
): void => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new HubProjectRegistryError({
      message: formatProjectAddRepoValidationMessage(repoPath),
    });
  }
};

export const suggestHubProjectName = (repoRoot: string): string => {
  const packageName = readPackageJsonName(repoRoot);
  if (packageName && isFriendlyProjectName(packageName)) {
    return packageName;
  }

  return basename(repoRoot);
};

export const recommendHubProjectProfile = (
  repoRoot: string,
): HubProjectProfileRecommendation => {
  const rankedCandidates = listProfileSignalCandidates(repoRoot)
    .filter((candidate) => candidate.observedSignals.length > 0)
    .sort(compareProfileSignalCandidates);

  if (rankedCandidates.length === 0) {
    return {
      projectProfileName: DEFAULT_PROJECT_PROFILE_NAME,
      observedSignals: [],
      reason: DEFAULT_PROFILE_REASON,
    };
  }

  const winner = rankedCandidates[0]!;
  return {
    projectProfileName: winner.projectProfileName,
    observedSignals: winner.observedSignals,
    reason: `Observed repo signals: ${winner.observedSignals.join(", ")}.`,
  };
};

export const formatHubProjectProfileRecommendation = (
  recommendation: HubProjectProfileRecommendation,
): string => {
  const profile: ProjectProfileEntry =
    getProjectProfile(recommendation.projectProfileName) ??
    getProjectProfile(DEFAULT_PROJECT_PROFILE_NAME)!;

  if (recommendation.projectProfileName === DEFAULT_PROJECT_PROFILE_NAME) {
    return `${recommendation.reason} Defaulting to ${profile.label}.`;
  }

  return `Recommended ${profile.label} project profile. ${recommendation.reason}`;
};

export const resolveHubProjectRegistrationRepoRoot = (
  repoPath: string,
): string => {
  try {
    const repoRoot = resolveGitRepoRoot(repoPath);
    assertRepoHasInitialCommit(repoRoot, repoPath);
    return repoRoot;
  } catch {
    throw new HubProjectRegistryError({
      message: formatProjectAddRepoValidationMessage(repoPath),
    });
  }
};
