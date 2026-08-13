import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { promisify } from "node:util";

import {
  ensureHubLandingPolicy,
  type HubLandingPolicy,
} from "./hubLandingPolicy.js";
import {
  appendHubLandingCheckpoint,
  loadHubLandingTransaction,
  resolveHubLandingTransactionDir,
  resolveHubLandingTransactionId,
  type HubLandingTransactionState,
} from "./hubLandingTransaction.js";

const execFileAsync = promisify(execFile);

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});

const gitWithStdin = (
  cwd: string,
  args: readonly string[],
  input: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        env: gitEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stdout,
              stderr,
            }),
          );
          return;
        }
        resolve(String(stdout).trim());
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });

export interface HubLandingCandidate {
  readonly transactionId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly sourceOid: string;
  readonly baseOid: string;
  readonly candidateOid: string;
  readonly candidateRef: string;
  readonly worktreeDir: string;
  readonly policy: HubLandingPolicy;
  readonly state: HubLandingTransactionState;
}

export interface HubLandingVerificationArtifact {
  readonly candidateOid: string;
  readonly verifierFingerprint: string;
  readonly verifierConfigHash?: string;
  readonly runtimeFingerprint?: string;
  readonly exitCode: number;
  readonly outputHash: string;
  readonly artifactHash?: string;
  readonly createdAt: string;
}

export interface HubLandingReceipt {
  readonly transactionId: string;
  readonly taskId: string;
  readonly candidateOid: string;
  readonly sourceOid: string;
  readonly baseOid: string;
  readonly publishTargetRef: string;
  readonly fenceRef: string;
  readonly verifierFingerprint: string;
  readonly landedAt: string;
}

export interface HubLandingCommitResult {
  readonly transactionId: string;
  readonly candidateOid: string;
  readonly publishTargetOid: string;
  readonly fenceOid: string;
  readonly receiptOid: string;
  readonly receiptRef: string;
  readonly state: HubLandingTransactionState;
}

export const HUB_LANDING_SIDE_EFFECTS = [
  "candidate_ref",
  "verification_artifact",
  "atomic_landing",
  "task_close",
  "cleanup",
] as const;

export type HubLandingSideEffect = (typeof HUB_LANDING_SIDE_EFFECTS)[number];

export interface HubLandingFaultInjection {
  readonly crashBefore?: HubLandingSideEffect;
  readonly crashAfter?: HubLandingSideEffect;
}

export class HubLandingCrash extends Error {
  readonly name = "HubLandingCrash";

  constructor(
    readonly sideEffect: HubLandingSideEffect,
    readonly timing: "before" | "after",
  ) {
    super(`Hub landing crash injected ${timing} ${sideEffect}`);
  }
}

export interface HubLandingCandidateManifest {
  readonly transactionId: string;
  readonly taskId: string;
  readonly sourceOid: string;
  readonly baseOid: string;
  readonly candidateOid: string;
  readonly candidateRef: string;
  readonly createdAt: string;
}

export interface HubVerifierFingerprintParts {
  readonly verifierConfigHash: string;
  readonly runtimeFingerprint: string;
  readonly verifierFingerprint: string;
}

export interface HubLandingBeadsCloseEvidence {
  readonly closed: boolean;
  readonly transactionId?: string;
  readonly candidateOid?: string;
}

export type HubLandingTaskCloseReader = (
  taskId: string,
) => HubLandingBeadsCloseEvidence | undefined;

export type HubLandingTaskCloser = (input: {
  readonly taskId: string;
  readonly transactionId: string;
  readonly candidateOid: string;
}) => Promise<void> | void;

export const isMatchingHubLandingBeadsClose = (
  evidence: HubLandingBeadsCloseEvidence | undefined,
  identity: {
    readonly transactionId: string;
    readonly candidateOid: string | undefined;
  },
): boolean =>
  evidence?.closed === true &&
  evidence.transactionId === identity.transactionId &&
  identity.candidateOid !== undefined &&
  evidence.candidateOid === identity.candidateOid;

export const HUB_LANDING_INTEGRITY_INCIDENT = "landing_integrity_incident";

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

