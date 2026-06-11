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
    return stdout.toString().trim();
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

const parseJsonCount = (output: string): number => {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.length;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of [
        "total_count",
        "totalCount",
        "count",
        "ready_count",
        "readyCount",
        "open_count",
        "openCount",
        "tasks",
        "items",
      ]) {
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

const readBdJsonCount = (args: readonly string[], cwd: string): number => {
  try {
    const stdout = execFileSync("bd", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseJsonCount(stdout.toString());
  } catch {
    return 0;
  }
};

const ensureHubProjectDir = (hubProjectDir: string): boolean => {
  const existed = existsSync(hubProjectDir);
  mkdirSync(hubProjectDir, { recursive: true });
  return existed;
};

export const resolveHubProjectStatus = (
  options: HubProjectStatusOptions = {},
): HubProjectStatus => {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = options.resolveRepoRoot
    ? options.resolveRepoRoot(cwd)
    : resolveGitRepoRoot(cwd);
  const sandcastleUserDataDir =
    options.sandcastleUserDataDir ?? resolveSandcastleUserDataDir();
  const hubProjectDir = resolveHubProjectDir(sandcastleUserDataDir, repoRoot);
  const projectRegistered = (
    options.ensureHubProjectDir ?? ensureHubProjectDir
  )(hubProjectDir);
  const beadsAvailable = (
    options.detectBeadsAvailable ?? (() => commandExists("bd"))
  )();
  const taskCounts = beadsAvailable
    ? {
        ready: (
          options.countReadyTasks ??
          ((repoRootPath) => readBdJsonCount(["ready", "--json"], repoRootPath))
        )(repoRoot),
        total: (
          options.countTotalTasks ??
          ((repoRootPath) => readBdJsonCount(["list", "--json"], repoRootPath))
        )(repoRoot),
      }
    : { ready: 0, total: 0 };

  return {
    repoRoot,
    sandcastleUserDataDir,
    hubProjectDir,
    projectRegistered,
    beadsAvailable,
    taskCounts,
  };
};
