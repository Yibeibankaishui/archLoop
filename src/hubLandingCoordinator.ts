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

export type HubLandingLeaseAcquireResult =
  | { readonly status: "acquired"; readonly lease: HubLandingLease }
  | {
      readonly status: "pending_contention";
      readonly owner: HubLandingLease;
      readonly expectedTargetOid: string;
      readonly observedTargetOid: string;
      readonly expectedFenceOid: string;
      readonly observedFenceOid: string;
      readonly message: string;
    };

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
    return {
      status: "pending_contention",
      owner: existing,
      expectedTargetOid: existing.expectedTargetOid,
      observedTargetOid,
      expectedFenceOid: existing.expectedFenceOid,
      observedFenceOid,
      message: `Hub landing lease is held by a live owner (pid ${existing.pid}, nonce ${existing.ownerNonce}). Transient contention remains pending and does not require a recovery command.`,
    };
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
    const owner = confirmed ?? lease;
    return {
      status: "pending_contention",
      owner,
      expectedTargetOid: lease.expectedTargetOid,
      observedTargetOid,
      expectedFenceOid: lease.expectedFenceOid,
      observedFenceOid,
      message: `Hub landing lease contention prevented exclusive ownership. Automatic retry will continue without a recovery command.`,
    };
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

export interface HubLandingOidEvidence {
  readonly expectedTargetOid: string;
  readonly observedTargetOid: string;
  readonly expectedFenceOid: string;
  readonly observedFenceOid: string;
}

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

export const landHubCandidateWithLease = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly candidate: HubLandingCandidate;
  readonly verifierFingerprint: string;
  readonly now?: Date;
  readonly probe?: HubLandingLeaseProbe;
  readonly lease?: HubLandingLease;
  readonly faultInjection?: HubLandingFaultInjection;
}): Promise<
  | HubLandingCoordinatorResult
  | (HubLandingOidEvidence & {
      readonly kind: "target_drift";
      readonly candidate: HubLandingCandidate;
      readonly message: string;
    })
> => {
  const { candidate } = input;
  const existingReceipt = readHubLandingReceipt(
    input.repoRoot,
    candidate.transactionId,
  );
  if (existingReceipt?.receipt.candidateOid === candidate.candidateOid) {
    const commit = await commitHubLandingTarget({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      candidate,
      verifierFingerprint: input.verifierFingerprint,
      now: input.now,
      faultInjection: input.faultInjection,
      expectedFenceOid: input.lease?.expectedFenceOid,
      ownerNonce: input.lease?.ownerNonce,
    });
    return {
      kind: "landed",
      commit,
      candidate,
      expectedTargetOid: candidate.baseOid,
      observedTargetOid: commit.publishTargetOid,
      expectedFenceOid: input.lease?.expectedFenceOid ?? commit.fenceOid,
      observedFenceOid: commit.fenceOid,
    };
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
      return {
        kind: "pending_contention",
        candidate,
        message: acquired.message,
        expectedTargetOid: acquired.expectedTargetOid,
        observedTargetOid: acquired.observedTargetOid,
        expectedFenceOid: acquired.expectedFenceOid,
        observedFenceOid: acquired.observedFenceOid,
      };
    }

    const currentLease = readHubLandingLease(input.hubProjectDir);
    if (
      input.lease &&
      currentLease?.ownerNonce !== input.lease.ownerNonce
    ) {
      const observedTargetOid = currentLease?.expectedTargetOid ??
        input.lease.expectedTargetOid;
      const observedFenceOid =
        currentLease?.expectedFenceOid ?? input.lease.expectedFenceOid;
      return {
        kind: "stale_owner_rejected",
        candidate,
        message: `Stale Hub landing owner rejected for ${candidate.transactionId}: lease nonce ${input.lease.ownerNonce} is no longer the owner.`,
        expectedTargetOid: input.lease.expectedTargetOid,
        observedTargetOid,
        expectedFenceOid: input.lease.expectedFenceOid,
        observedFenceOid,
      };
    }

    const fallbackOids: HubLandingOidEvidence = {
      expectedTargetOid: acquired.lease.expectedTargetOid,
      observedTargetOid: acquired.lease.expectedTargetOid,
      expectedFenceOid: acquired.lease.expectedFenceOid,
      observedFenceOid: acquired.lease.expectedFenceOid,
    };
    try {
      if (acquired.lease.expectedTargetOid !== candidate.baseOid) {
        throw new HubLandingPendingError(
          "target_drift",
          `Hub publish target drifted before landing ${candidate.transactionId}: expected ${candidate.baseOid}, found ${acquired.lease.expectedTargetOid}.`,
          candidate.baseOid,
          acquired.lease.expectedTargetOid,
          acquired.lease.expectedFenceOid,
          acquired.lease.expectedFenceOid,
        );
      }
      const commit = await commitHubLandingTarget({
        repoRoot: input.repoRoot,
        hubProjectDir: input.hubProjectDir,
        candidate,
        verifierFingerprint: input.verifierFingerprint,
        now: input.now,
        faultInjection: input.faultInjection,
        expectedFenceOid: acquired.lease.expectedFenceOid,
        ownerNonce: acquired.lease.ownerNonce,
      });
      return {
        kind: "landed",
        commit,
        candidate,
        expectedTargetOid: candidate.baseOid,
        observedTargetOid: commit.publishTargetOid,
        expectedFenceOid: acquired.lease.expectedFenceOid,
        observedFenceOid: commit.fenceOid,
      };
    } catch (error) {
      if (error instanceof HubLandingPendingError) {
        const oids = oidsFromPending(error, fallbackOids);
        if (error.kind === "target_drift") {
          return {
            kind: "target_drift",
            candidate,
            message: error.message,
            ...oids,
          };
        }
        return {
          kind: error.kind,
          candidate,
          message: error.message,
          ...oids,
        };
      }
      throw error;
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
      return outcome;
    }
    invalidateHubLandingCandidate({
      hubProjectDir: input.hubProjectDir,
      transactionId: candidate.transactionId,
    });
    candidate = await rebuild();
    await verify(candidate);
  }
};