const gitOk = async (
  cwd: string,
  args: readonly string[],
): Promise<boolean> => {
  try {
    await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
    });
    return true;
  } catch {
    return false;
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

const hashBuffer = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

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

const readJsonFile = (path: string): Record<string, unknown> | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  return parseJsonRecord(readFileSync(path, "utf8"));
};

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const requiredStrings = <K extends string>(
  value: Record<string, unknown>,
  keys: readonly K[],
): Record<K, string> | undefined => {
  const result = {} as Record<K, string>;
  for (const key of keys) {
    const field = stringField(value[key]);
    if (field === undefined) {
      return undefined;
    }
    result[key] = field;
  }
  return result;
};

export const resolveHubLandingCandidateRef = (transactionId: string): string =>
  `refs/archloop/candidates/${transactionId}`;

export const resolveHubLandingReceiptRef = (transactionId: string): string =>
  `refs/archloop/receipts/${transactionId}`;

export const resolveHubLandingWorktreeDir = (
  hubProjectDir: string,
  transactionId: string,
): string => join(hubProjectDir, "landing", "worktrees", transactionId);

export const resolveHubLandingVerificationArtifactPath = (
  hubProjectDir: string,
  transactionId: string,
): string =>
  join(
    resolveHubLandingTransactionDir(hubProjectDir, transactionId),
    "verification.json",
  );

export const resolveHubLandingCandidateManifestPath = (
  hubProjectDir: string,
  transactionId: string,
): string =>
  join(
    resolveHubLandingTransactionDir(hubProjectDir, transactionId),
    "candidate.json",
  );

const resolveCandidateRef = resolveHubLandingCandidateRef;
const resolveReceiptRef = resolveHubLandingReceiptRef;
const resolveWorktreeDir = resolveHubLandingWorktreeDir;
const resolveVerificationArtifactPath = resolveHubLandingVerificationArtifactPath;

const maybeCrash = (
  fault: HubLandingFaultInjection | undefined,
  sideEffect: HubLandingSideEffect,
  timing: "before" | "after",
): void => {
  if (timing === "before" && fault?.crashBefore === sideEffect) {
    throw new HubLandingCrash(sideEffect, timing);
  }
  if (timing === "after" && fault?.crashAfter === sideEffect) {
    throw new HubLandingCrash(sideEffect, timing);
  }
};

const tryGitText = async (
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> => {
  try {
    return await gitText(cwd, args);
  } catch {
    return undefined;
  }
};

const tryGitTextSync = (
  cwd: string,
  args: readonly string[],
): string | undefined => {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    }).trim();
  } catch {
    return undefined;
  }
};

const hashObject = async (repoRoot: string, payload: string): Promise<string> =>
  gitWithStdin(repoRoot, ["hash-object", "-w", "--stdin"], payload);

const readBootIdentity = (): string | undefined => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
};

const createFencePayload = (now: string): string =>
  `${JSON.stringify({
    kind: "hub-landing-fence",
    ownerNonce: randomUUID(),
    pid: process.pid,
    bootId: readBootIdentity(),
    createdAt: now,
  })}\n`;

export const computeHubVerifierParts = (
  repoRoot: string,
): HubVerifierFingerprintParts => {
  const scriptPath = join(repoRoot, ".archloop", "verify.sh");
  const scriptHash = existsSync(scriptPath)
    ? hashBuffer(readFileSync(scriptPath, "utf8"))
    : "no-verify-script";
  const runtimeKey = `runtime:${process.version}\nplatform:${process.platform}\n`;
  return {
    verifierConfigHash: hashBuffer(`verify.sh:${scriptHash}`),
    runtimeFingerprint: hashBuffer(runtimeKey),
    verifierFingerprint: hashBuffer(`verify.sh:${scriptHash}\n${runtimeKey}`),
  };
};

export const computeHubVerifierFingerprint = (repoRoot: string): string =>
  computeHubVerifierParts(repoRoot).verifierFingerprint;

const hashVerificationArtifact = (
  artifact: Omit<HubLandingVerificationArtifact, "artifactHash">,
): string =>
  hashBuffer(
    JSON.stringify({
      candidateOid: artifact.candidateOid,
      verifierFingerprint: artifact.verifierFingerprint,
      verifierConfigHash: artifact.verifierConfigHash,
      runtimeFingerprint: artifact.runtimeFingerprint,
      exitCode: artifact.exitCode,
      outputHash: artifact.outputHash,
      createdAt: artifact.createdAt,
    }),
  );

