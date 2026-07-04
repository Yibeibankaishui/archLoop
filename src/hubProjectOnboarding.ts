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
  profileName: keyof typeof PROJECT_PROFILE_SIGNAL_FILES,
): readonly string[] =>
  PROJECT_PROFILE_SIGNAL_FILES[profileName].filter((signal) =>
    existsSync(join(repoRoot, signal)),
  );

export const suggestHubProjectName = (repoRoot: string): string =>
  (() => {
    const packageName = readPackageJsonName(repoRoot);
    return packageName && isFriendlyProjectName(packageName)
      ? packageName
      : basename(repoRoot);
  })();

export const recommendHubProjectProfile = (
  repoRoot: string,
): HubProjectProfileRecommendation => {
  const priorityOrder = new Map([
    ["node", 0],
    ["python", 1],
    ["cpp", 2],
  ]);
  const candidates: Array<{
    readonly projectProfileName: string;
    readonly observedSignals: readonly string[];
  }> = [
    {
      projectProfileName: "node",
      observedSignals: readObservedSignals(repoRoot, "node"),
    },
    {
      projectProfileName: "python",
      observedSignals: readObservedSignals(repoRoot, "python"),
    },
    {
      projectProfileName: "cpp",
      observedSignals: readObservedSignals(repoRoot, "cpp"),
    },
  ];

  const rankedCandidates = candidates
    .filter((candidate) => candidate.observedSignals.length > 0)
    .sort((left, right) => {
      const signalCountDelta =
        right.observedSignals.length - left.observedSignals.length;
      if (signalCountDelta !== 0) {
        return signalCountDelta;
      }
      return (
        (priorityOrder.get(left.projectProfileName) ??
          Number.MAX_SAFE_INTEGER) -
        (priorityOrder.get(right.projectProfileName) ?? Number.MAX_SAFE_INTEGER)
      );
    });

  if (rankedCandidates.length === 0) {
    return {
      projectProfileName: DEFAULT_PROJECT_PROFILE_NAME,
      observedSignals: [],
      reason: "No obvious stack signals were observed in the repository root.",
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
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return repoRoot;
  } catch {
    throw new HubProjectRegistryError({
      message:
        `archloop project add requires ${repoPath} to point at an existing git repository with at least one commit. ` +
        'Run `git init`, stage your files, and `git commit -m "Initial commit"` before retrying.',
    });
  }
};
