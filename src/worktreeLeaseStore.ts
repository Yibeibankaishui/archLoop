import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type WorktreeLeaseOwnerKind = "direct" | "hub";

export interface WorktreeLeaseOwner {
  readonly kind: WorktreeLeaseOwnerKind;
  readonly taskId?: string;
  readonly flowId?: string;
  readonly batchId?: string;
  readonly runId?: string;
}

export type WorktreeLeaseState = "active" | "stale";

export interface WorktreeLeaseRecord {
  readonly lockFileName: string;
  readonly worktreeName: string;
  readonly branch: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly owner?: WorktreeLeaseOwner;
  readonly state: WorktreeLeaseState;
  readonly malformed: boolean;
}

export type ProcessAliveChecker = (pid: number) => boolean;

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const branchToWorktreeName = (branch: string): string =>
  branch.replace(/\//g, "-");

export const resolveWorktreeLeaseLockPath = (
  repoRoot: string,
  worktreeName: string,
): string => join(repoRoot, ".archloop", "locks", `${worktreeName}.lock`);

export const resolveWorktreeLeasesDir = (repoRoot: string): string =>
  join(repoRoot, ".archloop", "locks");

export const isProcessAlive: ProcessAliveChecker = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : undefined;
    return code === "EPERM";
  }
};

const parseWorktreeLeaseOwner = (
  value: unknown,
): WorktreeLeaseOwner | undefined => {
  const record = readObject(value);
  const kind = readString(record.kind);
  if (kind !== "direct" && kind !== "hub") {
    return undefined;
  }

  return {
    kind,
    taskId: readString(record.taskId ?? record.task_id),
    flowId: readString(record.flowId ?? record.flow_id),
    batchId: readString(record.batchId ?? record.batch_id),
    runId: readString(record.runId ?? record.run_id),
  };
};

export const parseWorktreeLeaseFile = (
  lockFileName: string,
  raw: string,
  checkProcessAlive: ProcessAliveChecker = isProcessAlive,
): WorktreeLeaseRecord => {
  const worktreeName = lockFileName.endsWith(".lock")
    ? lockFileName.slice(0, -".lock".length)
    : lockFileName;

  try {
    const record = readObject(JSON.parse(raw) as unknown);
    const branch = readString(record.branch);
    const pid = readNumber(record.pid);
    const acquiredAt = readString(record.acquiredAt ?? record.acquired_at);
    const owner = parseWorktreeLeaseOwner(record.owner);

    if (!branch || pid === undefined || !acquiredAt) {
      return {
        lockFileName,
        worktreeName,
        branch: branch ?? worktreeName,
        pid: pid ?? -1,
        acquiredAt: acquiredAt ?? "unknown",
        owner,
        state: "stale",
        malformed: true,
      };
    }

    return {
      lockFileName,
      worktreeName,
      branch,
      pid,
      acquiredAt,
      owner,
      state: checkProcessAlive(pid) ? "active" : "stale",
      malformed: false,
    };
  } catch {
    return {
      lockFileName,
      worktreeName,
      branch: worktreeName,
      pid: -1,
      acquiredAt: "unknown",
      state: "stale",
      malformed: true,
    };
  }
};

export const listWorktreeLeases = (
  repoRoot: string,
  checkProcessAlive: ProcessAliveChecker = isProcessAlive,
): readonly WorktreeLeaseRecord[] => {
  const locksDir = resolveWorktreeLeasesDir(repoRoot);
  if (!existsSync(locksDir)) {
    return [];
  }

  return readdirSync(locksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lock"))
    .map((entry) => {
      const lockPath = join(locksDir, entry.name);
      const raw = readFileSync(lockPath, "utf8");
      return parseWorktreeLeaseFile(entry.name, raw, checkProcessAlive);
    })
    .sort((left, right) => left.branch.localeCompare(right.branch));
};