export const isReusableHubLandingVerificationArtifact = (input: {
  readonly artifact: HubLandingVerificationArtifact;
  readonly candidateOid: string;
  readonly verifierFingerprint: string;
  readonly verifierConfigHash: string;
  readonly runtimeFingerprint: string;
}): boolean => {
  const { artifact } = input;
  if (
    artifact.candidateOid !== input.candidateOid ||
    artifact.verifierFingerprint !== input.verifierFingerprint ||
    artifact.verifierConfigHash !== input.verifierConfigHash ||
    artifact.runtimeFingerprint !== input.runtimeFingerprint ||
    artifact.exitCode !== 0 ||
    !artifact.artifactHash
  ) {
    return false;
  }
  return hashVerificationArtifact(artifact) === artifact.artifactHash;
};

export const readHubLandingVerificationArtifact = (
  hubProjectDir: string,
  transactionId: string,
): HubLandingVerificationArtifact | undefined => {
  const value = readJsonFile(
    resolveVerificationArtifactPath(hubProjectDir, transactionId),
  );
  if (!value || typeof value.exitCode !== "number") {
    return undefined;
  }
  const required = requiredStrings(value, [
    "candidateOid",
    "verifierFingerprint",
    "outputHash",
    "createdAt",
  ]);
  if (!required) {
    return undefined;
  }
  return {
    ...required,
    verifierConfigHash: stringField(value.verifierConfigHash),
    runtimeFingerprint: stringField(value.runtimeFingerprint),
    exitCode: value.exitCode,
    artifactHash: stringField(value.artifactHash),
  };
};

export const readHubLandingCandidateManifest = (
  hubProjectDir: string,
  transactionId: string,
): HubLandingCandidateManifest | undefined => {
  const value = readJsonFile(
    resolveHubLandingCandidateManifestPath(hubProjectDir, transactionId),
  );
  if (!value) {
    return undefined;
  }
  return requiredStrings(value, [
    "transactionId",
    "taskId",
    "sourceOid",
    "baseOid",
    "candidateOid",
    "candidateRef",
    "createdAt",
  ]);
};

export const readHubLandingReceipt = (
  repoRoot: string,
  transactionId: string,
): { readonly receipt: HubLandingReceipt; readonly oid: string } | undefined => {
  const receiptRef = resolveReceiptRef(transactionId);
  const oid = tryGitTextSync(repoRoot, ["rev-parse", receiptRef]);
  if (!oid) {
    return undefined;
  }
  const payload = tryGitTextSync(repoRoot, ["cat-file", "-p", oid]);
  if (!payload) {
    return undefined;
  }
  const value = parseJsonRecord(payload);
  if (!value) {
    return undefined;
  }
  const receipt = requiredStrings(value, [
    "transactionId",
    "taskId",
    "candidateOid",
    "sourceOid",
    "baseOid",
    "publishTargetRef",
    "fenceRef",
    "verifierFingerprint",
    "landedAt",
  ]);
  return receipt ? { oid, receipt } : undefined;
};

const ensureCandidateWorktree = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly candidateOid: string;
}): Promise<string> => {
  const worktreeDir = resolveWorktreeDir(
    input.hubProjectDir,
    input.transactionId,
  );
  if (!existsSync(worktreeDir)) {
    mkdirSync(dirname(worktreeDir), { recursive: true });
    await execFileAsync(
      "git",
      ["worktree", "add", "--detach", worktreeDir, input.candidateOid],
      { cwd: input.repoRoot },
    );
  }
  return worktreeDir;
};

const restoreCandidateFromEvidence = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly expectedCandidateOid?: string;
}): Promise<{ readonly candidateOid: string; readonly candidateRef: string } | undefined> => {
  const candidateRef = resolveCandidateRef(input.transactionId);
  const manifest = readHubLandingCandidateManifest(
    input.hubProjectDir,
    input.transactionId,
  );
  const refOid = await tryGitText(input.repoRoot, ["rev-parse", candidateRef]);
  const candidateOid = refOid ?? manifest?.candidateOid;
  if (!candidateOid) {
    return undefined;
  }
  if (
    input.expectedCandidateOid &&
    candidateOid !== input.expectedCandidateOid
  ) {
    return undefined;
  }
  if (manifest?.candidateOid && manifest.candidateOid !== candidateOid) {
    return undefined;
  }
  if (!refOid) {
    const objectExists = await gitOk(input.repoRoot, [
      "cat-file",
      "-e",
      candidateOid,
    ]);
    if (!objectExists) {
      return undefined;
    }
    await execFileAsync(
      "git",
      ["update-ref", candidateRef, candidateOid],
      { cwd: input.repoRoot },
    );
  }
  return { candidateOid, candidateRef };
};

