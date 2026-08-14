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

const pendingAction =
  "Wait for the automatic retry; Hub will fast-forward the host branch when Git can prove the checkout safe.";

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});

const gitTextSync = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(),
  }).trim();

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

const pendingMessage = (item: HubCheckoutOutboxItem): string => {
  const reason = item.pendingReason ?? "unsafe_checkout";
  return `Checkout sync pending for ${item.taskId} (${reason}): host branch ${item.hostTargetBranch} was not updated. Landed candidate ${item.candidateOid} remains on the Hub publish target and the task can stay shipped. ${NO_RECOVER_SUFFIX}`;
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
    nextAction: pendingCount > 0 ? pendingAction : "",
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

const isRenameCopyOrDeleteCode = (code: string): boolean =>
  code === "R" || code === "C" || code === "D";

const classifyPorcelain = (
  status: string,
): HubCheckoutPendingReason | undefined => {
  const lines = status.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  for (const line of lines) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    if (isRenameCopyOrDeleteCode(x) || isRenameCopyOrDeleteCode(y)) {
      return "rename_or_delete";
    }
  }
  if (lines.some((line) => line.startsWith("??") || line.startsWith("!!"))) {
    return "untracked_paths";
  }
  if (
    lines.some((line) => {
      const x = line[0] ?? " ";
      return x !== " " && x !== "?";
    })
  ) {
    return "staged_changes";
  }
  return "unstaged_changes";
};

const inspectOwningWorktreeSafety = (
  cwd: string,
  candidateOid: string,
): HubCheckoutPendingReason | undefined => {
  if (hasOperationInProgress(cwd)) {
    return "operation_in_progress";
  }
  if (hasSparseCheckout(cwd)) {
    return "sparse_checkout";
  }
  if (treeHasGitlink(cwd, candidateOid)) {
    return "submodule";
  }
  const status = tryGitTextSync(cwd, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return classifyPorcelain(status ?? "");
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
    message: undefined,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
  });

const markPending = (
  hubProjectDir: string,
  item: HubCheckoutOutboxItem,
  reason: HubCheckoutPendingReason,
  now: string,
): HubCheckoutOutboxItem => {
  const next: HubCheckoutOutboxItem = {
    ...item,
    status: "pending",
    pendingReason: reason,
    updatedAt: now,
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
  readonly pendingReasonAfterFailure: (
    observedOid: string | undefined,
  ) => HubCheckoutPendingReason;
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
    return markPending(
      projection.hubProjectDir,
      item,
      input.pendingReasonAfterFailure(observedOid),
      now,
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
    return markPending(input.hubProjectDir, item, "branch_diverged", now);
  }

  const worktrees = listUserWorktrees(input.repoRoot, input.hubProjectDir);
  const owners = owningWorktrees(worktrees, item.hostTargetBranch);
  if (owners.length > 1) {
    return markPending(input.hubProjectDir, item, "multiple_worktrees", now);
  }
  if (owners.length === 0) {
    return advanceHostBranchWithCrashWindows({
      projection: input,
      item,
      now,
      mutate: () =>
        attemptCas(input.repoRoot, input.hubProjectDir, item, currentOid),
      pendingReasonAfterFailure: (observedOid) =>
        casFailureReason(input.repoRoot, item.candidateOid, observedOid),
    });
  }

  const owner = owners[0]!;
  const unsafe = inspectOwningWorktreeSafety(owner.path, item.candidateOid);
  if (unsafe) {
    return markPending(input.hubProjectDir, item, unsafe, now);
  }
  return advanceHostBranchWithCrashWindows({
    projection: input,
    item,
    now,
    mutate: () =>
      attemptFastForward(owner.path, input.hubProjectDir, item.candidateOid),
    pendingReasonAfterFailure: () =>
      inspectOwningWorktreeSafety(owner.path, item.candidateOid) ??
      "operation_in_progress",
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
