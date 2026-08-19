import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  HubLandingCrash,
  type HubLandingCandidate,
  type HubLandingFaultInjection,
} from "./hubLanding.js";
import { isGitOid } from "./hubLandingTransaction.js";

const execFileAsync = promisify(execFile);

export const HUB_CHECKOUT_SYNC_PENDING = "checkout_sync_pending";

export const HUB_CHECKOUT_PENDING_REASONS = [
  "staged_changes",
  "unstaged_changes",
  "untracked_paths",
  "rename_or_delete",
  "operation_in_progress",
  "sparse_checkout",
  "submodule",
  "multiple_worktrees",
  "branch_diverged",
] as const;

export type HubCheckoutPendingReason =
  (typeof HUB_CHECKOUT_PENDING_REASONS)[number];

export const HUB_CHECKOUT_BRANCH_RELATIONS = [
  "ahead",
  "behind",
  "diverged",
  "missing",
] as const;

export type HubCheckoutBranchRelation =
  (typeof HUB_CHECKOUT_BRANCH_RELATIONS)[number];

export type HubCheckoutProjectionStatus = "pending" | "succeeded";

export interface HubCheckoutOutboxItem {
  readonly version: 1;
  readonly id: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly hostTargetBranch: string;
  readonly branchRef: string;
  readonly candidateOid: string;
  readonly expectedBranchOid: string;
  readonly publishTargetRef: string;
  readonly status: HubCheckoutProjectionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pendingReason?: HubCheckoutPendingReason;
  readonly blockingPaths?: readonly string[];
  readonly observedHostBranchOid?: string;
  readonly expectedPublishBranchOid?: string;
  readonly branchRelation?: HubCheckoutBranchRelation;
  readonly message?: string;
  readonly projectedOid?: string;
  readonly worktreePath?: string;
}

export interface HubCheckoutOutboxInspection {
  readonly items: readonly HubCheckoutOutboxItem[];
  readonly pendingCount: number;
  readonly succeededCount: number;
  readonly message: string;
  readonly nextAction: string;
}

export interface HubCheckoutProjectionAttempt {
  readonly item: HubCheckoutOutboxItem;
  readonly status: HubCheckoutProjectionStatus;
  readonly pendingReason?: HubCheckoutPendingReason;
  readonly blockingPaths?: readonly string[];
  readonly observedHostBranchOid?: string;
  readonly expectedPublishBranchOid?: string;
  readonly branchRelation?: HubCheckoutBranchRelation;
  readonly message: string;
}

export interface HubCheckoutProjectionOutcome {
  readonly attempts: readonly HubCheckoutProjectionAttempt[];
  readonly pendingCount: number;
  readonly succeededCount: number;
  readonly message: string;
}

export interface EnqueueHubCheckoutProjectionInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly candidate: Pick<
    HubLandingCandidate,
    "transactionId" | "taskId" | "policy"
  >;
  readonly candidateOid: string;
  readonly now?: Date;
}

export interface ProjectHubCheckoutOutboxInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
}

const NO_RECOVER_SUFFIX =
  "This is not a task failure and does not require a recovery command.";

const CHECKOUT_NO_HOST_MUTATION =
  "archLoop will not stash, reset, force-update, or overwrite the host branch.";

const pendingAction =
  "Wait for the automatic retry; Hub will fast-forward the host branch when Git can prove the checkout safe.";

const dirtyPendingAction =
  "Commit or stash the listed host paths, then retry the same run. Hub will fast-forward the host branch when Git can prove the checkout safe.";

const branchDivergencePendingAction = `Inspect the host branch and Hub publish-target histories, reconcile them manually, then retry the same run. ${CHECKOUT_NO_HOST_MUTATION}`;

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});

const gitExecSync = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(),
  });

const gitTextSync = (cwd: string, args: readonly string[]): string =>
  gitExecSync(cwd, args).trim();

// Porcelain v1 encodes unstaged work as ` M path`. trim() would drop the
// leading XY space and slice the path wrong (`hello.txt` → `ello.txt`).
const gitPorcelainZSync = (cwd: string, args: readonly string[]): string =>
  gitExecSync(cwd, args);

const gitOkSync = (cwd: string, args: readonly string[]): boolean => {
  try {
    gitTextSync(cwd, args);
    return true;
  } catch {
    return false;
  }
};

