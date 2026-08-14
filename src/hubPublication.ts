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
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  HubLandingCrash,
  type HubLandingCandidate,
  type HubLandingFaultInjection,
} from "./hubLanding.js";
import type { HubLandingPolicy } from "./hubLandingPolicy.js";
import { readHubLandingPolicy } from "./hubLandingPolicy.js";
import { isGitOid } from "./hubLandingTransaction.js";

const execFileAsync = promisify(execFile);

export const HUB_TARGET_PUBLISH_PENDING = "target_publish_pending";

export const HUB_PUBLICATION_PENDING_REASONS = [
  "network_error",
  "credential_rejected",
  "protected_branch",
  "remote_diverged",
  "no_remote_configured",
  "transient_remote_error",
  "observe_failed",
] as const;

export type HubPublicationPendingReason =
  (typeof HUB_PUBLICATION_PENDING_REASONS)[number];

export type HubPublicationStatus = "pending" | "succeeded";

export const GIT_ZERO_OID = "0".repeat(40);

export interface HubPublicationRemoteTarget {
  readonly remoteName: string;
  readonly branchName: string;
  readonly remoteRef: string;
  readonly remoteTarget: string;
}

export interface HubPublicationOutboxItem {
  readonly version: 1;
  readonly id: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly remoteName: string;
  readonly remoteRef: string;
  readonly remoteTarget: string;
  readonly candidateOid: string;
  readonly expectedRemoteOid: string;
  readonly publishTargetRef: string;
  readonly status: HubPublicationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pendingReason?: HubPublicationPendingReason;
  readonly message?: string;
  readonly publishedOid?: string;
}

export interface HubPublicationOutboxInspection {
  readonly items: readonly HubPublicationOutboxItem[];
  readonly pendingCount: number;
  readonly succeededCount: number;
  readonly message: string;
  readonly nextAction: string;
}

export interface HubPublicationAttempt {
  readonly item: HubPublicationOutboxItem;
  readonly status: HubPublicationStatus;
  readonly pendingReason?: HubPublicationPendingReason;
  readonly message: string;
}

export interface HubPublicationOutcome {
  readonly attempts: readonly HubPublicationAttempt[];
  readonly pendingCount: number;
  readonly succeededCount: number;
  readonly message: string;
}

export interface EnqueueHubPublicationInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly candidate: Pick<
    HubLandingCandidate,
    "transactionId" | "taskId" | "policy"
  >;
  readonly candidateOid: string;
  readonly now?: Date;
}

export interface ProjectHubPublicationOutboxInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
}

const NO_RECOVER_SUFFIX =
  "This is not a task failure and does not require a recovery command.";

const pendingAction =
  "Wait for the automatic retry; Hub will publish the candidate when the configured remote accepts the exact expected-ref update.";

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_ASKPASS: "echo",
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

const gitExecCapture = async (
  cwd: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
    });
    return {
      ok: true,
      stdout: String(stdout).trim(),
      stderr: String(stderr ?? "").trim(),
    };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      ok: false,
      stdout: String(err.stdout ?? "").trim(),
      stderr: String(err.stderr ?? err.message ?? "").trim(),
    };
  }
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

const isPendingReason = (
  value: unknown,
): value is HubPublicationPendingReason =>
  typeof value === "string" &&
  (HUB_PUBLICATION_PENDING_REASONS as readonly string[]).includes(value);

export const resolveHubPublicationOutboxDir = (hubProjectDir: string): string =>
  join(hubProjectDir, "landing", "publication-outbox");

export const parseHubPublicationRemoteTarget = (
  remoteTarget: string,
): HubPublicationRemoteTarget | undefined => {
  const trimmed = remoteTarget.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  const remoteName = trimmed.slice(0, slash);
  const branchName = trimmed.slice(slash + 1);
  if (!remoteName || !branchName) {
    return undefined;
  }
  const remoteRef = branchName.startsWith("refs/")
    ? branchName
    : `refs/heads/${branchName}`;
  return {
    remoteName,
    branchName,
    remoteRef,
    remoteTarget: trimmed,
  };
};

