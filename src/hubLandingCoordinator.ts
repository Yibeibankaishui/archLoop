import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  HubLandingCrash,
  HubLandingPendingError,
  bindHubLandingVerification,
  commitHubLandingTarget,
  createHubLandingCandidate,
  invalidateHubLandingCandidate,
  readHubLandingReceipt,
  type HubLandingCandidate,
  type HubLandingCommitResult,
  type HubLandingFaultInjection,
} from "./hubLanding.js";
import type { HubLandingPolicy } from "./hubLandingPolicy.js";
import {
  HUB_LANDING_TARGET_DRIFT_REBUILD_LIMIT,
  HUB_TARGET_QUIET_WAIT,
  canLandHubLandingTicket,
  ensureHubLandingQueueTicket,
  enterHubLandingQuietWait,
  findHubLandingQueueTicket,
  invalidateHubLandingSpeculativeSuffix,
  markHubLandingQueueLanded,
  readHubLandingQueue,
  recordHubLandingDriftRebuild,
  recordHubLandingQueueCandidate,
  resolveHubLandingQueueHead,
  resumeHubLandingQuietWaitIfStable,
  shouldEnterHubLandingQuietWait,
  waitHubLandingDriftBackoff,
  type HubLandingQueueClock,
  type HubLandingQueueTicket,
} from "./hubLandingQueue.js";

const execFileAsync = promisify(execFile);

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});

export const HUB_LANDING_LEASE_TTL_MS = 30_000;

export interface HubLandingProcessIdentity {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly bootIdentity: string;
}

export interface HubLandingLease extends HubLandingProcessIdentity {
  readonly ownerNonce: string;
  readonly expectedFenceOid: string;
  readonly expectedTargetOid: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface HubLandingLeaseProbe {
  readonly now?: () => Date;
  readonly createNonce?: () => string;
  readonly readIdentity?: () => HubLandingProcessIdentity;
  readonly readProcessStartIdentity?: (pid: number) => string | undefined;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly readBootIdentity?: () => string | undefined;
}

export interface HubLandingOidEvidence {
  readonly expectedTargetOid: string;
  readonly observedTargetOid: string;
  readonly expectedFenceOid: string;
  readonly observedFenceOid: string;
}

export type HubLandingLeaseAcquireResult =
  | { readonly status: "acquired"; readonly lease: HubLandingLease }
  | (HubLandingOidEvidence & {
      readonly status: "pending_contention";
      readonly owner: HubLandingLease;
      readonly message: string;
    });

const gitText = async (
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

const parseJsonRecord = (raw: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const numberField = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

export const resolveHubLandingLeasePath = (hubProjectDir: string): string =>
  join(hubProjectDir, "landing", "lease.json");

export const readProcessStartIdentity = (pid: number): string | undefined => {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) {
      return undefined;
    }
    const rest = raw
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const starttime = rest[19];
    return starttime ? `${pid}:${starttime}` : undefined;
  } catch {
    return undefined;
  }
};

export const readBootIdentity = (): string | undefined => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
};

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    return code === "EPERM";
  }
};

export const readHubLandingProcessIdentity = (): HubLandingProcessIdentity => ({
  pid: process.pid,
  processStartIdentity:
    readProcessStartIdentity(process.pid) ?? `${process.pid}:unknown`,
  bootIdentity: readBootIdentity() ?? "unknown",
});

const resolveProbe = (probe?: HubLandingLeaseProbe) => {
  const readIdentity = probe?.readIdentity ?? readHubLandingProcessIdentity;
  const readBoot =
    probe?.readBootIdentity ?? (() => readIdentity().bootIdentity);
  return {
    now: probe?.now ?? (() => new Date()),
    createNonce: probe?.createNonce ?? (() => randomUUID()),
    readIdentity,
    readProcessStartIdentity:
      probe?.readProcessStartIdentity ?? readProcessStartIdentity,
    isProcessAlive: probe?.isProcessAlive ?? isProcessAlive,
    readBootIdentity: readBoot,
  };
};