const tryGitTextSync = (
  cwd: string,
  args: readonly string[],
): string | undefined => {
  try {
    return gitTextSync(cwd, args);
  } catch {
    return undefined;
  }
};

const tryGitPorcelainZSync = (
  cwd: string,
  args: readonly string[],
): string | undefined => {
  try {
    return gitPorcelainZSync(cwd, args);
  } catch {
    return undefined;
  }
};

const gitTextAsync = async (
  cwd: string,
  args: readonly string[],
): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
  });
  return String(stdout).trim();
};

const fsyncPath = (path: string): void => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const writeAtomicJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsyncPath(tempPath);
  renameSync(tempPath, path);
};

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const isPendingReason = (value: unknown): value is HubCheckoutPendingReason =>
  typeof value === "string" &&
  (HUB_CHECKOUT_PENDING_REASONS as readonly string[]).includes(value);

const isBranchRelation = (
  value: unknown,
): value is HubCheckoutBranchRelation =>
  typeof value === "string" &&
  (HUB_CHECKOUT_BRANCH_RELATIONS as readonly string[]).includes(value);

const readStringArray = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined => {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const paths = value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
  return paths.length > 0 ? paths : undefined;
};

export const resolveHubCheckoutOutboxDir = (hubProjectDir: string): string =>
  join(hubProjectDir, "landing", "checkout-outbox");

export const resolveHubCheckoutProjectionId = (input: {
  readonly transactionId: string;
  readonly hostTargetBranch: string;
  readonly candidateOid: string;
}): string => {
  const digest = createHash("sha256")
    .update(
      `${input.transactionId}\0${input.hostTargetBranch}\0${input.candidateOid}`,
    )
    .digest("hex")
    .slice(0, 16);
  return `cpo-${digest}`;
};

const resolveOutboxItemPath = (hubProjectDir: string, id: string): string =>
  join(resolveHubCheckoutOutboxDir(hubProjectDir), `${id}.json`);

const resolveDisabledHooksDir = (hubProjectDir: string): string => {
  const dir = join(hubProjectDir, "landing", "disabled-git-hooks");
  mkdirSync(dir, { recursive: true });
  return dir;
};

const hooklessArgs = (
  hubProjectDir: string,
  args: readonly string[],
): readonly string[] => [
  "-c",
  `core.hooksPath=${resolveDisabledHooksDir(hubProjectDir)}`,
  ...args,
];

const branchRefFor = (hostTargetBranch: string): string =>
  hostTargetBranch.startsWith("refs/")
    ? hostTargetBranch
    : `refs/heads/${hostTargetBranch}`;

