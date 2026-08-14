import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const HUB_TASK_STORE_INIT_COMMAND = "archloop tasks init";

export const HUB_TASK_STORE_REDIRECT_FILE_NAME = "redirect";
export const HUB_TASK_STORE_GIT_EXCLUDE_PATTERN = ".beads/redirect";
export const HUB_TASK_STORE_QUARANTINE_DIR_NAME = ".hub-quarantine";
export const HUB_TASK_STORE_QUARANTINE_GIT_EXCLUDE_PATTERN =
  ".beads/.hub-quarantine";
export const HUB_TASK_STORE_RUNTIME_GIT_EXCLUDE_PATTERNS = [
  ".beads/issues.jsonl",
  ".beads/interactions.jsonl",
  ".beads/events.jsonl",
] as const;

export type HubTaskStoreKind =
  | "uninitialized"
  | "legacy"
  | "managed"
  | "redirect";

export const isHubOwnedTaskStoreKind = (
  kind: HubTaskStoreKind | undefined,
): kind is "managed" | "redirect" => kind === "managed" || kind === "redirect";

export interface ResolveHubTaskStoreInput {
  readonly repoRoot: string;
  readonly hubProjectDir?: string;
}

export interface HubTaskStoreResolution {
  readonly kind: HubTaskStoreKind;
  readonly beadsDir: string;
  readonly repoBeadsDir: string;
  readonly managedBeadsDir?: string;
  readonly redirectPath?: string;
  readonly redirectTarget?: string;
  readonly redirectError?: string;
}

const HUB_TASK_STORE_METADATA_FILE_NAME = "metadata.json";
const HUB_TASK_STORE_DATABASE_DIR_NAME = "embeddeddolt";

const resolveBeadsMetadataPath = (beadsDir: string): string =>
  join(beadsDir, HUB_TASK_STORE_METADATA_FILE_NAME);

const resolveBeadsDatabaseDir = (beadsDir: string): string =>
  join(beadsDir, HUB_TASK_STORE_DATABASE_DIR_NAME);

export const isBeadsStoreMarkerPresent = (beadsDir: string): boolean =>
  existsSync(resolveBeadsMetadataPath(beadsDir));

export const isBeadsStoreDatabasePresent = (beadsDir: string): boolean =>
  existsSync(resolveBeadsDatabaseDir(beadsDir));

export const isBeadsStoreFullyInitialized = (beadsDir: string): boolean =>
  isBeadsStoreMarkerPresent(beadsDir) && isBeadsStoreDatabasePresent(beadsDir);

export const resolveManagedHubTaskStoreDir = (hubProjectDir: string): string =>
  join(hubProjectDir, ".beads");

const resolveRepoBeadsDir = (repoRoot: string): string =>
  join(repoRoot, ".beads");

export const resolveHubTaskStoreRedirectPath = (repoRoot: string): string =>
  join(resolveRepoBeadsDir(repoRoot), HUB_TASK_STORE_REDIRECT_FILE_NAME);

export const formatInvalidHubTaskStoreRedirectMessage = (
  redirectPath: string,
  redirectTarget: string,
): string =>
  `Hub Beads redirect at ${redirectPath} is invalid or inaccessible (${redirectTarget}). Fix the redirect path, or run \`${HUB_TASK_STORE_INIT_COMMAND}\` to recreate the Hub-owned task store.`;

export const formatStaleHubTaskSnapshotRedirectMessage = (
  redirectPath: string,
  redirectTarget: string,
): string =>
  `Hub Beads redirect at ${redirectPath} points at a task snapshot directory (${redirectTarget}) instead of the managed task store. Restore the redirect to the Hub-owned store under the project directory. Do not run \`${HUB_TASK_STORE_INIT_COMMAND}\` for this recovery.`;

const HUB_TASK_SNAPSHOT_FILE_NAME = "snapshot.json";

export const looksLikeHubTaskSnapshotPath = (path: string): boolean =>
  /(?:^|[/\\])task-snapshots[/\\]/.test(path);

export const isHubTaskSnapshotDirectory = (dir: string): boolean =>
  existsSync(join(dir, HUB_TASK_SNAPSHOT_FILE_NAME)) &&
  !isBeadsStoreMarkerPresent(dir);

const formatRedirectTargetError = (
  redirectPath: string,
  redirectTarget: string,
): string => {
  if (
    looksLikeHubTaskSnapshotPath(redirectTarget) ||
    (existsSync(redirectTarget) && isHubTaskSnapshotDirectory(redirectTarget))
  ) {
    return formatStaleHubTaskSnapshotRedirectMessage(
      redirectPath,
      redirectTarget,
    );
  }
  return formatInvalidHubTaskStoreRedirectMessage(redirectPath, redirectTarget);
};