const removeWorktree = async (
  repoRoot: string,
  worktreeDir: string,
): Promise<void> => {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], {
      cwd: repoRoot,
    });
  } catch {
    rmSync(worktreeDir, { recursive: true, force: true });
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: repoRoot,
    }).catch(() => undefined);
  }
};

export class HubLandingWorktreeError extends Error {
  readonly name = "HubLandingWorktreeError";
  readonly details?: unknown;

  constructor(
    message: string,
    readonly worktreeDir: string,
    options?: { readonly cause?: unknown; readonly details?: unknown },
  ) {
    super(message);
    this.details = options?.details ?? options?.cause;
  }
}

export const createHubLandingCandidate = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly branch: string;
  readonly now?: Date;
  readonly merge?: (worktreeDir: string) => Promise<void>;
  readonly faultInjection?: HubLandingFaultInjection;
}): Promise<HubLandingCandidate> => {
  const policy = ensureHubLandingPolicy({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
    now: input.now,
  }).policy;
  const sourceOid = await gitText(input.repoRoot, [
    "rev-parse",
    `${input.branch}^{commit}`,
  ]);
  const baseOid = await gitText(input.repoRoot, [
    "rev-parse",
    policy.publishTargetRef,
  ]);
  const transactionId = resolveHubLandingTransactionId({
    taskId: input.taskId,
    sourceOid,
    baseOid,
  });
  const now = (input.now ?? new Date()).toISOString();
  const existing = loadHubLandingTransaction(
    input.hubProjectDir,
    transactionId,
  );
  const currentRefOid = await tryGitText(input.repoRoot, [
    "rev-parse",
    resolveCandidateRef(transactionId),
  ]);
  if (
    existing?.candidateOid &&
    currentRefOid &&
    existing.candidateOid !== currentRefOid
  ) {
    throw new Error(
      `${HUB_LANDING_INTEGRITY_INCIDENT}: journal candidate ${existing.candidateOid} does not match ref ${currentRefOid}.`,
    );
  }
  const restored = await restoreCandidateFromEvidence({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
    transactionId,
    expectedCandidateOid: existing?.candidateOid,
  });
  if (restored) {
    const worktreeDir = await ensureCandidateWorktree({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      transactionId,
      candidateOid: restored.candidateOid,
    });
    const state =
      existing?.candidateOid === restored.candidateOid
        ? existing
        : appendHubLandingCheckpoint(input.hubProjectDir, {
            type: "checkpoint",
            checkpoint: "candidate_created",
            transactionId,
            taskId: input.taskId,
            createdAt: now,
            sourceOid,
            baseOid,
            candidateOid: restored.candidateOid,
            candidateRef: restored.candidateRef,
          });
    return {
      transactionId,
      taskId: input.taskId,
      branch: input.branch,
      sourceOid,
      baseOid,
      candidateOid: restored.candidateOid,
      candidateRef: restored.candidateRef,
      worktreeDir,
      policy,
      state,
    };
  }

  appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "opened",
    transactionId,
    taskId: input.taskId,
    createdAt: now,
    sourceOid,
    baseOid,
  });
  appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "base_pinned",
    transactionId,
    taskId: input.taskId,
    createdAt: now,
    sourceOid,
    baseOid,
  });

  const worktreeDir = resolveWorktreeDir(input.hubProjectDir, transactionId);
  if (existsSync(worktreeDir)) {
    await removeWorktree(input.repoRoot, worktreeDir);
  }
  mkdirSync(dirname(worktreeDir), { recursive: true });
  await execFileAsync(
    "git",
    ["worktree", "add", "--detach", worktreeDir, baseOid],
    { cwd: input.repoRoot },
  );

  try {
    if (input.merge) {
      await input.merge(worktreeDir);
    } else {
      await execFileAsync(
        "git",
        ["merge", "--no-ff", input.branch, "-m", `Merge ${input.branch}`],
        { cwd: worktreeDir, env: gitEnv() },
      );
    }
  } catch (error) {
    if (input.merge) {
      throw new HubLandingWorktreeError(
        error instanceof Error ? error.message : String(error),
        worktreeDir,
        { cause: error, details: error },
      );
    }
    await removeWorktree(input.repoRoot, worktreeDir).catch(() => undefined);
    throw error;
  }

  const candidateOid = await gitText(worktreeDir, ["rev-parse", "HEAD"]);
  const candidateRef = resolveCandidateRef(transactionId);
  maybeCrash(input.faultInjection, "candidate_ref", "before");
  writeAtomicJson(
    resolveHubLandingCandidateManifestPath(input.hubProjectDir, transactionId),
    {
      transactionId,
      taskId: input.taskId,
      sourceOid,
      baseOid,
      candidateOid,
      candidateRef,
      createdAt: now,
    } satisfies HubLandingCandidateManifest,
  );
  await execFileAsync("git", ["update-ref", candidateRef, candidateOid], {
    cwd: input.repoRoot,
  });
  maybeCrash(input.faultInjection, "candidate_ref", "after");
  const state = appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "candidate_created",
    transactionId,
    taskId: input.taskId,
    createdAt: now,
    sourceOid,
    baseOid,
    candidateOid,
    candidateRef,
  });

  return {
    transactionId,
    taskId: input.taskId,
    branch: input.branch,
    sourceOid,
    baseOid,
    candidateOid,
    candidateRef,
    worktreeDir,
    policy,
    state,
  };
};