export const resolveHubPublicationId = (input: {
  readonly transactionId: string;
  readonly remoteName: string;
  readonly remoteRef: string;
  readonly candidateOid: string;
  readonly expectedRemoteOid: string;
}): string => {
  const digest = createHash("sha256")
    .update(
      `${input.transactionId}\0${input.remoteName}\0${input.remoteRef}\0${input.candidateOid}\0${input.expectedRemoteOid}`,
    )
    .digest("hex")
    .slice(0, 16);
  return `pub-${digest}`;
};

const resolveOutboxItemPath = (hubProjectDir: string, id: string): string =>
  join(resolveHubPublicationOutboxDir(hubProjectDir), `${id}.json`);

const parseOutboxItem = (
  value: unknown,
): HubPublicationOutboxItem | undefined => {
  const record = readObject(value);
  if (record.version !== 1) {
    return undefined;
  }
  const id = readString(record, "id");
  const transactionId = readString(record, "transactionId");
  const taskId = readString(record, "taskId");
  const remoteName = readString(record, "remoteName");
  const remoteRef = readString(record, "remoteRef");
  const remoteTarget = readString(record, "remoteTarget");
  const candidateOid = readString(record, "candidateOid");
  const expectedRemoteOid = readString(record, "expectedRemoteOid");
  const publishTargetRef = readString(record, "publishTargetRef");
  const status = readString(record, "status");
  const createdAt = readString(record, "createdAt");
  const updatedAt = readString(record, "updatedAt");
  if (
    !id ||
    !transactionId ||
    !taskId ||
    !remoteName ||
    !remoteRef ||
    !remoteTarget ||
    !isGitOid(candidateOid) ||
    !isGitOid(expectedRemoteOid) ||
    !publishTargetRef ||
    (status !== "pending" && status !== "succeeded") ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  const pendingReason = record.pendingReason;
  const publishedOid = readString(record, "publishedOid");
  if (publishedOid !== undefined && !isGitOid(publishedOid)) {
    return undefined;
  }
  const message = readString(record, "message");
  return {
    version: 1,
    id,
    transactionId,
    taskId,
    remoteName,
    remoteRef,
    remoteTarget,
    candidateOid,
    expectedRemoteOid,
    publishTargetRef,
    status,
    createdAt,
    updatedAt,
    ...(isPendingReason(pendingReason) ? { pendingReason } : {}),
    ...(message ? { message } : {}),
    ...(publishedOid ? { publishedOid } : {}),
  };
};

const readOutboxItem = (
  hubProjectDir: string,
  id: string,
): HubPublicationOutboxItem | undefined => {
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
  item: HubPublicationOutboxItem,
): HubPublicationOutboxItem => {
  writeAtomicJson(resolveOutboxItemPath(hubProjectDir, item.id), item);
  return item;
};

export const listHubPublicationOutboxItems = (
  hubProjectDir: string,
): readonly HubPublicationOutboxItem[] => {
  const dir = resolveHubPublicationOutboxDir(hubProjectDir);
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

const pendingMessage = (item: HubPublicationOutboxItem): string => {
  const reason = item.pendingReason ?? "transient_remote_error";
  return `Code publication pending for ${item.taskId} (${reason}): remote ${item.remoteTarget} expected ${item.expectedRemoteOid}, candidate ${item.candidateOid}. Local shipped proof is unchanged and is separate from GitHub task sync. ${NO_RECOVER_SUFFIX}`;
};

const succeededMessage = (item: HubPublicationOutboxItem): string =>
  `Code published ${item.remoteTarget} to ${item.publishedOid ?? item.candidateOid}.`;

export const formatHubPublicationMessage = (
  inspection: Pick<HubPublicationOutboxInspection, "pendingCount" | "items">,
): string => {
  if (inspection.pendingCount === 0) {
    return "";
  }
  const pending = inspection.items.find((item) => item.status === "pending");
  return pending
    ? pendingMessage(pending)
    : `Code publication pending for ${inspection.pendingCount} shipped candidate(s). ${NO_RECOVER_SUFFIX}`;
};

export const inspectHubPublicationOutbox = (input: {
  readonly hubProjectDir: string;
}): HubPublicationOutboxInspection => {
  const items = listHubPublicationOutboxItems(input.hubProjectDir);
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const succeededCount = items.filter(
    (item) => item.status === "succeeded",
  ).length;
  return {
    items,
    pendingCount,
    succeededCount,
    message: formatHubPublicationMessage({ items, pendingCount }),
    nextAction: pendingCount > 0 ? pendingAction : "",
  };
};

const observeRemoteTip = async (
  repoRoot: string,
  remoteName: string,
  remoteRef: string,
): Promise<
  | { readonly kind: "ok"; readonly tip: string | undefined }
  | { readonly kind: "error"; readonly reason: HubPublicationPendingReason }
> => {
  const observed = await gitExecCapture(repoRoot, [
    "ls-remote",
    remoteName,
    remoteRef,
  ]);
  if (!observed.ok) {
    return {
      kind: "error",
      reason: classifyRemoteFailure(observed.stderr),
    };
  }
  const line = observed.stdout.split("\n").find((entry) => entry.trim());
  if (!line) {
    return { kind: "ok", tip: undefined };
  }
  const oid = line.split(/[\s\t]/)[0]?.trim();
  if (!isGitOid(oid)) {
    return { kind: "error", reason: "observe_failed" };
  }
  return { kind: "ok", tip: oid };
};

const observeRemoteTipSync = (
  repoRoot: string,
  remoteName: string,
  remoteRef: string,
): string | undefined => {
  const output = tryGitTextSync(repoRoot, [
    "ls-remote",
    remoteName,
    remoteRef,
  ]);
  if (output === undefined) {
    return undefined;
  }
  const line = output.split("\n").find((entry) => entry.trim());
  if (!line) {
    return undefined;
  }
  const oid = line.split(/[\s\t]/)[0]?.trim();
  return isGitOid(oid) ? oid : undefined;
};

export const classifyRemoteFailure = (
  stderr: string,
): HubPublicationPendingReason => {
  const text = stderr.toLowerCase();
  if (
    text.includes("could not resolve host") ||
    text.includes("failed to connect") ||
    text.includes("unable to access") ||
    text.includes("network is unreachable") ||
    text.includes("connection refused") ||
    text.includes("timed out") ||
    text.includes("temporary failure")
  ) {
    return "network_error";
  }
  if (
    text.includes("authentication failed") ||
    text.includes("invalid username") ||
    text.includes("permission denied") ||
    text.includes("access denied") ||
    text.includes("could not read username") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("terminal prompts disabled")
  ) {
    return "credential_rejected";
  }
  if (
    text.includes("protected branch") ||
    text.includes("protected ref") ||
    text.includes("gh-hook") ||
    text.includes("pre-receive hook declined") ||
    text.includes("hook declined")
  ) {
    return "protected_branch";
  }
  if (
    text.includes("failed to push some refs") ||
    text.includes("non-fast-forward") ||
    text.includes("stale info") ||
    text.includes("cannot lock ref") ||
    text.includes("fetch first")
  ) {
    return "remote_diverged";
  }
  return "transient_remote_error";
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

const remoteContainsCandidate = (
  repoRoot: string,
  candidateOid: string,
  tip: string | undefined,
): tip is string =>
  tip !== undefined && isAncestor(repoRoot, candidateOid, tip);

const candidateIsFastForwardOf = (
  repoRoot: string,
  candidateOid: string,
  tip: string | undefined,
): tip is string =>
  tip !== undefined && isAncestor(repoRoot, tip, candidateOid);

const markSucceeded = (
  hubProjectDir: string,
  item: HubPublicationOutboxItem,
  input: {
    readonly publishedOid: string;
    readonly now: string;
  },
): HubPublicationOutboxItem =>
  writeOutboxItem(hubProjectDir, {
    ...item,
    status: "succeeded",
    updatedAt: input.now,
    publishedOid: input.publishedOid,
    pendingReason: undefined,
    message: undefined,
  });

const markPending = (
  hubProjectDir: string,
  item: HubPublicationOutboxItem,
  reason: HubPublicationPendingReason,
  now: string,
): HubPublicationOutboxItem => {
  const next: HubPublicationOutboxItem = {
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
  if (injected === "publication") {
    throw new HubLandingCrash("publication", timing);
  }
};

const shouldEnqueuePublication = (policy: HubLandingPolicy): boolean =>
  policy.publishPolicy === "best_effort";

/**
 * Enqueues best-effort remote publication after local shipped proof.
 * Publication off and required (out of scope here) do not enqueue.
 * Discovering `origin` alone never enables publication — only an explicit
 * Hub policy remoteTarget under best_effort does.
 */
export const enqueueHubPublicationAfterShipped = (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly candidateOid: string;
  readonly policy?: HubLandingPolicy;
  readonly now?: Date;
}): HubPublicationOutboxItem | undefined => {
  const policy =
    input.policy ?? readHubLandingPolicy(input.hubProjectDir);
  if (!policy) {
    return undefined;
  }
  return enqueueHubPublication({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
    candidate: {
      transactionId: input.transactionId,
      taskId: input.taskId,
      policy,
    },
    candidateOid: input.candidateOid,
    now: input.now,
  });
};

export const enqueueHubPublication = (
  input: EnqueueHubPublicationInput,
): HubPublicationOutboxItem | undefined => {
  if (!shouldEnqueuePublication(input.candidate.policy)) {
    return undefined;
  }
  const remoteTargetValue = input.candidate.policy.remoteTarget;
  const now = (input.now ?? new Date()).toISOString();
  if (!remoteTargetValue) {
    const id = resolveHubPublicationId({
      transactionId: input.candidate.transactionId,
      remoteName: "(unset)",
      remoteRef: "(unset)",
      candidateOid: input.candidateOid,
      expectedRemoteOid: GIT_ZERO_OID,
    });
    const existing = readOutboxItem(input.hubProjectDir, id);
    if (existing) {
      return existing;
    }
    const draft: HubPublicationOutboxItem = {
      version: 1,
      id,
      transactionId: input.candidate.transactionId,
      taskId: input.candidate.taskId,
      remoteName: "(unset)",
      remoteRef: "(unset)",
      remoteTarget: "(unset)",
      candidateOid: input.candidateOid,
      expectedRemoteOid: GIT_ZERO_OID,
      publishTargetRef: input.candidate.policy.publishTargetRef,
      status: "pending",
      pendingReason: "no_remote_configured",
      createdAt: now,
      updatedAt: now,
    };
    return writeOutboxItem(input.hubProjectDir, {
      ...draft,
      message: pendingMessage(draft),
    });
  }

  const parsed = parseHubPublicationRemoteTarget(remoteTargetValue);
  if (!parsed) {
    return undefined;
  }

  const observedTip = observeRemoteTipSync(
    input.repoRoot,
    parsed.remoteName,
    parsed.remoteRef,
  );
  const expectedRemoteOid = observedTip ?? GIT_ZERO_OID;
  const id = resolveHubPublicationId({
    transactionId: input.candidate.transactionId,
    remoteName: parsed.remoteName,
    remoteRef: parsed.remoteRef,
    candidateOid: input.candidateOid,
    expectedRemoteOid,
  });
  const existing = readOutboxItem(input.hubProjectDir, id);
  if (existing) {
    return existing;
  }
  // Prefer an already-pending item for the same transaction/remote/ref/candidate
  // so restart does not create a second key when the remote tip moved.
  const sibling = listHubPublicationOutboxItems(input.hubProjectDir).find(
    (item) =>
      item.transactionId === input.candidate.transactionId &&
      item.remoteName === parsed.remoteName &&
      item.remoteRef === parsed.remoteRef &&
      item.candidateOid === input.candidateOid,
  );
  if (sibling) {
    return sibling;
  }

  return writeOutboxItem(input.hubProjectDir, {
    version: 1,
    id,
    transactionId: input.candidate.transactionId,
    taskId: input.candidate.taskId,
    remoteName: parsed.remoteName,
    remoteRef: parsed.remoteRef,
    remoteTarget: parsed.remoteTarget,
    candidateOid: input.candidateOid,
    expectedRemoteOid,
    publishTargetRef: input.candidate.policy.publishTargetRef,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
};

const pushCandidate = async (
  repoRoot: string,
  item: HubPublicationOutboxItem,
  expectedRemoteOid: string,
): Promise<{ readonly ok: boolean; readonly stderr: string }> => {
  const args =
    expectedRemoteOid === GIT_ZERO_OID
      ? [
          "push",
          item.remoteName,
          `${item.candidateOid}:${item.remoteRef}`,
        ]
      : [
          "push",
          `--force-with-lease=${item.remoteRef}:${expectedRemoteOid}`,
          item.remoteName,
          `${item.candidateOid}:${item.remoteRef}`,
        ];
  const result = await gitExecCapture(repoRoot, args);
  return { ok: result.ok, stderr: result.stderr };
};

const ensureCandidateObjectFetched = async (
  repoRoot: string,
  item: HubPublicationOutboxItem,
  tip: string,
): Promise<void> => {
  if (gitOkSync(repoRoot, ["cat-file", "-e", `${tip}^{commit}`])) {
    return;
  }
  await gitExecCapture(repoRoot, [
    "fetch",
    "--no-tags",
    item.remoteName,
    item.remoteRef,
  ]);
};

const projectOneItem = async (
  input: ProjectHubPublicationOutboxInput,
  item: HubPublicationOutboxItem,
  now: string,
): Promise<HubPublicationOutboxItem> => {
  if (item.status === "succeeded") {
    return item;
  }
  if (
    item.pendingReason === "no_remote_configured" ||
    item.remoteName === "(unset)"
  ) {
    return markPending(
      input.hubProjectDir,
      item,
      "no_remote_configured",
      now,
    );
  }

  const observed = await observeRemoteTip(
    input.repoRoot,
    item.remoteName,
    item.remoteRef,
  );
  if (observed.kind === "error") {
    return markPending(input.hubProjectDir, item, observed.reason, now);
  }

  const tip = observed.tip;
  if (tip !== undefined) {
    await ensureCandidateObjectFetched(input.repoRoot, item, tip);
  }

  if (remoteContainsCandidate(input.repoRoot, item.candidateOid, tip)) {
    return markSucceeded(input.hubProjectDir, item, {
      publishedOid: tip,
      now,
    });
  }

  const leaseOid = tip ?? GIT_ZERO_OID;
  if (
    tip !== undefined &&
    tip !== item.expectedRemoteOid &&
    !candidateIsFastForwardOf(input.repoRoot, item.candidateOid, tip)
  ) {
    return markPending(input.hubProjectDir, item, "remote_diverged", now);
  }

  maybeCrash(input.faultInjection, "before");
  try {
    const pushed = await pushCandidate(input.repoRoot, item, leaseOid);
    if (!pushed.ok) {
      const afterFail = await observeRemoteTip(
        input.repoRoot,
        item.remoteName,
        item.remoteRef,
      );
      if (
        afterFail.kind === "ok" &&
        remoteContainsCandidate(
          input.repoRoot,
          item.candidateOid,
          afterFail.tip,
        )
      ) {
        maybeCrash(input.faultInjection, "after");
        return markSucceeded(input.hubProjectDir, item, {
          publishedOid: afterFail.tip!,
          now,
        });
      }
      return markPending(
        input.hubProjectDir,
        item,
        classifyRemoteFailure(pushed.stderr),
        now,
      );
    }
  } catch (error) {
    if (error instanceof HubLandingCrash) {
      throw error;
    }
    const afterFail = await observeRemoteTip(
      input.repoRoot,
      item.remoteName,
      item.remoteRef,
    );
    if (
      afterFail.kind === "ok" &&
      remoteContainsCandidate(input.repoRoot, item.candidateOid, afterFail.tip)
    ) {
      maybeCrash(input.faultInjection, "after");
      return markSucceeded(input.hubProjectDir, item, {
        publishedOid: afterFail.tip!,
        now,
      });
    }
    return markPending(
      input.hubProjectDir,
      item,
      classifyRemoteFailure(String(error)),
      now,
    );
  }

  maybeCrash(input.faultInjection, "after");

  const afterPush = await observeRemoteTip(
    input.repoRoot,
    item.remoteName,
    item.remoteRef,
  );
  if (
    afterPush.kind === "ok" &&
    remoteContainsCandidate(input.repoRoot, item.candidateOid, afterPush.tip)
  ) {
    return markSucceeded(input.hubProjectDir, item, {
      publishedOid: afterPush.tip!,
      now,
    });
  }
  return markSucceeded(input.hubProjectDir, item, {
    publishedOid: item.candidateOid,
    now,
  });
};

const attemptMessage = (item: HubPublicationOutboxItem): string => {
  if (item.status === "succeeded") {
    return succeededMessage(item);
  }
  return pendingMessage(item);
};

const toAttempt = (item: HubPublicationOutboxItem): HubPublicationAttempt => ({
  item,
  status: item.status,
  ...(item.pendingReason ? { pendingReason: item.pendingReason } : {}),
  message: attemptMessage(item),
});

export const projectHubPublicationOutbox = async (
  input: ProjectHubPublicationOutboxInput,
): Promise<HubPublicationOutcome> => {
  const now = (input.now ?? new Date()).toISOString();
  const items = listHubPublicationOutboxItems(input.hubProjectDir);
  const attempts: HubPublicationAttempt[] = [];
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
    message: formatHubPublicationMessage({
      pendingCount,
      items: attempts.map((attempt) => attempt.item),
    }),
  };
};

export const hubPublicationEventType = (
  status: HubPublicationStatus,
): "target_publish_pending" | "target_publish_succeeded" => {
  if (status === "succeeded") {
    return "target_publish_succeeded";
  }
  return HUB_TARGET_PUBLISH_PENDING;
};

export const hubPublicationEventReason = (
  attempt: Pick<HubPublicationAttempt, "status" | "pendingReason">,
): string | undefined => {
  if (attempt.status !== "pending") {
    return undefined;
  }
  return attempt.pendingReason ?? HUB_TARGET_PUBLISH_PENDING;
};

const shouldEmitPublicationEvent = (
  before: HubPublicationOutboxInspection,
  attempt: HubPublicationAttempt,
): boolean => {
  if (attempt.status === "pending") {
    return true;
  }
  const prior = before.items.find((item) => item.id === attempt.item.id);
  return prior?.status !== "succeeded";
};

export const selectHubPublicationEventDeltas = (
  before: HubPublicationOutboxInspection,
  outcome: HubPublicationOutcome,
): readonly HubPublicationAttempt[] =>
  outcome.attempts.filter((attempt) =>
    shouldEmitPublicationEvent(before, attempt),
  );

export const syncHubPublications = async (
  input: ProjectHubPublicationOutboxInput,
): Promise<
  HubPublicationOutcome & {
    readonly deltas: readonly HubPublicationAttempt[];
  }
> => {
  const before = inspectHubPublicationOutbox({
    hubProjectDir: input.hubProjectDir,
  });
  const outcome = await projectHubPublicationOutbox(input);
  return {
    ...outcome,
    deltas: selectHubPublicationEventDeltas(before, outcome),
  };
};