export const parseHubLandingLease = (
  value: unknown,
): HubLandingLease | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ownerNonce = stringField(record.ownerNonce);
  const pid = numberField(record.pid);
  const processStartIdentity = stringField(record.processStartIdentity);
  const bootIdentity = stringField(record.bootIdentity);
  const expectedFenceOid = stringField(record.expectedFenceOid);
  const expectedTargetOid = stringField(record.expectedTargetOid);
  const acquiredAt = stringField(record.acquiredAt);
  const expiresAt = stringField(record.expiresAt);
  if (
    !ownerNonce ||
    pid === undefined ||
    !processStartIdentity ||
    !bootIdentity ||
    !expectedFenceOid ||
    !expectedTargetOid ||
    !acquiredAt ||
    !expiresAt
  ) {
    return undefined;
  }
  return {
    ownerNonce,
    pid,
    processStartIdentity,
    bootIdentity,
    expectedFenceOid,
    expectedTargetOid,
    acquiredAt,
    expiresAt,
  };
};

export const readHubLandingLease = (
  hubProjectDir: string,
): HubLandingLease | undefined => {
  const path = resolveHubLandingLeasePath(hubProjectDir);
  if (!existsSync(path)) {
    return undefined;
  }
  return parseHubLandingLease(
    parseJsonRecord(readFileSync(path, "utf8")),
  );
};

export const isLiveHubLandingLeaseOwner = (
  lease: HubLandingLease,
  probe?: HubLandingLeaseProbe,
): boolean => {
  const resolved = resolveProbe(probe);
  if (resolved.readBootIdentity() !== lease.bootIdentity) {
    return false;
  }
  if (
    resolved.readProcessStartIdentity(lease.pid) !== lease.processStartIdentity
  ) {
    return false;
  }
  return resolved.isProcessAlive(lease.pid);
};

const isSameProcessOwner = (
  lease: HubLandingLease,
  identity: HubLandingProcessIdentity,
): boolean =>
  lease.pid === identity.pid &&
  lease.processStartIdentity === identity.processStartIdentity &&
  lease.bootIdentity === identity.bootIdentity;

const pendingLeaseContention = (
  owner: HubLandingLease,
  oids: HubLandingOidEvidence,
  message: string,
): HubLandingLeaseAcquireResult => ({
  status: "pending_contention",
  owner,
  message,
  ...oids,
});

export const acquireHubLandingLease = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly policy: HubLandingPolicy;
  readonly probe?: HubLandingLeaseProbe;
}): Promise<HubLandingLeaseAcquireResult> => {
  const probe = resolveProbe(input.probe);
  const identity = probe.readIdentity();
  const observedTargetOid = await gitText(input.repoRoot, [
    "rev-parse",
    input.policy.publishTargetRef,
  ]);
  const observedFenceOid = await gitText(input.repoRoot, [
    "rev-parse",
    input.policy.fenceRef,
  ]);
  const existing = readHubLandingLease(input.hubProjectDir);
  if (
    existing &&
    isLiveHubLandingLeaseOwner(existing, input.probe) &&
    !isSameProcessOwner(existing, identity)
  ) {
    return pendingLeaseContention(
      existing,
      {
        expectedTargetOid: existing.expectedTargetOid,
        observedTargetOid,
        expectedFenceOid: existing.expectedFenceOid,
        observedFenceOid,
      },
      `Hub landing lease is held by a live owner (pid ${existing.pid}, nonce ${existing.ownerNonce}). Transient contention remains pending and does not require a recovery command.`,
    );
  }

  const acquiredAt = probe.now().toISOString();
  const lease: HubLandingLease = {
    ownerNonce: probe.createNonce(),
    pid: identity.pid,
    processStartIdentity: identity.processStartIdentity,
    bootIdentity: identity.bootIdentity,
    expectedFenceOid: observedFenceOid,
    expectedTargetOid: observedTargetOid,
    acquiredAt,
    expiresAt: new Date(
      probe.now().getTime() + HUB_LANDING_LEASE_TTL_MS,
    ).toISOString(),
  };
  writeAtomicJson(resolveHubLandingLeasePath(input.hubProjectDir), lease);
  const confirmed = readHubLandingLease(input.hubProjectDir);
  if (!confirmed || confirmed.ownerNonce !== lease.ownerNonce) {
    return pendingLeaseContention(
      confirmed ?? lease,
      {
        expectedTargetOid: lease.expectedTargetOid,
        observedTargetOid,
        expectedFenceOid: lease.expectedFenceOid,
        observedFenceOid,
      },
      `Hub landing lease contention prevented exclusive ownership. Automatic retry will continue without a recovery command.`,
    );
  }
  return { status: "acquired", lease: confirmed };
};