const recordCandidateVerifiedCheckpoint = (input: {
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly candidateOid: string;
  readonly verifierFingerprint: string;
  readonly createdAt: string;
  readonly artifactPath: string;
}): HubLandingTransactionState =>
  appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "candidate_verified",
    transactionId: input.transactionId,
    taskId: input.taskId,
    createdAt: input.createdAt,
    candidateOid: input.candidateOid,
    verifierFingerprint: input.verifierFingerprint,
    verificationArtifactPath: input.artifactPath,
  });

export const bindHubLandingVerification = (input: {
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly candidateOid: string;
  readonly verifierFingerprint: string;
  readonly verifierConfigHash?: string;
  readonly runtimeFingerprint?: string;
  readonly repoRoot?: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
}): HubLandingVerificationArtifact => {
  const parts = input.repoRoot
    ? computeHubVerifierParts(input.repoRoot)
    : undefined;
  const verifierConfigHash =
    input.verifierConfigHash ?? parts?.verifierConfigHash;
  const runtimeFingerprint =
    input.runtimeFingerprint ?? parts?.runtimeFingerprint;
  const existing = readHubLandingVerificationArtifact(
    input.hubProjectDir,
    input.transactionId,
  );
  const artifactPath = resolveVerificationArtifactPath(
    input.hubProjectDir,
    input.transactionId,
  );
  if (
    existing &&
    verifierConfigHash &&
    runtimeFingerprint &&
    isReusableHubLandingVerificationArtifact({
      artifact: existing,
      candidateOid: input.candidateOid,
      verifierFingerprint: input.verifierFingerprint,
      verifierConfigHash,
      runtimeFingerprint,
    })
  ) {
    recordCandidateVerifiedCheckpoint({
      hubProjectDir: input.hubProjectDir,
      transactionId: input.transactionId,
      taskId: input.taskId,
      candidateOid: input.candidateOid,
      verifierFingerprint: input.verifierFingerprint,
      createdAt: existing.createdAt,
      artifactPath,
    });
    return existing;
  }

  const now = (input.now ?? new Date()).toISOString();
  const artifactBase: Omit<HubLandingVerificationArtifact, "artifactHash"> = {
    candidateOid: input.candidateOid,
    verifierFingerprint: input.verifierFingerprint,
    verifierConfigHash,
    runtimeFingerprint,
    exitCode: input.exitCode ?? 0,
    outputHash: hashBuffer(input.output ?? ""),
    createdAt: now,
  };
  const artifact: HubLandingVerificationArtifact = {
    ...artifactBase,
    artifactHash: hashVerificationArtifact(artifactBase),
  };
  maybeCrash(input.faultInjection, "verification_artifact", "before");
  writeAtomicJson(artifactPath, artifact);
  maybeCrash(input.faultInjection, "verification_artifact", "after");
  recordCandidateVerifiedCheckpoint({
    hubProjectDir: input.hubProjectDir,
    transactionId: input.transactionId,
    taskId: input.taskId,
    candidateOid: input.candidateOid,
    verifierFingerprint: input.verifierFingerprint,
    createdAt: now,
    artifactPath,
  });
  return artifact;
};

