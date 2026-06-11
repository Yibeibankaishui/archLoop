import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HubProjectTaskCounts {
  readonly ready: number;
  readonly total: number;
}

export interface HubProjectStatus {
  readonly repoRoot: string;
  readonly sandcastleUserDataDir: string;
  readonly hubProjectDir: string;
  readonly projectRegistered: boolean;
  readonly beadsAvailable: boolean;
  readonly taskCounts: HubProjectTaskCounts;
}

export interface HubProjectStatusOptions {
  readonly cwd?: string;
  readonly sandcastleUserDataDir?: string;
  readonly resolveRepoRoot?: (cwd: string) => string;
  readonly detectBeadsAvailable?: () => boolean;
  readonly countReadyTasks?: (repoRoot: string) => number;
  readonly countTotalTasks?: (repoRoot: string) => number;
  readonly ensureHubProjectDir?: (hubProjectDir: string) => boolean;
}

const BD_JSON_COUNT_KEYS = [
  "total_count",
  "totalCount",
  "count",
  "ready_count",
  "readyCount",
  "open_count",
  "openCount",
  "tasks",
  "items",
] as const;

export const resolveSandcastleUserDataDir = (
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string => {
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  const baseDir =
    xdgDataHome && xdgDataHome.length > 0
      ? xdgDataHome
      : join(homeDir, ".local", "share");
  return join(baseDir, "sandcastle");
};

export const resolveHubProjectDir = (
  sandcastleUserDataDir: string,
  repoRoot: string,
): string => {
  const projectId = createHash("sha256")
    .update(repoRoot)
    .digest("hex")
    .slice(0, 12);
  return join(sandcastleUserDataDir, "hub", "projects", projectId);
};

export const resolveGitRepoRoot = (cwd: string): string => {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return stdout.trim();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "unable to resolve git repo root";
    throw new Error(
      `sandcastle project status requires a git repository: ${message}`,
    );
  }
};

const parseJsonCount = (output: string): number => {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.length;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of BD_JSON_COUNT_KEYS) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (Array.isArray(value)) {
          return value.length;
        }
      }
    }
  } catch {
    // Fall through to zero for unreadable output.
  }
  return 0;
};

const commandExists = (command: string): boolean => {
  const checkCommand =
    process.platform === "win32" ? `where ${command}` : `command -v ${command}`;
  try {
    execSync(checkCommand, {
      stdio: "ignore",
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
};

const countBdJsonResult = (args: readonly string[], cwd: string): number => {
  try {
    const stdout = execFileSync("bd", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseJsonCount(stdout);
  } catch {
    return 0;
  }
};

const registerHubProjectDir = (hubProjectDir: string): boolean => {
  const existedBeforeRegistration = existsSync(hubProjectDir);
  mkdirSync(hubProjectDir, { recursive: true });
  return existedBeforeRegistration;
};

const resolveBeadsAvailable = (
  detectBeadsAvailable: HubProjectStatusOptions["detectBeadsAvailable"],
): boolean => (detectBeadsAvailable ?? (() => commandExists("bd")))();

const resolveTaskCounts = (
  repoRoot: string,
  beadsAvailable: boolean,
  countReadyTasks: HubProjectStatusOptions["countReadyTasks"],
  countTotalTasks: HubProjectStatusOptions["countTotalTasks"],
): HubProjectTaskCounts =>
  beadsAvailable
    ? {
        ready: (
          countReadyTasks ??
          ((repoRootPath) =>
            countBdJsonResult(["ready", "--json"], repoRootPath))
        )(repoRoot),
        total: (
          countTotalTasks ??
          ((repoRootPath) =>
            countBdJsonResult(["list", "--json"], repoRootPath))
        )(repoRoot),
      }
    : { ready: 0, total: 0 };

const resolveProjectRegistration = (
  hubProjectDir: string,
  ensureHubProjectDir: HubProjectStatusOptions["ensureHubProjectDir"],
): boolean => (ensureHubProjectDir ?? registerHubProjectDir)(hubProjectDir);

const resolveRepoRoot = (
  cwd: string,
  resolveRepoRootOption: HubProjectStatusOptions["resolveRepoRoot"],
): string =>
  resolveRepoRootOption ? resolveRepoRootOption(cwd) : resolveGitRepoRoot(cwd);

const resolveUserDataDir = (
  sandcastleUserDataDir: HubProjectStatusOptions["sandcastleUserDataDir"],
): string => sandcastleUserDataDir ?? resolveSandcastleUserDataDir();

export const resolveHubProjectStatus = (
  options: HubProjectStatusOptions = {},
): HubProjectStatus => {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd, options.resolveRepoRoot);
  const sandcastleUserDataDir = resolveUserDataDir(
    options.sandcastleUserDataDir,
  );
  const hubProjectDir = resolveHubProjectDir(sandcastleUserDataDir, repoRoot);
  const projectRegistered = resolveProjectRegistration(
    hubProjectDir,
    options.ensureHubProjectDir,
  );
  const beadsAvailable = resolveBeadsAvailable(options.detectBeadsAvailable);
  const taskCounts = resolveTaskCounts(
    repoRoot,
    beadsAvailable,
    options.countReadyTasks,
    options.countTotalTasks,
  );

  return {
    repoRoot,
    sandcastleUserDataDir,
    hubProjectDir,
    projectRegistered,
    beadsAvailable,
    taskCounts,
  };
};