export const releaseHubLandingLease = (
  hubProjectDir: string,
  ownerNonce?: string,
): void => {
  const current = readHubLandingLease(hubProjectDir);
  if (!current) {
    return;
  }
  if (ownerNonce && current.ownerNonce !== ownerNonce) {
    return;
  }
  rmSync(resolveHubLandingLeasePath(hubProjectDir), { force: true });
};

export type HubLandingCoordinatorResult = HubLandingOidEvidence &
  (
    | {
        readonly kind: "landed";
        readonly commit: HubLandingCommitResult;
        readonly candidate: HubLandingCandidate;
      }
    | {
        readonly kind: "pending_contention";
        readonly candidate: HubLandingCandidate;
        readonly message: string;
      }
    | {
        readonly kind: "stale_owner_rejected";
        readonly candidate: HubLandingCandidate;
        readonly message: string;
      }
    | {
        readonly kind: "target_quiet_wait";
        readonly candidate: HubLandingCandidate;
        readonly message: string;
        readonly ticket?: HubLandingQueueTicket;
      }
    | {
        readonly kind: "not_queue_head";
        readonly candidate: HubLandingCandidate;
        readonly message: string;
      }
  );

export type HubLandingAttemptResult =
  | HubLandingCoordinatorResult
  | (HubLandingOidEvidence & {
      readonly kind: "target_drift";
      readonly candidate: HubLandingCandidate;
      readonly message: string;
    });

const oidsFromPending = (
  error: HubLandingPendingError,
  fallback: HubLandingOidEvidence,
): HubLandingOidEvidence => ({
  expectedTargetOid: error.expectedTargetOid ?? fallback.expectedTargetOid,
  observedTargetOid: error.observedTargetOid ?? fallback.observedTargetOid,
  expectedFenceOid: error.expectedFenceOid ?? fallback.expectedFenceOid,
  observedFenceOid: error.observedFenceOid ?? fallback.observedFenceOid,
});

const maybeCrash = (
  fault: HubLandingFaultInjection | undefined,
  sideEffect: "landing_lease",
  timing: "before" | "after",
): void => {
  if (timing === "before" && fault?.crashBefore === sideEffect) {
    throw new HubLandingCrash(sideEffect, timing);
  }
  if (timing === "after" && fault?.crashAfter === sideEffect) {
    throw new HubLandingCrash(sideEffect, timing);
  }
};

const toLandedAttempt = (
  candidate: HubLandingCandidate,
  commit: HubLandingCommitResult,
  expectedFenceOid?: string,
): HubLandingCoordinatorResult => ({
  kind: "landed",
  commit,
  candidate,
  expectedTargetOid: candidate.baseOid,
  observedTargetOid: commit.publishTargetOid,
  expectedFenceOid: expectedFenceOid ?? commit.fenceOid,
  observedFenceOid: commit.fenceOid,
});