const parseOutboxItem = (value: unknown): HubCheckoutOutboxItem | undefined => {
  const record = readObject(value);
  if (record.version !== 1) {
    return undefined;
  }
  const id = readString(record, "id");
  const transactionId = readString(record, "transactionId");
  const taskId = readString(record, "taskId");
  const hostTargetBranch = readString(record, "hostTargetBranch");
  const branchRef = readString(record, "branchRef");
  const candidateOid = readString(record, "candidateOid");
  const expectedBranchOid = readString(record, "expectedBranchOid");
  const publishTargetRef = readString(record, "publishTargetRef");
  const status = readString(record, "status");
  const createdAt = readString(record, "createdAt");
  const updatedAt = readString(record, "updatedAt");
  if (
    !id ||
    !transactionId ||
    !taskId ||
    !hostTargetBranch ||
    !branchRef ||
    !isGitOid(candidateOid) ||
    !isGitOid(expectedBranchOid) ||
    !publishTargetRef ||
    (status !== "pending" && status !== "succeeded") ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  const pendingReason = record.pendingReason;
  const projectedOid = readString(record, "projectedOid");
  if (projectedOid !== undefined && !isGitOid(projectedOid)) {
    return undefined;
  }
  const message = readString(record, "message");
  const worktreePath = readString(record, "worktreePath");
  const blockingPaths = readStringArray(record, "blockingPaths");
  const observedHostBranchOid = readString(record, "observedHostBranchOid");
  const expectedPublishBranchOid = readString(record, "expectedPublishBranchOid");
  const branchRelation = record.branchRelation;
  if (
    observedHostBranchOid !== undefined &&
    !isGitOid(observedHostBranchOid)
  ) {
    return undefined;
  }
  if (
    expectedPublishBranchOid !== undefined &&
    !isGitOid(expectedPublishBranchOid)
  ) {
    return undefined;
  }
  return {
    version: 1,
    id,
    transactionId,
    taskId,
    hostTargetBranch,
    branchRef,
    candidateOid,
    expectedBranchOid,
    publishTargetRef,
    status,
    createdAt,
    updatedAt,
    ...(isPendingReason(pendingReason) ? { pendingReason } : {}),
    ...(blockingPaths ? { blockingPaths } : {}),
    ...(observedHostBranchOid ? { observedHostBranchOid } : {}),
    ...(expectedPublishBranchOid ? { expectedPublishBranchOid } : {}),
    ...(isBranchRelation(branchRelation) ? { branchRelation } : {}),
    ...(message ? { message } : {}),
    ...(projectedOid ? { projectedOid } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  };
};

const readOutboxItem = (
  hubProjectDir: string,
  id: string,
): HubCheckoutOutboxItem | undefined => {
  const path = resolveOutboxItemPath(hubProjectDir, id);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return parseOutboxItem(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
};

const writeOutboxItem = (
  hubProjectDir: string,
  item: HubCheckoutOutboxItem,
): HubCheckoutOutboxItem => {
  writeAtomicJson(resolveOutboxItemPath(hubProjectDir, item.id), item);
  return item;
};

export const listHubCheckoutOutboxItems = (
  hubProjectDir: string,
): readonly HubCheckoutOutboxItem[] => {
  const dir = resolveHubCheckoutOutboxDir(hubProjectDir);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.includes(".tmp"))
    .flatMap((name) => {
      const id = name.slice(0, -".json".length);
      const parsed = readOutboxItem(hubProjectDir, id);
      return parsed ? [parsed] : [];
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
};

const hasBlockingPaths = (
  item: Pick<HubCheckoutOutboxItem, "blockingPaths">,
): boolean => (item.blockingPaths?.length ?? 0) > 0;

export const hasBranchDivergenceCheckoutPending = (
  items: readonly Pick<HubCheckoutOutboxItem, "status" | "pendingReason">[],
): boolean =>
  items.some(
    (item) =>
      item.status === "pending" && item.pendingReason === "branch_diverged",
  );

export const hubCheckoutSyncBranchEventFields = (
  source: Pick<
    HubCheckoutOutboxItem,
    "observedHostBranchOid" | "expectedPublishBranchOid" | "branchRelation"
  >,
): {
  readonly observedHostBranchOid?: string;
  readonly expectedPublishBranchOid?: string;
  readonly branchRelation?: HubCheckoutBranchRelation;
} => ({
  ...(source.observedHostBranchOid
    ? { observedHostBranchOid: source.observedHostBranchOid }
    : {}),
  ...(source.expectedPublishBranchOid
    ? { expectedPublishBranchOid: source.expectedPublishBranchOid }
    : {}),
  ...(source.branchRelation ? { branchRelation: source.branchRelation } : {}),
});

const resolveCheckoutNextAction = (
  items: readonly HubCheckoutOutboxItem[],
  pendingCount: number,
): string => {
  if (pendingCount === 0) {
    return "";
  }
  if (hasBranchDivergenceCheckoutPending(items)) {
    return branchDivergencePendingAction;
  }
  const hasDirtyPending = items.some(
    (item) => item.status === "pending" && hasBlockingPaths(item),
  );
  return hasDirtyPending ? dirtyPendingAction : pendingAction;
};

const branchStateClause = (item: HubCheckoutOutboxItem): string => {
  const parts: string[] = [];
  if (item.observedHostBranchOid) {
    parts.push(`observed host ${item.observedHostBranchOid}`);
  } else if (item.branchRelation === "missing") {
    parts.push("host branch ref is missing");
  }
  if (item.expectedPublishBranchOid) {
    parts.push(`publish target ${item.expectedPublishBranchOid}`);
  }
  if (item.branchRelation) {
    parts.push(`relation ${item.branchRelation}`);
  }
  return parts.length > 0 ? ` Branch state: ${parts.join(", ")}.` : "";
};

const pendingMessage = (item: HubCheckoutOutboxItem): string => {
  const reason = item.pendingReason ?? "unsafe_checkout";
  const paths = item.blockingPaths ?? [];
  const pathClause =
    paths.length > 0 ? ` Blocking host paths: ${paths.join(", ")}.` : "";
  if (reason === "branch_diverged") {
    return `Checkout sync pending for ${item.taskId} (branch_diverged): host branch ${item.hostTargetBranch} was not updated.${branchStateClause(item)} Landed candidate ${item.candidateOid} remains on the Hub publish target and the task can stay shipped. ${CHECKOUT_NO_HOST_MUTATION} Next steps: inspect both histories, reconcile them manually, then retry the run. ${NO_RECOVER_SUFFIX}`;
  }
  const recoveryClause =
    paths.length > 0
      ? " Next steps: commit or stash the listed paths, then retry the run."
      : "";
  return `Checkout sync pending for ${item.taskId} (${reason}): host branch ${item.hostTargetBranch} was not updated.${pathClause}${branchStateClause(item)} Landed candidate ${item.candidateOid} remains on the Hub publish target and the task can stay shipped.${recoveryClause} ${NO_RECOVER_SUFFIX}`;
};

const succeededMessage = (item: HubCheckoutOutboxItem): string =>
  `Checkout synced ${item.hostTargetBranch} to ${item.projectedOid ?? item.candidateOid}.`;

export const formatHubCheckoutSyncMessage = (
  inspection: Pick<HubCheckoutOutboxInspection, "pendingCount" | "items">,
): string => {
  if (inspection.pendingCount === 0) {
    return "";
  }
  const pending = inspection.items.find((item) => item.status === "pending");
  return pending
    ? pendingMessage(pending)
    : `Checkout sync pending for ${inspection.pendingCount} landed candidate(s). ${NO_RECOVER_SUFFIX}`;
};

export const inspectHubCheckoutOutbox = (input: {
  readonly hubProjectDir: string;
}): HubCheckoutOutboxInspection => {
  const items = listHubCheckoutOutboxItems(input.hubProjectDir);
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const succeededCount = items.filter(
    (item) => item.status === "succeeded",
  ).length;
  return {
    items,
    pendingCount,
    succeededCount,
    message: formatHubCheckoutSyncMessage({ items, pendingCount }),
    nextAction: resolveCheckoutNextAction(items, pendingCount),
  };
};

export const enqueueHubCheckoutProjection = (
  input: EnqueueHubCheckoutProjectionInput,
): HubCheckoutOutboxItem => {
  const hostTargetBranch = input.candidate.policy.hostTargetBranch;
  const candidateOid = input.candidateOid;
  const id = resolveHubCheckoutProjectionId({
    transactionId: input.candidate.transactionId,
    hostTargetBranch,
    candidateOid,
  });
  const existing = readOutboxItem(input.hubProjectDir, id);
  if (existing) {
    return existing;
  }
  const branchRef = branchRefFor(hostTargetBranch);
  const expectedBranchOid =
    tryGitTextSync(input.repoRoot, ["rev-parse", branchRef]) ??
    input.candidateOid;
  const now = (input.now ?? new Date()).toISOString();
  return writeOutboxItem(input.hubProjectDir, {
    version: 1,
    id,
    transactionId: input.candidate.transactionId,
    taskId: input.candidate.taskId,
    hostTargetBranch,
    branchRef,
    candidateOid,
    expectedBranchOid,
    publishTargetRef: input.candidate.policy.publishTargetRef,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
};

type GitWorktree = {
  readonly path: string;
  readonly branch: string | undefined;
};

const parseWorktreeList = (output: string): readonly GitWorktree[] => {
  const entries: GitWorktree[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | undefined;
  const flush = (): void => {
    if (currentPath) {
      entries.push({ path: currentPath, branch: currentBranch });
    }
    currentPath = undefined;
    currentBranch = undefined;
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length).trim();
    }
  }
  flush();
  return entries;
};

const isHubOwnedPath = (hubProjectDir: string, worktreePath: string): boolean => {
  const relativePath = relative(
    resolve(hubProjectDir),
    resolve(worktreePath),
  );
  return relativePath === "" || !relativePath.startsWith("..");
};

const listUserWorktrees = (
  repoRoot: string,
  hubProjectDir: string,
): readonly GitWorktree[] => {
  const output = tryGitTextSync(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!output) {
    return [
      {
        path: repoRoot,
        branch: tryGitTextSync(repoRoot, ["branch", "--show-current"]),
      },
    ];
  }
  return parseWorktreeList(output).filter(
    (entry) => !isHubOwnedPath(hubProjectDir, entry.path),
  );
};

const owningWorktrees = (
  worktrees: readonly GitWorktree[],
  hostTargetBranch: string,
): readonly GitWorktree[] =>
  worktrees.filter((entry) => entry.branch === hostTargetBranch);

const gitPathExists = (cwd: string, gitPath: string): boolean => {
  const resolved = tryGitTextSync(cwd, ["rev-parse", "--git-path", gitPath]);
  if (!resolved) {
    return false;
  }
  return existsSync(isAbsolute(resolved) ? resolved : join(cwd, resolved));
};

const OPERATION_HEAD_REFS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
] as const;

const OPERATION_GIT_PATHS = [
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
  "BISECT_START",
] as const;

const hasOperationInProgress = (cwd: string): boolean =>
  OPERATION_HEAD_REFS.some((ref) =>
    gitOkSync(cwd, ["rev-parse", "-q", "--verify", ref]),
  ) || OPERATION_GIT_PATHS.some((gitPath) => gitPathExists(cwd, gitPath));

const hasSparseCheckout = (cwd: string): boolean =>
  tryGitTextSync(cwd, ["config", "--bool", "core.sparseCheckout"]) === "true";

const treeHasGitlink = (cwd: string, treeish: string): boolean => {
  const staged = tryGitTextSync(cwd, ["ls-files", "-s"]) ?? "";
  if (staged.split("\n").some((line) => line.startsWith("160000 "))) {
    return true;
  }
  const tree = tryGitTextSync(cwd, ["ls-tree", "-r", treeish]) ?? "";
  return tree.split("\n").some((line) => line.startsWith("160000 "));
};

const isRenameOrCopyCode = (code: string): boolean =>
  code === "R" || code === "C";

const isRenameCopyOrDeleteCode = (code: string): boolean =>
  isRenameOrCopyCode(code) || code === "D";

type PorcelainEntry = {
  readonly x: string;
  readonly y: string;
  readonly paths: readonly string[];
};

const parsePorcelainZ = (status: string): readonly PorcelainEntry[] => {
  const fields = status.split("\0").filter((field) => field.length > 0);
  const entries: PorcelainEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) {
      continue;
    }
    const x = field[0] ?? " ";
    const y = field[1] ?? " ";
    const path = field.slice(3);
    const paths = path.length > 0 ? [path] : [];
    // Delete records are a single path. Only rename/copy consume the extra
    // NUL field, matching hubBatchMerge / hubTaskStateDoctor parsers.
    if (isRenameOrCopyCode(x) || isRenameOrCopyCode(y)) {
      index += 1;
      const renamedPath = fields[index];
      if (renamedPath && renamedPath.length > 0) {
        paths.push(renamedPath);
      }
    }
    entries.push({ x, y, paths });
  }
  return entries;
};

const uniquePaths = (entries: readonly PorcelainEntry[]): readonly string[] => {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of entries) {
    for (const path of entry.paths) {
      if (!seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
};

const classifyPorcelain = (
  entries: readonly PorcelainEntry[],
): HubCheckoutPendingReason | undefined => {
  if (entries.length === 0) {
    return undefined;
  }
  for (const entry of entries) {
    if (isRenameCopyOrDeleteCode(entry.x) || isRenameCopyOrDeleteCode(entry.y)) {
      return "rename_or_delete";
    }
  }
  if (entries.some((entry) => entry.x === "?" || entry.y === "?" || entry.x === "!")) {
    return "untracked_paths";
  }
  if (entries.some((entry) => entry.x !== " " && entry.x !== "?")) {
    return "staged_changes";
  }
  return "unstaged_changes";
};

type CheckoutSafetyHold = {
  readonly pendingReason: HubCheckoutPendingReason;
  readonly blockingPaths?: readonly string[];
  readonly observedHostBranchOid?: string;
  readonly expectedPublishBranchOid?: string;
  readonly branchRelation?: HubCheckoutBranchRelation;
};

const inspectOwningWorktreeSafety = (
  cwd: string,
  candidateOid: string,
): CheckoutSafetyHold | undefined => {
  if (hasOperationInProgress(cwd)) {
    return { pendingReason: "operation_in_progress" };
  }
  if (hasSparseCheckout(cwd)) {
    return { pendingReason: "sparse_checkout" };
  }
  if (treeHasGitlink(cwd, candidateOid)) {
    return { pendingReason: "submodule" };
  }
  const status =
    tryGitPorcelainZSync(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]) ?? "";
  const entries = parsePorcelainZ(status);
  const pendingReason = classifyPorcelain(entries);
  if (!pendingReason) {
    return undefined;
  }
  const blockingPaths = uniquePaths(entries);
  return {
    pendingReason,
    ...(blockingPaths.length > 0 ? { blockingPaths } : {}),
  };
};

const isAncestor = (
  repoRoot: string,
  ancestorOid: string,
  descendantOid: string,
): boolean =>
  ancestorOid === descendantOid ||
  gitOkSync(repoRoot, [
    "merge-base",
    "--is-ancestor",
    ancestorOid,
    descendantOid,
  ]);

export const classifyHostPublishBranchRelation = (
  repoRoot: string,
  hostOid: string | undefined,
  publishOid: string,
): HubCheckoutBranchRelation => {
  if (hostOid === undefined) {
    return "missing";
  }
  if (hostOid === publishOid) {
    return "behind";
  }
  const hostIsBehindPublish = isAncestor(repoRoot, hostOid, publishOid);
  const hostIsAheadOfPublish = isAncestor(repoRoot, publishOid, hostOid);
  if (hostIsBehindPublish && !hostIsAheadOfPublish) {
    return "behind";
  }
  if (hostIsAheadOfPublish && !hostIsBehindPublish) {
    return "ahead";
  }
  return "diverged";
};

const resolvePublishBranchOid = (
  repoRoot: string,
  publishTargetRef: string,
): string | undefined =>
  tryGitTextSync(repoRoot, ["rev-parse", publishTargetRef]);

const buildBranchDiagnostics = (
  repoRoot: string,
  item: HubCheckoutOutboxItem,
  hostOid: string | undefined,
): Pick<
  CheckoutSafetyHold,
  "observedHostBranchOid" | "expectedPublishBranchOid" | "branchRelation"
> => {
  const expectedPublishBranchOid =
    resolvePublishBranchOid(repoRoot, item.publishTargetRef) ??
    item.candidateOid;
  return {
    ...(hostOid ? { observedHostBranchOid: hostOid } : {}),
    expectedPublishBranchOid,
    branchRelation: classifyHostPublishBranchRelation(
      repoRoot,
      hostOid,
      expectedPublishBranchOid,
    ),
  };
};

const withBranchDiagnostics = (
  repoRoot: string,
  item: HubCheckoutOutboxItem,
  hostOid: string | undefined,
  hold: CheckoutSafetyHold,
): CheckoutSafetyHold => ({
  ...hold,
  ...buildBranchDiagnostics(repoRoot, item, hostOid),
});

const markSucceeded = (
  hubProjectDir: string,
  item: HubCheckoutOutboxItem,
  input: {
    readonly projectedOid: string;
    readonly worktreePath?: string;
    readonly now: string;
  },
): HubCheckoutOutboxItem =>
  writeOutboxItem(hubProjectDir, {
    ...item,
    status: "succeeded",
    updatedAt: input.now,
    projectedOid: input.projectedOid,
    pendingReason: undefined,
    blockingPaths: undefined,
    observedHostBranchOid: undefined,
    expectedPublishBranchOid: undefined,
    branchRelation: undefined,
    message: undefined,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
  });

const markPending = (
  hubProjectDir: string,
  item: HubCheckoutOutboxItem,
  now: string,
  hold: CheckoutSafetyHold,
): HubCheckoutOutboxItem => {
  const next: HubCheckoutOutboxItem = {
    ...item,
    status: "pending",
    pendingReason: hold.pendingReason,
    updatedAt: now,
    blockingPaths: hasBlockingPaths(hold) ? hold.blockingPaths : undefined,
    ...hubCheckoutSyncBranchEventFields(hold),
  };
  return writeOutboxItem(hubProjectDir, {
    ...next,
    message: pendingMessage(next),
  });
};

const maybeCrash = (
  fault: HubLandingFaultInjection | undefined,
  timing: "before" | "after",
): void => {
  const injected =
    timing === "before" ? fault?.crashBefore : fault?.crashAfter;
  if (injected === "checkout_projection") {
    throw new HubLandingCrash("checkout_projection", timing);
  }
};

const currentBranchOid = (
  repoRoot: string,
  branchRef: string,
): string | undefined => tryGitTextSync(repoRoot, ["rev-parse", branchRef]);

const hostBranchAlreadyContainsCandidate = (
  repoRoot: string,
  candidateOid: string,
  currentOid: string | undefined,
): currentOid is string =>
  currentOid !== undefined &&
  isAncestor(repoRoot, candidateOid, currentOid);

const candidateIsFastForwardOf = (
  repoRoot: string,
  candidateOid: string,
  currentOid: string | undefined,
): currentOid is string =>
  currentOid !== undefined &&
  isAncestor(repoRoot, currentOid, candidateOid);

const casFailureReason = (
  repoRoot: string,
  candidateOid: string,
  observedOid: string | undefined,
): HubCheckoutPendingReason => {
  if (
    observedOid !== undefined &&
    !isAncestor(repoRoot, observedOid, candidateOid)
  ) {
    return "branch_diverged";
  }
  return "operation_in_progress";
};

const attemptCas = async (
  repoRoot: string,
  hubProjectDir: string,
  item: HubCheckoutOutboxItem,
  currentOid: string,
): Promise<void> => {
  await gitTextAsync(
    repoRoot,
    hooklessArgs(hubProjectDir, [
      "update-ref",
      item.branchRef,
      item.candidateOid,
      currentOid,
    ]),
  );
};

const attemptFastForward = async (
  worktreePath: string,
  hubProjectDir: string,
  candidateOid: string,
): Promise<void> => {
  await gitTextAsync(
    worktreePath,
    hooklessArgs(hubProjectDir, [
      "merge",
      "--ff-only",
      "--no-stat",
      "--no-edit",
      "-q",
      candidateOid,
    ]),
  );
};

const advanceHostBranchWithCrashWindows = async (input: {
  readonly projection: ProjectHubCheckoutOutboxInput;
  readonly item: HubCheckoutOutboxItem;
  readonly now: string;
  readonly mutate: () => Promise<void>;
  readonly pendingAfterFailure: (
    observedOid: string | undefined,
  ) => CheckoutSafetyHold;
  readonly diagnosticHostOidFallback?: string;
  readonly worktreePath?: string;
}): Promise<HubCheckoutOutboxItem> => {
  const { projection, item, now } = input;
  const succeeded = (projectedOid: string): HubCheckoutOutboxItem =>
    markSucceeded(projection.hubProjectDir, item, {
      projectedOid,
      now,
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    });

  maybeCrash(projection.faultInjection, "before");
  try {
    await input.mutate();
  } catch {
    const observedOid = currentBranchOid(projection.repoRoot, item.branchRef);
    if (
      hostBranchAlreadyContainsCandidate(
        projection.repoRoot,
        item.candidateOid,
        observedOid,
      )
    ) {
      maybeCrash(projection.faultInjection, "after");
      return succeeded(observedOid);
    }
    const hold = input.pendingAfterFailure(observedOid);
    const diagnosticHostOid = observedOid ?? input.diagnosticHostOidFallback;
    return markPending(
      projection.hubProjectDir,
      item,
      now,
      withBranchDiagnostics(
        projection.repoRoot,
        item,
        diagnosticHostOid,
        hold,
      ),
    );
  }
  maybeCrash(projection.faultInjection, "after");
  return succeeded(item.candidateOid);
};

const projectOneItem = async (
  input: ProjectHubCheckoutOutboxInput,
  item: HubCheckoutOutboxItem,
  now: string,
): Promise<HubCheckoutOutboxItem> => {
  if (item.status === "succeeded") {
    return item;
  }
  const currentOid = currentBranchOid(input.repoRoot, item.branchRef);
  if (
    hostBranchAlreadyContainsCandidate(
      input.repoRoot,
      item.candidateOid,
      currentOid,
    )
  ) {
    return markSucceeded(input.hubProjectDir, item, {
      projectedOid: currentOid,
      now,
    });
  }
  if (
    !candidateIsFastForwardOf(input.repoRoot, item.candidateOid, currentOid)
  ) {
    return markPending(
      input.hubProjectDir,
      item,
      now,
      withBranchDiagnostics(input.repoRoot, item, currentOid, {
        pendingReason: "branch_diverged",
      }),
    );
  }

  const worktrees = listUserWorktrees(input.repoRoot, input.hubProjectDir);
  const owners = owningWorktrees(worktrees, item.hostTargetBranch);
  if (owners.length > 1) {
    return markPending(
      input.hubProjectDir,
      item,
      now,
      withBranchDiagnostics(input.repoRoot, item, currentOid, {
        pendingReason: "multiple_worktrees",
      }),
    );
  }
  if (owners.length === 0) {
    return advanceHostBranchWithCrashWindows({
      projection: input,
      item,
      now,
      mutate: () =>
        attemptCas(input.repoRoot, input.hubProjectDir, item, currentOid),
      pendingAfterFailure: (observedOid) => ({
        pendingReason: casFailureReason(
          input.repoRoot,
          item.candidateOid,
          observedOid,
        ),
      }),
    });
  }

  const owner = owners[0]!;
  const unsafe = inspectOwningWorktreeSafety(owner.path, item.candidateOid);
  if (unsafe) {
    return markPending(
      input.hubProjectDir,
      item,
      now,
      withBranchDiagnostics(input.repoRoot, item, currentOid, unsafe),
    );
  }
  return advanceHostBranchWithCrashWindows({
    projection: input,
    item,
    now,
    mutate: () =>
      attemptFastForward(owner.path, input.hubProjectDir, item.candidateOid),
    pendingAfterFailure: () =>
      inspectOwningWorktreeSafety(owner.path, item.candidateOid) ?? {
        pendingReason: "operation_in_progress",
      },
    diagnosticHostOidFallback: currentOid,
    worktreePath: owner.path,
  });
};

const attemptMessage = (item: HubCheckoutOutboxItem): string => {
  if (item.status === "succeeded") {
    return succeededMessage(item);
  }
  return pendingMessage(item);
};

const toAttempt = (
  item: HubCheckoutOutboxItem,
): HubCheckoutProjectionAttempt => ({
  item,
  status: item.status,
  ...(item.pendingReason ? { pendingReason: item.pendingReason } : {}),
  ...(item.blockingPaths ? { blockingPaths: item.blockingPaths } : {}),
  ...hubCheckoutSyncBranchEventFields(item),
  message: attemptMessage(item),
});

export const projectHubCheckoutOutbox = async (
  input: ProjectHubCheckoutOutboxInput,
): Promise<HubCheckoutProjectionOutcome> => {
  const now = (input.now ?? new Date()).toISOString();
  const items = listHubCheckoutOutboxItems(input.hubProjectDir);
  const attempts: HubCheckoutProjectionAttempt[] = [];
  for (const item of items) {
    const projected = await projectOneItem(input, item, now);
    attempts.push(toAttempt(projected));
  }
  const pendingCount = attempts.filter(
    (attempt) => attempt.status === "pending",
  ).length;
  const succeededCount = attempts.filter(
    (attempt) => attempt.status === "succeeded",
  ).length;
  return {
    attempts,
    pendingCount,
    succeededCount,
    message: formatHubCheckoutSyncMessage({
      pendingCount,
      items: attempts.map((attempt) => attempt.item),
    }),
  };
};

export const hubCheckoutSyncEventType = (
  status: HubCheckoutProjectionStatus,
): "checkout_sync_pending" | "checkout_sync_succeeded" => {
  if (status === "succeeded") {
    return "checkout_sync_succeeded";
  }
  return HUB_CHECKOUT_SYNC_PENDING;
};

export const hubCheckoutSyncEventReason = (
  attempt: Pick<HubCheckoutProjectionAttempt, "status" | "pendingReason">,
): string | undefined => {
  if (attempt.status !== "pending") {
    return undefined;
  }
  return attempt.pendingReason ?? HUB_CHECKOUT_SYNC_PENDING;
};

const shouldEmitCheckoutProjectionEvent = (
  before: HubCheckoutOutboxInspection,
  attempt: HubCheckoutProjectionAttempt,
): boolean => {
  if (attempt.status === "pending") {
    return true;
  }
  const prior = before.items.find((item) => item.id === attempt.item.id);
  return prior?.status !== "succeeded";
};

export const selectHubCheckoutProjectionEventDeltas = (
  before: HubCheckoutOutboxInspection,
  outcome: HubCheckoutProjectionOutcome,
): readonly HubCheckoutProjectionAttempt[] =>
  outcome.attempts.filter((attempt) =>
    shouldEmitCheckoutProjectionEvent(before, attempt),
  );

export const syncHubCheckoutProjections = async (
  input: ProjectHubCheckoutOutboxInput,
): Promise<
  HubCheckoutProjectionOutcome & {
    readonly deltas: readonly HubCheckoutProjectionAttempt[];
  }
> => {
  const before = inspectHubCheckoutOutbox({
    hubProjectDir: input.hubProjectDir,
  });
  const outcome = await projectHubCheckoutOutbox(input);
  return {
    ...outcome,
    deltas: selectHubCheckoutProjectionEventDeltas(before, outcome),
  };
};