const assertVerifiedCandidate = (input: {
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly candidateOid: string;
  readonly verifierFingerprint: string;
}): HubLandingVerificationArtifact => {
  const artifact = readHubLandingVerificationArtifact(
    input.hubProjectDir,
    input.transactionId,
  );
  if (!artifact) {
    throw new Error(
      `Unverified landing candidate ${input.candidateOid} cannot advance the Hub publish target.`,
    );
  }
  if (artifact.candidateOid !== input.candidateOid) {
    throw new Error(
      `Stale verification artifact for ${input.transactionId}: artifact ${artifact.candidateOid} does not match candidate ${input.candidateOid}.`,
    );
  }
  if (artifact.verifierFingerprint !== input.verifierFingerprint) {
    throw new Error(
      `Stale verifier fingerprint for ${input.transactionId}.`,
    );
  }
  if (artifact.exitCode !== 0) {
    throw new Error(
      `Verification artifact for ${input.transactionId} did not succeed.`,
    );
  }
  return artifact;
};

const recordTargetLandedCheckpoint = (input: {
  readonly hubProjectDir: string;
  readonly candidate: HubLandingCandidate;
  readonly verifierFingerprint: string;
  readonly fenceOid: string;
  readonly receiptRef: string;
  readonly receiptOid: string;
  readonly createdAt: string;
}): HubLandingTransactionState =>
  appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "target_landed",
    transactionId: input.candidate.transactionId,
    taskId: input.candidate.taskId,
    createdAt: input.createdAt,
    sourceOid: input.candidate.sourceOid,
    baseOid: input.candidate.baseOid,
    candidateOid: input.candidate.candidateOid,
    candidateRef: input.candidate.candidateRef,
    verifierFingerprint: input.verifierFingerprint,
    publishTargetOid: input.candidate.candidateOid,
    fenceOid: input.fenceOid,
    receiptRef: input.receiptRef,
    receiptOid: input.receiptOid,
  });

