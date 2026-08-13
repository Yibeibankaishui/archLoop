import { execFile } from "node:child_process";
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
  readonly exitCode: number;
  readonly outputHash: string;
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

const resolveCandidateRef = (transactionId: string): string =>
  `refs/archloop/candidates/${transactionId}`;

const resolveReceiptRef = (transactionId: string): string =>
  `refs/archloop/receipts/${transactionId}`;

const resolveWorktreeDir = (
  hubProjectDir: string,
  transactionId: string,
): string =>
  join(hubProjectDir, "landing", "worktrees", transactionId);

const resolveVerificationArtifactPath = (
  hubProjectDir: string,
  transactionId: string,
): string =>
  join(
    resolveHubLandingTransactionDir(hubProjectDir, transactionId),
    "verification.json",
  );

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

export const computeHubVerifierFingerprint = (repoRoot: string): string => {
  const scriptPath = join(repoRoot, ".archloop", "verify.sh");
  const scriptHash = existsSync(scriptPath)
    ? hashBuffer(readFileSync(scriptPath, "utf8"))
    : "no-verify-script";
  return hashBuffer(
    `verify.sh:${scriptHash}\nruntime:${process.version}\nplatform:${process.platform}\n`,
  );
};

export const readHubLandingVerificationArtifact = (
  hubProjectDir: string,
  transactionId: string,
): HubLandingVerificationArtifact | undefined => {
  const path = resolveVerificationArtifactPath(hubProjectDir, transactionId);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof value.candidateOid !== "string" ||
      typeof value.verifierFingerprint !== "string" ||
      typeof value.exitCode !== "number" ||
      typeof value.outputHash !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      return undefined;
    }
    return {
      candidateOid: value.candidateOid,
      verifierFingerprint: value.verifierFingerprint,
      exitCode: value.exitCode,
      outputHash: value.outputHash,
      createdAt: value.createdAt,
    };
  } catch {
    return undefined;
  }
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
  const candidateRef = existing?.candidateRef ?? resolveCandidateRef(transactionId);
  if (
    existing?.candidateOid &&
    existing.candidateRef &&
    (await gitOk(input.repoRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      existing.candidateRef,
    ]))
  ) {
    const candidateOid = await gitText(input.repoRoot, [
      "rev-parse",
      existing.candidateRef,
    ]);
    if (candidateOid === existing.candidateOid) {
      const worktreeDir = resolveWorktreeDir(
        input.hubProjectDir,
        transactionId,
      );
      if (!existsSync(worktreeDir)) {
        mkdirSync(dirname(worktreeDir), { recursive: true });
        await execFileAsync(
          "git",
          ["worktree", "add", "--detach", worktreeDir, candidateOid],
          { cwd: input.repoRoot },
        );
      }
      return {
        transactionId,
        taskId: input.taskId,
        branch: input.branch,
        sourceOid,
        baseOid,
        candidateOid,
        candidateRef: existing.candidateRef,
        worktreeDir,
        policy,
        state: existing,
      };
    }
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
  await execFileAsync("git", ["update-ref", candidateRef, candidateOid], {
    cwd: input.repoRoot,
  });
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

export const bindHubLandingVerification = (input: {
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly candidateOid: string;
  readonly verifierFingerprint: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly now?: Date;
}): HubLandingVerificationArtifact => {
  const now = (input.now ?? new Date()).toISOString();
  const artifact: HubLandingVerificationArtifact = {
    candidateOid: input.candidateOid,
    verifierFingerprint: input.verifierFingerprint,
    exitCode: input.exitCode ?? 0,
    outputHash: hashBuffer(input.output ?? ""),
    createdAt: now,
  };
  const path = resolveVerificationArtifactPath(
    input.hubProjectDir,
    input.transactionId,
  );
  writeAtomicJson(path, artifact);
  appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "candidate_verified",
    transactionId: input.transactionId,
    taskId: input.taskId,
    createdAt: now,
    candidateOid: input.candidateOid,
    verifierFingerprint: input.verifierFingerprint,
    verificationArtifactPath: path,
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

export const commitHubLandingTarget = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly candidate: HubLandingCandidate;
  readonly verifierFingerprint: string;
  readonly now?: Date;
}): Promise<HubLandingCommitResult> => {
  const { candidate } = input;
  assertVerifiedCandidate({
    hubProjectDir: input.hubProjectDir,
    transactionId: candidate.transactionId,
    candidateOid: candidate.candidateOid,
    verifierFingerprint: input.verifierFingerprint,
  });

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

  try {
    await gitWithStdin(input.repoRoot, ["update-ref", "--stdin"], stdin);
  } catch (error) {
    throw new Error(
      `Fenced Hub landing CAS failed for ${candidate.transactionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const state = appendHubLandingCheckpoint(input.hubProjectDir, {
    type: "checkpoint",
    checkpoint: "target_landed",
    transactionId: candidate.transactionId,
    taskId: candidate.taskId,
    createdAt: now,
    sourceOid: candidate.sourceOid,
    baseOid: candidate.baseOid,
    candidateOid: candidate.candidateOid,
    candidateRef: candidate.candidateRef,
    verifierFingerprint: input.verifierFingerprint,
    publishTargetOid: candidate.candidateOid,
    fenceOid,
    receiptRef,
    receiptOid,
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
}): Promise<void> => {
  await removeWorktree(input.repoRoot, input.candidate.worktreeDir);
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
