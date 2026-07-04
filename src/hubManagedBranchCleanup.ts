import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  type WorktreeLeaseRecord,
  listWorktreeLeases,
} from "./worktreeLeaseStore.js";
import {
  resolveArchloopUserDataDir,
  resolveGitRepoRoot,
  resolveHubProjectDir,
} from "./projectStatus.js";

const execFileAsync = promisify(execFile);
const MANAGED_BRANCH_PREFIX = "archloop/";

export interface HubManagedBranchOwnershipRecord {
  readonly taskId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly branch: string;
  readonly claimedAt: string;
  readonly baseHead: string;
  readonly branchExistedBeforeClaim: boolean;
}

export type HubManagedBranchCleanupSkipReason =
  | "missing_ownership"
  | "missing_branch"
  | "branch_existed_before_claim"
  | "unmerged_work"
  | "active_worktree_lease"
  | "checked_out_worktree"
  | "dirty_preserved_worktree";

export interface HubManagedBranchCleanupSkipDetail {
  readonly reason: HubManagedBranchCleanupSkipReason;
  readonly message: string;
}

export interface HubManagedBranchCleanupCandidate {
  readonly branch: string;
  readonly ownership?: HubManagedBranchOwnershipRecord;
  readonly exists: boolean;
  readonly mergedIntoTarget: boolean;
  readonly worktreePaths: readonly string[];
  readonly activeLeases: readonly WorktreeLeaseRecord[];
  readonly skipReasons: readonly HubManagedBranchCleanupSkipDetail[];
}

export interface HubManagedBranchCleanupEvaluation {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly targetBranch: string;
  readonly targetHead: string;
  readonly managedSafeCandidates: readonly HubManagedBranchCleanupCandidate[];
  readonly managedBlockedBranches: readonly HubManagedBranchCleanupCandidate[];
  readonly unownedCandidates: readonly HubManagedBranchCleanupCandidate[];
}

export interface EvaluateHubManagedBranchCleanupInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly hubProjectDir?: string;
}

interface BranchWorktreeState {
  readonly paths: readonly string[];
  readonly checkedOut: boolean;
  readonly dirtyManagedPaths: readonly string[];
}

interface GitWorktreeEntry {
  readonly path: string;
  readonly branch?: string;
}

interface RawHubTaskClaimEvent {
  readonly type?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly batchId?: string;
  readonly branch?: string;
  readonly createdAt?: string;
  readonly claim?: {
    readonly taskId?: string;
    readonly runId?: string;
    readonly batchId?: string;
    readonly branch?: string;
    readonly claimedAt?: string;
    readonly baseHead?: string;
    readonly branchExistedBeforeClaim?: boolean;
  };
}

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const readBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  return undefined;
};

const isManagedBranch = (branch: string): boolean =>
  branch.startsWith(MANAGED_BRANCH_PREFIX);

const execGit = async (
  args: readonly string[],
  cwd: string,
): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
};

const execGitExists = async (
  args: readonly string[],
  cwd: string,
): Promise<boolean> => {
  try {
    await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
};

const readJsonlRecords = (path: string): readonly Record<string, unknown>[] => {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
};

const listRunDirs = (hubProjectDir: string): readonly string[] => {
  const runsDir = join(hubProjectDir, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }

  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsDir, entry.name))
    .sort();
};

const collectOwnershipRecords = (
  hubProjectDir: string,
): readonly HubManagedBranchOwnershipRecord[] => {
  const records = new Map<string, HubManagedBranchOwnershipRecord>();

  for (const runDir of listRunDirs(hubProjectDir)) {
    const taskEvents = readJsonlRecords(join(runDir, "events", "task.jsonl"));
    for (const event of taskEvents) {
      const record = readObject(event) as RawHubTaskClaimEvent;
      if (record.type !== "task_claimed" || !record.claim) {
        continue;
      }

      const taskId = readString(record.claim.taskId ?? record.taskId);
      const runId = readString(record.claim.runId ?? record.runId);
      const batchId = readString(record.claim.batchId ?? record.batchId);
      const branch = readString(record.claim.branch ?? record.branch);
      const claimedAt = readString(record.claim.claimedAt ?? record.createdAt);
      const baseHead = readString(record.claim.baseHead);
      const branchExistedBeforeClaim = readBoolean(
        record.claim.branchExistedBeforeClaim,
      );
      if (
        !taskId ||
        !runId ||
        !batchId ||
        !branch ||
        !claimedAt ||
        !baseHead ||
        branchExistedBeforeClaim === undefined
      ) {
        continue;
      }

      const ownership: HubManagedBranchOwnershipRecord = {
        taskId,
        runId,
        batchId,
        branch,
        claimedAt,
        baseHead,
        branchExistedBeforeClaim,
      };

      const current = records.get(branch);
      if (!current || current.claimedAt.localeCompare(claimedAt) <= 0) {
        records.set(branch, ownership);
      }
    }
  }

  return [...records.values()].sort((left, right) =>
    left.branch.localeCompare(right.branch),
  );
};