const toPendingAttempt = (
  candidate: HubLandingCandidate,
  acquired: Extract<HubLandingLeaseAcquireResult, { status: "pending_contention" }>,
): HubLandingCoordinatorResult => ({
  kind: "pending_contention",
  candidate,
  message: acquired.message,
  expectedTargetOid: acquired.expectedTargetOid,
  observedTargetOid: acquired.observedTargetOid,
  expectedFenceOid: acquired.expectedFenceOid,
  observedFenceOid: acquired.observedFenceOid,
});

const commitCandidateWithLease = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly candidate: HubLandingCandidate;
  readonly verifierFingerprint: string;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
  readonly lease?: HubLandingLease;
}): Promise<HubLandingCoordinatorResult> => {
  const commit = await commitHubLandingTarget({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
    candidate: input.candidate,
    verifierFingerprint: input.verifierFingerprint,
    now: input.now,
    faultInjection: input.faultInjection,
    expectedFenceOid: input.lease?.expectedFenceOid,
    ownerNonce: input.lease?.ownerNonce,
  });
  return toLandedAttempt(
    input.candidate,
    commit,
    input.lease?.expectedFenceOid,
  );
};

export const landHubCandidateWithLease = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly candidate: HubLandingCandidate;
  readonly verifierFingerprint: string;
  readonly now?: Date;
  readonly probe?: HubLandingLeaseProbe;
  readonly lease?: HubLandingLease;
  readonly faultInjection?: HubLandingFaultInjection;
}): Promise<HubLandingAttemptResult> => {
  const { candidate } = input;
  const existingReceipt = readHubLandingReceipt(
    input.repoRoot,
    candidate.transactionId,
  );
  if (existingReceipt?.receipt.candidateOid === candidate.candidateOid) {
    return commitCandidateWithLease({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      candidate,
      verifierFingerprint: input.verifierFingerprint,
      now: input.now,
      faultInjection: input.faultInjection,
      lease: input.lease,
    });
  }
  maybeCrash(input.faultInjection, "landing_lease", "before");
  const acquired = input.lease
    ? ({ status: "acquired" as const, lease: input.lease })
    : await acquireHubLandingLease({
        repoRoot: input.repoRoot,
        hubProjectDir: input.hubProjectDir,
        policy: candidate.policy,
        probe: input.probe,
      });
  try {
    maybeCrash(input.faultInjection, "landing_lease", "after");
    if (acquired.status === "pending_contention") {
      return toPendingAttempt(candidate, acquired);
    }

    const currentLease = readHubLandingLease(input.hubProjectDir);
    if (
      input.lease &&
      currentLease?.ownerNonce !== input.lease.ownerNonce
    ) {
      return {
        kind: "stale_owner_rejected",
        candidate,
        message: `Stale Hub landing owner rejected for ${candidate.transactionId}: lease nonce ${input.lease.ownerNonce} is no longer the owner.`,
        expectedTargetOid: input.lease.expectedTargetOid,
        observedTargetOid:
          currentLease?.expectedTargetOid ?? input.lease.expectedTargetOid,
        expectedFenceOid: input.lease.expectedFenceOid,
        observedFenceOid:
          currentLease?.expectedFenceOid ?? input.lease.expectedFenceOid,
      };
    }

    const fallbackOids: HubLandingOidEvidence = {
      expectedTargetOid: acquired.lease.expectedTargetOid,
      observedTargetOid: acquired.lease.expectedTargetOid,
      expectedFenceOid: acquired.lease.expectedFenceOid,
      observedFenceOid: acquired.lease.expectedFenceOid,
    };
    if (acquired.lease.expectedTargetOid !== candidate.baseOid) {
      return {
        kind: "target_drift",
        candidate,
        message: `Hub publish target drifted before landing ${candidate.transactionId}: expected ${candidate.baseOid}, found ${acquired.lease.expectedTargetOid}.`,
        expectedTargetOid: candidate.baseOid,
        observedTargetOid: acquired.lease.expectedTargetOid,
        expectedFenceOid: acquired.lease.expectedFenceOid,
        observedFenceOid: acquired.lease.expectedFenceOid,
      };
    }
    try {
      return await commitCandidateWithLease({
        repoRoot: input.repoRoot,
        hubProjectDir: input.hubProjectDir,
        candidate,
        verifierFingerprint: input.verifierFingerprint,
        now: input.now,
        faultInjection: input.faultInjection,
        lease: acquired.lease,
      });
    } catch (error) {
      if (!(error instanceof HubLandingPendingError)) {
        throw error;
      }
      return {
        kind: error.kind,
        candidate,
        message: error.message,
        ...oidsFromPending(error, fallbackOids),
      };
    }
  } finally {
    if (acquired.status === "acquired") {
      releaseHubLandingLease(input.hubProjectDir, acquired.lease.ownerNonce);
    }
  }
};