const readRedirectTarget = (
  repoRoot: string,
  redirectPath: string,
): string | undefined => {
  try {
    const raw = readFileSync(redirectPath, "utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!raw) {
      return undefined;
    }
    return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
  } catch {
    return undefined;
  }
};

export const resolveHubTaskStore = (
  input: ResolveHubTaskStoreInput,
): HubTaskStoreResolution => {
  const repoBeadsDir = resolveRepoBeadsDir(input.repoRoot);
  const managedBeadsDir = input.hubProjectDir
    ? resolveManagedHubTaskStoreDir(input.hubProjectDir)
    : undefined;
  const redirectPath = resolveHubTaskStoreRedirectPath(input.repoRoot);

  if (existsSync(redirectPath)) {
    const redirectTarget = readRedirectTarget(input.repoRoot, redirectPath);
    if (!redirectTarget || !existsSync(redirectTarget)) {
      return {
        kind: "redirect",
        beadsDir: repoBeadsDir,
        repoBeadsDir,
        managedBeadsDir,
        redirectPath,
        redirectTarget,
        redirectError: formatRedirectTargetError(
          redirectPath,
          redirectTarget ?? "(empty redirect)",
        ),
      };
    }

    if (!isBeadsStoreMarkerPresent(redirectTarget)) {
      return {
        kind: "redirect",
        beadsDir: repoBeadsDir,
        repoBeadsDir,
        managedBeadsDir,
        redirectPath,
        redirectTarget,
        redirectError: formatRedirectTargetError(redirectPath, redirectTarget),
      };
    }

    return {
      kind: "redirect",
      beadsDir: redirectTarget,
      repoBeadsDir,
      managedBeadsDir,
      redirectPath,
      redirectTarget,
    };
  }

  if (managedBeadsDir && isBeadsStoreFullyInitialized(managedBeadsDir)) {
    return {
      kind: "managed",
      beadsDir: managedBeadsDir,
      repoBeadsDir,
      managedBeadsDir,
    };
  }

  if (isBeadsStoreFullyInitialized(repoBeadsDir)) {
    return {
      kind: "legacy",
      beadsDir: repoBeadsDir,
      repoBeadsDir,
      managedBeadsDir,
    };
  }

  return {
    kind: "uninitialized",
    beadsDir: managedBeadsDir ?? repoBeadsDir,
    repoBeadsDir,
    managedBeadsDir,
  };
};

const resolveGitExcludePath = (repoRoot: string): string => {
  try {
    const gitPath = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    return isAbsolute(gitPath) ? gitPath : resolve(repoRoot, gitPath);
  } catch {
    return join(repoRoot, ".git", "info", "exclude");
  }
};

export const resolveHubTaskStoreQuarantineDir = (repoRoot: string): string =>
  join(resolveRepoBeadsDir(repoRoot), HUB_TASK_STORE_QUARANTINE_DIR_NAME);

const fsyncPath = (path: string): void => {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export const ensureHubTaskStoreGitExcludePattern = (
  repoRoot: string,
  pattern: string,
): void => {
  const excludePath = resolveGitExcludePath(repoRoot);
  mkdirSync(dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    // `.git/info/exclude` is created below when the repo has none yet.
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((line) => line.trim() === pattern)) {
    return;
  }
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(excludePath, `${prefix}${pattern}\n`);
};

export const ensureHubTaskStoreMigrationGitExcludes = (
  repoRoot: string,
): void => {
  ensureHubTaskStoreGitExcludePattern(
    repoRoot,
    HUB_TASK_STORE_QUARANTINE_GIT_EXCLUDE_PATTERN,
  );
  for (const pattern of HUB_TASK_STORE_RUNTIME_GIT_EXCLUDE_PATTERNS) {
    ensureHubTaskStoreGitExcludePattern(repoRoot, pattern);
  }
};

export const installHubTaskStoreRedirect = (
  repoRoot: string,
  managedBeadsDir: string,
): void => {
  const repoBeadsDir = resolveRepoBeadsDir(repoRoot);
  mkdirSync(repoBeadsDir, { recursive: true });
  const redirectPath = resolveHubTaskStoreRedirectPath(repoRoot);
  const tempPath = `${redirectPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${managedBeadsDir}\n`, "utf8");
  fsyncPath(tempPath);
  renameSync(tempPath, redirectPath);
  ensureHubTaskStoreGitExcludePattern(
    repoRoot,
    HUB_TASK_STORE_GIT_EXCLUDE_PATTERN,
  );
  ensureHubTaskStoreMigrationGitExcludes(repoRoot);
};