export const commitHubLandingTarget = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly candidate: HubLandingCandidate;
  readonly verifierFingerprint: string;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
}): Promise<HubLandingCommitResult> => {
  const { candidate } = input;
  assertVerifiedCandidate({
    hubProjectDir: input.hubProjectDir,
    transactionId: candidate.transactionId,
    candidateOid: candidate.candidateOid,
    verifierFingerprint: input.verifierFingerprint,
  });

  const existingReceipt = readHubLandingReceipt(
    input.repoRoot,
    candidate.transactionId,
  );
  if (existingReceipt) {
    if (existingReceipt.receipt.candidateOid !== candidate.candidateOid) {
      throw new Error(
        `${HUB_LANDING_INTEGRITY_INCIDENT}: receipt ${existingReceipt.receipt.candidateOid} does not match candidate ${candidate.candidateOid}.`,
      );
    }
    const fenceOid =
      (await tryGitText(input.repoRoot, [
        "rev-parse",
        candidate.policy.fenceRef,
      ])) ?? existingReceipt.oid;
    const publishTargetOid = await gitText(input.repoRoot, [
      "rev-parse",
      candidate.policy.publishTargetRef,
    ]);
    const inAncestry =
      publishTargetOid === candidate.candidateOid ||
      (await gitOk(input.repoRoot, [
        "merge-base",
        "--is-ancestor",
        candidate.candidateOid,
        publishTargetOid,
      ]));
    if (!inAncestry) {
      throw new Error(
        `${HUB_LANDING_INTEGRITY_INCIDENT}: landing receipt exists for ${candidate.transactionId} but the Hub publish target no longer contains candidate ${candidate.candidateOid}.`,
      );
    }
    const state = recordTargetLandedCheckpoint({
      hubProjectDir: input.hubProjectDir,
      candidate,
      verifierFingerprint: input.verifierFingerprint,
      fenceOid,
      receiptRef: resolveReceiptRef(candidate.transactionId),
      receiptOid: existingReceipt.oid,
      createdAt: existingReceipt.receipt.landedAt,
    });
    return {
      transactionId: candidate.transactionId,
      candidateOid: candidate.candidateOid,
      publishTargetOid,
      fenceOid,
      receiptOid: existingReceipt.oid,
      receiptRef: resolveReceiptRef(candidate.transactionId),
      state,
    };
  }

  const expectedTargetOid = await gitText(input.repoRoot, [
    "rev-parse",
    candidate.policy.publishTargetRef,
  ]);
  if (expectedTargetOid !== candidate.baseOid) {
    throw new Error(
      `Hub publish target drifted before landing ${candidate.transactionId}: expected ${candidate.baseOid}, found ${expectedTargetOid}.`,
    );
  }
  const expectedFenceOid = await gitText(input.repoRoot, [
    "rev-parse",
    candidate.policy.fenceRef,
  ]);

  const now = (input.now ?? new Date()).toISOString();
  const receipt: HubLandingReceipt = {
    transactionId: candidate.transactionId,
    taskId: candidate.taskId,
    candidateOid: candidate.candidateOid,
    sourceOid: candidate.sourceOid,
    baseOid: candidate.baseOid,
    publishTargetRef: candidate.policy.publishTargetRef,
    fenceRef: candidate.policy.fenceRef,
    verifierFingerprint: input.verifierFingerprint,
    landedAt: now,
  };
  const receiptOid = await hashObject(
    input.repoRoot,
    `${JSON.stringify(receipt)}\n`,
  );
  const fenceOid = await hashObject(input.repoRoot, createFencePayload(now));
  const receiptRef = resolveReceiptRef(candidate.transactionId);

  const stdin = [
    "start",
    `update ${candidate.policy.publishTargetRef} ${candidate.candidateOid} ${expectedTargetOid}`,
    `update ${candidate.policy.fenceRef} ${fenceOid} ${expectedFenceOid}`,
    `create ${receiptRef} ${receiptOid}`,
    "commit",
    "",
  ].join("\n");

  maybeCrash(input.faultInjection, "atomic_landing", "before");
  try {
    await gitWithStdin(input.repoRoot, ["update-ref", "--stdin"], stdin);
  } catch (error) {
    throw new Error(
      `Fenced Hub landing CAS failed for ${candidate.transactionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  maybeCrash(input.faultInjection, "atomic_landing", "after");

  const state = recordTargetLandedCheckpoint({
    hubProjectDir: input.hubProjectDir,
    candidate,
    verifierFingerprint: input.verifierFingerprint,
    fenceOid,
    receiptRef,
    receiptOid,
    createdAt: now,
  });

  return {
    transactionId: candidate.transactionId,
    candidateOid: candidate.candidateOid,
    publishTargetOid: candidate.candidateOid,
    fenceOid,
    receiptOid,
    receiptRef,
    state,
  };
};

export const cleanupHubLandingCandidate = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly candidate: HubLandingCandidate;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
}): Promise<void> => {
  maybeCrash(input.faultInjection, "cleanup", "before");
  if (existsSync(input.candidate.worktreeDir)) {
    await removeWorktree(input.repoRoot, input.candidate.worktreeDir);
  }
  maybeCrash(input.faultInjection, "cleanup", "after");
  appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "cleaned",
    transactionId: input.candidate.transactionId,
    taskId: input.candidate.taskId,
    createdAt: (input.now ?? new Date()).toISOString(),
    candidateOid: input.candidate.candidateOid,
  });
};

export const recordHubLandingTaskClosed = (input: {
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly candidateOid: string;
  readonly now?: Date;
}): HubLandingTransactionState =>
  appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "task_closed",
    transactionId: input.transactionId,
    taskId: input.taskId,
    createdAt: (input.now ?? new Date()).toISOString(),
    candidateOid: input.candidateOid,
  });

export const closeHubLandingTask = async (input: {
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly candidateOid: string;
  readonly readTaskClose?: HubLandingTaskCloseReader;
  readonly closeTask?: HubLandingTaskCloser;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
}): Promise<HubLandingTransactionState> => {
  const existing = input.readTaskClose?.(input.taskId);
  if (
    !isMatchingHubLandingBeadsClose(existing, {
      transactionId: input.transactionId,
      candidateOid: input.candidateOid,
    })
  ) {
    maybeCrash(input.faultInjection, "task_close", "before");
    await input.closeTask?.({
      taskId: input.taskId,
      transactionId: input.transactionId,
      candidateOid: input.candidateOid,
    });
    maybeCrash(input.faultInjection, "task_close", "after");
  }
  return recordHubLandingTaskClosed({
    hubProjectDir: input.hubProjectDir,
    transactionId: input.transactionId,
    taskId: input.taskId,
    candidateOid: input.candidateOid,
    now: input.now,
  });
};