export const coordinateHubQueueHeadLanding = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly branch: string;
  readonly candidate?: HubLandingCandidate;
  readonly verifierFingerprint: string;
  readonly rebuild?: () => Promise<HubLandingCandidate>;
  readonly verify?: (candidate: HubLandingCandidate) => Promise<void> | void;
  readonly now?: Date;
  readonly probe?: HubLandingLeaseProbe;
  readonly faultInjection?: HubLandingFaultInjection;
  readonly merge?: (worktreeDir: string) => Promise<void>;
  readonly clock?: HubLandingQueueClock;
  readonly shippedTaskIds?: ReadonlySet<string>;
}): Promise<HubLandingCoordinatorResult> => {
  let candidate =
    input.candidate ??
    (await createHubLandingCandidate({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      taskId: input.taskId,
      branch: input.branch,
      now: input.now,
      merge: input.merge,
      faultInjection: input.faultInjection,
    }));
  const verify =
    input.verify ??
    ((next: HubLandingCandidate) => {
      bindHubLandingVerification({
        hubProjectDir: input.hubProjectDir,
        transactionId: next.transactionId,
        taskId: next.taskId,
        candidateOid: next.candidateOid,
        verifierFingerprint: input.verifierFingerprint,
        repoRoot: input.repoRoot,
      });
    });
  await verify(candidate);

  const rebuild =
    input.rebuild ??
    (async () =>
      createHubLandingCandidate({
        repoRoot: input.repoRoot,
        hubProjectDir: input.hubProjectDir,
        taskId: input.taskId,
        branch: input.branch,
        now: input.now,
        merge: input.merge,
        faultInjection: input.faultInjection,
      }));

  const syncQueueCandidate = (next: HubLandingCandidate): void => {
    recordHubLandingQueueCandidate({
      hubProjectDir: input.hubProjectDir,
      taskId: input.taskId,
      sourceOid: next.sourceOid,
      predecessorOid: next.baseOid,
      candidateOid: next.candidateOid,
      transactionId: next.transactionId,
    });
  };

  const ticketForTask = (): HubLandingQueueTicket | undefined =>
    findHubLandingQueueTicket(input.hubProjectDir, input.taskId);

  const activationDriftRebuilds = (): number =>
    ticketForTask()?.activationDriftRebuilds ?? 0;

  const withFenceEvidence = <T extends Record<string, unknown>>(
    fields: T,
    expectedOid: string,
    observedOid: string,
  ): T & HubLandingOidEvidence => ({
    ...fields,
    expectedTargetOid: expectedOid,
    observedTargetOid: observedOid,
    expectedFenceOid: expectedOid,
    observedFenceOid: observedOid,
  });

  const rebuildVerifiedCandidate = async (): Promise<HubLandingCandidate> => {
    const next = await rebuild();
    await verify(next);
    syncQueueCandidate(next);
    return next;
  };

  ensureHubLandingQueueTicket({
    hubProjectDir: input.hubProjectDir,
    publishTargetRef: candidate.policy.publishTargetRef,
    taskId: input.taskId,
    sourceOid: candidate.sourceOid,
    clock: input.clock,
  });
  syncQueueCandidate(candidate);

  const observedTarget = await gitText(input.repoRoot, [
    "rev-parse",
    candidate.policy.publishTargetRef,
  ]);
  const resume = resumeHubLandingQuietWaitIfStable({
    hubProjectDir: input.hubProjectDir,
    taskId: input.taskId,
    observedTargetOid: observedTarget,
    clock: input.clock,
  });
  if (resume === "waiting") {
    return withFenceEvidence(
      {
        kind: "target_quiet_wait" as const,
        candidate,
        ticket: ticketForTask(),
        message: `Retaining FIFO ticket for ${input.taskId} in ${HUB_TARGET_QUIET_WAIT} until the Hub publish target is stable. This is not a task failure and does not require a recovery command.`,
      },
      candidate.baseOid,
      observedTarget,
    );
  }
  if (resume === "resumed") {
    invalidateHubLandingCandidate({
      hubProjectDir: input.hubProjectDir,
      transactionId: candidate.transactionId,
    });
    candidate = await rebuildVerifiedCandidate();
  }

  if (
    !canLandHubLandingTicket({
      hubProjectDir: input.hubProjectDir,
      taskId: input.taskId,
      shippedTaskIds: input.shippedTaskIds,
    })
  ) {
    const head = resolveHubLandingQueueHead(
      readHubLandingQueue(input.hubProjectDir),
      input.shippedTaskIds ?? new Set(),
    );
    return withFenceEvidence(
      {
        kind: "not_queue_head" as const,
        candidate,
        message: `Task ${input.taskId} cannot overtake FIFO queue head ${head?.taskId ?? "(unknown)"}. This is not a task failure and does not require a recovery command.`,
      },
      candidate.baseOid,
      observedTarget,
    );
  }

  for (;;) {
    const outcome = await landHubCandidateWithLease({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      candidate,
      verifierFingerprint: input.verifierFingerprint,
      now: input.now,
      probe: input.probe,
      faultInjection: input.faultInjection,
    });
    if (outcome.kind !== "target_drift") {
      if (outcome.kind === "landed") {
        markHubLandingQueueLanded(input.hubProjectDir, input.taskId);
      }
      return outcome;
    }
    if (
      shouldEnterHubLandingQuietWait({
        hubProjectDir: input.hubProjectDir,
        taskId: input.taskId,
      })
    ) {
      const ticket = enterHubLandingQuietWait({
        hubProjectDir: input.hubProjectDir,
        taskId: input.taskId,
        observedTargetOid: outcome.observedTargetOid,
        clock: input.clock,
      });
      return {
        kind: "target_quiet_wait",
        candidate,
        ticket,
        message: `Queue head ${input.taskId} entered ${HUB_TARGET_QUIET_WAIT} after ${HUB_LANDING_TARGET_DRIFT_REBUILD_LIMIT} immediate target-drift rebuilds. Later transactions cannot overtake this ticket. This is not a task failure and does not require a recovery command.`,
        expectedTargetOid: outcome.expectedTargetOid,
        observedTargetOid: outcome.observedTargetOid,
        expectedFenceOid: outcome.expectedFenceOid,
        observedFenceOid: outcome.observedFenceOid,
      };
    }
    await waitHubLandingDriftBackoff(input.clock, activationDriftRebuilds());
    recordHubLandingDriftRebuild({
      hubProjectDir: input.hubProjectDir,
      taskId: input.taskId,
      observedTargetOid: outcome.observedTargetOid,
      clock: input.clock,
    });
    invalidateHubLandingCandidate({
      hubProjectDir: input.hubProjectDir,
      transactionId: candidate.transactionId,
    });
    invalidateHubLandingSpeculativeSuffix({
      hubProjectDir: input.hubProjectDir,
      fromTaskId: input.taskId,
      reason: "target_drift",
      clock: input.clock,
    });
    candidate = await rebuildVerifiedCandidate();
  }
};