const EMPTY_WORKTREE_STATE: BranchWorktreeState = {
  paths: [],
  checkedOut: false,
  dirtyManagedPaths: [],
};

const parseWorktreeList = async (
  repoRoot: string,
): Promise<readonly GitWorktreeEntry[]> => {
  const output = await execGit(["worktree", "list", "--porcelain"], repoRoot);
  const entries: GitWorktreeEntry[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (currentPath) {
        entries.push({
          path: currentPath,
          ...(currentBranch ? { branch: currentBranch } : {}),
        });
      }
      currentPath = line.slice("worktree ".length).trim();
      currentBranch = undefined;
      continue;
    }

    if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length).trim();
    }
  }

  if (currentPath) {
    entries.push({
      path: currentPath,
      ...(currentBranch ? { branch: currentBranch } : {}),
    });
  }

  return entries;
};

const readCurrentBranch = async (repoRoot: string): Promise<string> => {
  const currentBranch = await execGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    repoRoot,
  ).catch(() => "");
  return currentBranch.length > 0 ? currentBranch : "HEAD";
};

const readCurrentHead = async (repoRoot: string): Promise<string> =>
  execGit(["rev-parse", "HEAD"], repoRoot);

const listManagedBranchRefs = async (
  repoRoot: string,
): Promise<readonly string[]> => {
  const output = await execGit(
    [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${MANAGED_BRANCH_PREFIX}`,
    ],
    repoRoot,
  );

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isManagedBranch);
};

const hasDirtyWorktree = async (path: string): Promise<boolean> => {
  const output = await execGit(["status", "--porcelain"], path).catch(() => "");
  return output.trim().length > 0;
};

const collectBranchWorktreeState = async (
  repoRoot: string,
  branch: string,
  worktreeEntries: readonly GitWorktreeEntry[],
): Promise<BranchWorktreeState> => {
  const paths = worktreeEntries
    .filter((entry) => entry.branch === branch)
    .map((entry) => entry.path);

  const managedRoot = join(repoRoot, ".archloop", "worktrees");
  const dirtyManagedPaths: string[] = [];
  for (const path of paths) {
    if (!path.startsWith(managedRoot)) {
      continue;
    }
    if (await hasDirtyWorktree(path)) {
      dirtyManagedPaths.push(path);
    }
  }

  return {
    paths,
    checkedOut: paths.length > 0,
    dirtyManagedPaths,
  };
};

const buildSkipDetail = (
  reason: HubManagedBranchCleanupSkipReason,
  message: string,
): HubManagedBranchCleanupSkipDetail => ({
  reason,
  message,
});

const activeLeasesForBranch = (
  branch: string,
  leases: readonly WorktreeLeaseRecord[],
): readonly WorktreeLeaseRecord[] =>
  leases.filter((lease) => lease.branch === branch && lease.state === "active");

const mapOwnershipRecordsByBranch = (
  records: readonly HubManagedBranchOwnershipRecord[],
): ReadonlyMap<string, HubManagedBranchOwnershipRecord> =>
  new Map(records.map((record) => [record.branch, record] as const));

const collectCandidateBranches = (input: {
  readonly ownershipRecords: readonly HubManagedBranchOwnershipRecord[];
  readonly managedBranchRefs: readonly string[];
  readonly worktreeEntries: readonly GitWorktreeEntry[];
}): readonly string[] => {
  const branches = new Set<string>();
  for (const branch of input.managedBranchRefs) {
    branches.add(branch);
  }
  for (const record of input.ownershipRecords) {
    branches.add(record.branch);
  }
  for (const entry of input.worktreeEntries) {
    if (entry.branch && isManagedBranch(entry.branch)) {
      branches.add(entry.branch);
    }
  }
  return [...branches].sort();
};

const evaluateCandidate = async (input: {
  readonly repoRoot: string;
  readonly branch: string;
  readonly ownership?: HubManagedBranchOwnershipRecord;
  readonly worktreeEntries: readonly GitWorktreeEntry[];
  readonly leases: readonly WorktreeLeaseRecord[];
  readonly targetHead: string;
}): Promise<HubManagedBranchCleanupCandidate> => {
  const exists = await execGitExists(
    ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
    input.repoRoot,
  );
  const mergedIntoTarget = exists
    ? await execGit(
        ["merge-base", "--is-ancestor", input.branch, input.targetHead],
        input.repoRoot,
      )
        .then(() => true)
        .catch(() => false)
    : false;
  const worktreeState = exists
    ? await collectBranchWorktreeState(
        input.repoRoot,
        input.branch,
        input.worktreeEntries,
      )
    : EMPTY_WORKTREE_STATE;
  const activeLeases = activeLeasesForBranch(input.branch, input.leases);

  const skipReasons: HubManagedBranchCleanupSkipDetail[] = [];
  if (!input.ownership) {
    skipReasons.push(
      buildSkipDetail(
        "missing_ownership",
        `Branch ${input.branch} has no Hub-managed ownership record.`,
      ),
    );
  } else if (input.ownership.branchExistedBeforeClaim) {
    skipReasons.push(
      buildSkipDetail(
        "branch_existed_before_claim",
        `Branch ${input.branch} existed before Hub claimed task ${input.ownership.taskId}; keep it out of automatic cleanup.`,
      ),
    );
  }

  if (!exists) {
    skipReasons.push(
      buildSkipDetail(
        "missing_branch",
        `Branch ${input.branch} does not exist.`,
      ),
    );
  }

  if (exists && !mergedIntoTarget) {
    skipReasons.push(
      buildSkipDetail(
        "unmerged_work",
        `Branch ${input.branch} still has commits not reachable from HEAD.`,
      ),
    );
  }

  if (activeLeases.length > 0) {
    skipReasons.push(
      buildSkipDetail(
        "active_worktree_lease",
        `Branch ${input.branch} still has an active worktree lease.`,
      ),
    );
  }

  if (worktreeState.checkedOut) {
    skipReasons.push(
      buildSkipDetail(
        "checked_out_worktree",
        `Branch ${input.branch} is checked out in ${worktreeState.paths.join(", ")}.`,
      ),
    );
  }

  if (worktreeState.dirtyManagedPaths.length > 0) {
    skipReasons.push(
      buildSkipDetail(
        "dirty_preserved_worktree",
        `Branch ${input.branch} has dirty preserved worktree content in ${worktreeState.dirtyManagedPaths.join(", ")}.`,
      ),
    );
  }

  return {
    branch: input.branch,
    ...(input.ownership ? { ownership: input.ownership } : {}),
    exists,
    mergedIntoTarget,
    worktreePaths: worktreeState.paths,
    activeLeases,
    skipReasons,
  };
};

const sortCandidates = (
  left: HubManagedBranchCleanupCandidate,
  right: HubManagedBranchCleanupCandidate,
): number => left.branch.localeCompare(right.branch);

export const findHubManagedBranchCleanupCandidate = (
  evaluation: HubManagedBranchCleanupEvaluation,
  branch: string,
): HubManagedBranchCleanupCandidate | undefined => {
  for (const candidates of [
    evaluation.managedSafeCandidates,
    evaluation.managedBlockedBranches,
    evaluation.unownedCandidates,
  ]) {
    const candidate = candidates.find((entry) => entry.branch === branch);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
};

export const evaluateHubManagedBranchCleanup = async (
  input: EvaluateHubManagedBranchCleanupInput,
): Promise<HubManagedBranchCleanupEvaluation> => {
  const repoRoot = resolveGitRepoRoot(input.cwd);
  const hubProjectDir =
    input.hubProjectDir ??
    resolveHubProjectDir(resolveArchloopUserDataDir(input.env), repoRoot);
  const targetBranch = await readCurrentBranch(repoRoot);
  const targetHead = await readCurrentHead(repoRoot);
  const ownershipRecords = collectOwnershipRecords(hubProjectDir);
  const ownershipByBranch = mapOwnershipRecordsByBranch(ownershipRecords);
  const worktreeEntries = await parseWorktreeList(repoRoot);
  const leases = listWorktreeLeases(repoRoot);
  const branches = collectCandidateBranches({
    ownershipRecords,
    managedBranchRefs: await listManagedBranchRefs(repoRoot),
    worktreeEntries,
  });

  const candidates: HubManagedBranchCleanupCandidate[] = [];
  for (const branch of branches) {
    candidates.push(
      await evaluateCandidate({
        repoRoot,
        branch,
        ownership: ownershipByBranch.get(branch),
        worktreeEntries,
        leases,
        targetHead,
      }),
    );
  }

  const managedSafeCandidates = candidates
    .filter((candidate) => candidate.ownership !== undefined)
    .filter((candidate) => candidate.skipReasons.length === 0)
    .sort(sortCandidates);
  const managedBlockedBranches = candidates
    .filter((candidate) => candidate.ownership !== undefined)
    .filter((candidate) => candidate.skipReasons.length > 0)
    .sort(sortCandidates);
  const unownedCandidates = candidates
    .filter((candidate) => candidate.ownership === undefined)
    .sort(sortCandidates);

  return {
    repoRoot,
    hubProjectDir,
    targetBranch,
    targetHead,
    managedSafeCandidates,
    managedBlockedBranches,
    unownedCandidates,
  };
};
