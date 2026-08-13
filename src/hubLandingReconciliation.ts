import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

import {
  HUB_LANDING_INTEGRITY_INCIDENT,
  cleanupHubLandingCandidate,
  closeHubLandingTask,
  computeHubVerifierParts,
  isReusableHubLandingVerificationArtifact,
  readHubLandingCandidateManifest,
  readHubLandingReceipt,
  readHubLandingVerificationArtifact,
  resolveHubLandingCandidateRef,
  resolveHubLandingReceiptRef,
  resolveHubLandingWorktreeDir,
  type HubLandingBeadsCloseEvidence,
  type HubLandingCandidate,
  type HubLandingFaultInjection,
  type HubLandingTaskCloseReader,
  type HubLandingTaskCloser,
} from "./hubLanding.js";
import {
  ensureHubLandingPolicy,
  readHubLandingPolicy,
  type HubLandingPolicy,
} from "./hubLandingPolicy.js";
import {
  HUB_LANDING_CHECKPOINTS,
  appendHubLandingCheckpoint,
  loadHubLandingTransaction,
  resolveHubLandingTransactionsDir,
  type HubLandingCheckpoint,
  type HubLandingTransactionState,
} from "./hubLandingTransaction.js";

const CHECKPOINT_RANK = new Map(
  HUB_LANDING_CHECKPOINTS.map((checkpoint, index) => [checkpoint, index]),
);

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});

const tryGitText = (
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

const gitOk = (cwd: string, args: readonly string[]): boolean =>
  tryGitText(cwd, args) !== undefined;

const rankOf = (checkpoint: HubLandingCheckpoint | undefined): number =>
  checkpoint === undefined ? -1 : (CHECKPOINT_RANK.get(checkpoint) ?? -1);

const maxCheckpoint = (
  ...checkpoints: ReadonlyArray<HubLandingCheckpoint | undefined>
): HubLandingCheckpoint | undefined =>
  checkpoints.reduce<HubLandingCheckpoint | undefined>((highest, next) => {
    if (next === undefined) {
      return highest;
    }
    if (highest === undefined || rankOf(next) > rankOf(highest)) {
      return next;
    }
    return highest;
  }, undefined);

export type HubLandingReconciliationKind =
  | "clean"
  | "pending"
  | "reconciled"
  | "integrity_incident";

export interface HubLandingTransactionEvidence {
  readonly transactionId: string;
  readonly taskId?: string;
  readonly journalCheckpoint?: HubLandingCheckpoint;
  readonly evidenceCheckpoint?: HubLandingCheckpoint;
  readonly sourceOid?: string;
  readonly baseOid?: string;
  readonly candidateOid?: string;
  readonly candidateRef?: string;
  readonly verifierFingerprint?: string;
  readonly verificationReusable: boolean;
  readonly landed: boolean;
  readonly closed: boolean;
  readonly cleaned: boolean;
  readonly worktreePresent: boolean;
  readonly receiptOid?: string;
  readonly publishTargetOid?: string;
  readonly integrityIncident?: string;
  readonly pending: boolean;
  readonly nextAction: string;
}

export interface HubLandingReconciliationInspection {
  readonly kind: Exclude<HubLandingReconciliationKind, "reconciled">;
  readonly transactions: readonly HubLandingTransactionEvidence[];
  readonly pendingCount: number;
  readonly integrityIncident?: string;
  readonly message: string;
  readonly nextAction: string;
}

export interface HubLandingReconciliationOutcome {
  readonly kind: HubLandingReconciliationKind;
  readonly transactions: readonly HubLandingTransactionEvidence[];
  readonly pendingCount: number;
  readonly reconstructedCount: number;
  readonly integrityIncident?: string;
  readonly message: string;
  readonly nextAction: string;
}

export interface HubLandingReconciliationInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly readTaskClose?: HubLandingTaskCloseReader;
  readonly closeTask?: HubLandingTaskCloser;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
}

const NO_RECOVER_SUFFIX =
  "This is not a task failure and does not require a recovery command.";

const pendingAction =
  "Wait for the automatic retry; Hub will resume from durable landing evidence.";

const integrityAction =
  "Inspect the candidate ref, landing receipt, verification artifact, and journal. Do not land or close the task again automatically.";

export const formatHubLandingReconciliationMessage = (
  inspection:
    | HubLandingReconciliationInspection
    | HubLandingReconciliationOutcome,
): string => inspection.message;

const transactionMessage = (
  evidence: HubLandingTransactionEvidence,
): string => {
  if (evidence.integrityIncident) {
    return `Hub landing integrity incident for ${evidence.transactionId}: ${evidence.integrityIncident} ${NO_RECOVER_SUFFIX}`;
  }
  if (evidence.pending) {
    return `Hub landing transaction ${evidence.transactionId} is pending reconciliation at ${evidence.evidenceCheckpoint ?? evidence.journalCheckpoint ?? "opened"}. Automatic retry will resume from durable evidence. ${NO_RECOVER_SUFFIX}`;
  }
  return `Hub landing transaction ${evidence.transactionId} is complete.`;
};

const summarize = (
  transactions: readonly HubLandingTransactionEvidence[],
  kind: HubLandingReconciliationKind,
  reconstructedCount = 0,
): {
  readonly kind: HubLandingReconciliationKind;
  readonly pendingCount: number;
  readonly reconstructedCount: number;
  readonly integrityIncident?: string;
  readonly message: string;
  readonly nextAction: string;
} => {
  const incident = transactions.find((entry) => entry.integrityIncident);
  const pendingCount = transactions.filter((entry) => entry.pending).length;
  if (incident?.integrityIncident) {
    return {
      kind: "integrity_incident",
      pendingCount,
      reconstructedCount,
      integrityIncident: incident.integrityIncident,
      message: transactionMessage(incident),
      nextAction: integrityAction,
    };
  }
  if (pendingCount > 0 || kind === "pending") {
    const pending = transactions.find((entry) => entry.pending);
    return {
      kind: kind === "reconciled" ? "reconciled" : "pending",
      pendingCount,
      reconstructedCount,
      message: pending
        ? transactionMessage(pending)
        : `Hub landing reconciliation is pending. ${NO_RECOVER_SUFFIX}`,
      nextAction: pendingAction,
    };
  }
  if (kind === "reconciled" && reconstructedCount > 0) {
    return {
      kind: "reconciled",
      pendingCount: 0,
      reconstructedCount,
      message: `Reconstructed ${reconstructedCount} Hub landing checkpoint(s) from durable evidence. ${NO_RECOVER_SUFFIX}`,
      nextAction: pendingAction,
    };
  }
  return {
    kind: "clean",
    pendingCount: 0,
    reconstructedCount,
    message: `No incomplete Hub landing transactions. ${NO_RECOVER_SUFFIX}`,
    nextAction: pendingAction,
  };
};

const listTransactionIdsFromDisk = (hubProjectDir: string): string[] => {
  const dir = resolveHubLandingTransactionsDir(hubProjectDir);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
};

const listTransactionIdsFromRefs = (repoRoot: string): string[] => {
  const output = tryGitText(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/archloop/candidates/",
    "refs/archloop/receipts/",
  ]);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((ref) => {
      const candidate = ref.match(/^refs\/archloop\/candidates\/(.+)$/);
      if (candidate?.[1]) {
        return candidate[1];
      }
      const receipt = ref.match(/^refs\/archloop\/receipts\/(.+)$/);
      return receipt?.[1];
    })
    .filter((value): value is string => typeof value === "string");
};

export const listHubLandingTransactionIds = (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
}): readonly string[] => {
  const ids = new Set([
    ...listTransactionIdsFromDisk(input.hubProjectDir),
    ...listTransactionIdsFromRefs(input.repoRoot),
  ]);
  return [...ids].sort();
};

const matchingBeadsClose = (
  evidence: HubLandingBeadsCloseEvidence | undefined,
  transactionId: string,
  candidateOid: string | undefined,
): boolean =>
  evidence?.closed === true &&
  evidence.transactionId === transactionId &&
  candidateOid !== undefined &&
  evidence.candidateOid === candidateOid;

const collectEvidence = (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly policy?: HubLandingPolicy;
  readonly readTaskClose?: HubLandingTaskCloseReader;
}): HubLandingTransactionEvidence => {
  const journal = loadHubLandingTransaction(
    input.hubProjectDir,
    input.transactionId,
  );
  const manifest = readHubLandingCandidateManifest(
    input.hubProjectDir,
    input.transactionId,
  );
  const candidateRef =
    journal?.candidateRef ??
    manifest?.candidateRef ??
    resolveHubLandingCandidateRef(input.transactionId);
  const refOid = tryGitText(input.repoRoot, ["rev-parse", candidateRef]);
  const candidateOid = refOid ?? manifest?.candidateOid ?? journal?.candidateOid;
  let integrityIncident: string | undefined;
  if (journal?.candidateOid && refOid && journal.candidateOid !== refOid) {
    integrityIncident = `${HUB_LANDING_INTEGRITY_INCIDENT}: journal candidate ${journal.candidateOid} does not match ref ${refOid}`;
  } else if (
    manifest?.candidateOid &&
    refOid &&
    manifest.candidateOid !== refOid
  ) {
    integrityIncident = `${HUB_LANDING_INTEGRITY_INCIDENT}: manifest candidate ${manifest.candidateOid} does not match ref ${refOid}`;
  }

  const verifierParts = computeHubVerifierParts(input.repoRoot);
  const artifact = readHubLandingVerificationArtifact(
    input.hubProjectDir,
    input.transactionId,
  );
  const verificationReusable =
    candidateOid !== undefined &&
    artifact !== undefined &&
    isReusableHubLandingVerificationArtifact({
      artifact,
      candidateOid,
      verifierFingerprint: verifierParts.verifierFingerprint,
      verifierConfigHash: verifierParts.verifierConfigHash,
      runtimeFingerprint: verifierParts.runtimeFingerprint,
    });

  const storedReceipt = readHubLandingReceipt(
    input.repoRoot,
    input.transactionId,
  );
  if (
    storedReceipt &&
    candidateOid &&
    storedReceipt.receipt.candidateOid !== candidateOid
  ) {
    integrityIncident = `${HUB_LANDING_INTEGRITY_INCIDENT}: receipt candidate ${storedReceipt.receipt.candidateOid} does not match ${candidateOid}`;
  }

  const publishTargetOid = input.policy
    ? tryGitText(input.repoRoot, ["rev-parse", input.policy.publishTargetRef])
    : undefined;
  const candidateInTarget =
    candidateOid !== undefined &&
    publishTargetOid !== undefined &&
    (publishTargetOid === candidateOid ||
      gitOk(input.repoRoot, [
        "merge-base",
        "--is-ancestor",
        candidateOid,
        publishTargetOid,
      ]));
  if (storedReceipt && !candidateInTarget) {
    integrityIncident = `${HUB_LANDING_INTEGRITY_INCIDENT}: landing receipt exists but the Hub publish target no longer contains candidate ${storedReceipt.receipt.candidateOid}`;
  }
  const landed =
    storedReceipt !== undefined &&
    candidateInTarget &&
    integrityIncident === undefined;

  const taskId = journal?.taskId ?? manifest?.taskId ?? storedReceipt?.receipt.taskId;
  const beadsClose = taskId ? input.readTaskClose?.(taskId) : undefined;
  const closedFromBeads = matchingBeadsClose(
    beadsClose,
    input.transactionId,
    candidateOid ?? storedReceipt?.receipt.candidateOid,
  );
  const closedFromJournal =
    input.readTaskClose === undefined &&
    rankOf(journal?.checkpoint) >= rankOf("task_closed");
  const closed = closedFromBeads || closedFromJournal;
  const worktreePresent = existsSync(
    resolveHubLandingWorktreeDir(input.hubProjectDir, input.transactionId),
  );
  const cleaned =
    !worktreePresent &&
    (landed || closed || journal?.checkpoint === "cleaned");

  const evidenceCheckpoint = maxCheckpoint(
    journal?.checkpoint,
    candidateOid ? "candidate_created" : undefined,
    verificationReusable ? "candidate_verified" : undefined,
    landed ? "target_landed" : undefined,
    closed ? "task_closed" : undefined,
    cleaned ? "cleaned" : undefined,
  );

  const pending =
    integrityIncident === undefined &&
    (rankOf(evidenceCheckpoint) < rankOf("cleaned") ||
      (landed && !closed) ||
      (worktreePresent && (landed || closed)));

  return {
    transactionId: input.transactionId,
    taskId,
    journalCheckpoint: journal?.checkpoint,
    evidenceCheckpoint,
    sourceOid: journal?.sourceOid ?? manifest?.sourceOid,
    baseOid: journal?.baseOid ?? manifest?.baseOid,
    candidateOid,
    candidateRef,
    verifierFingerprint: verificationReusable
      ? verifierParts.verifierFingerprint
      : journal?.verifierFingerprint,
    verificationReusable,
    landed,
    closed,
    cleaned,
    worktreePresent,
    receiptOid: storedReceipt?.oid,
    publishTargetOid,
    integrityIncident,
    pending,
    nextAction: integrityIncident ? integrityAction : pendingAction,
  };
};

const reconstructCheckpoints = (
  input: HubLandingReconciliationInput,
  evidence: HubLandingTransactionEvidence,
  journal: HubLandingTransactionState | undefined,
): number => {
  if (evidence.integrityIncident || !evidence.taskId) {
    return 0;
  }
  const now = (input.now ?? new Date()).toISOString();
  const writes: HubLandingCheckpoint[] = [];
  const proven = evidence.evidenceCheckpoint;
  if (!proven) {
    return 0;
  }
  const ensure = (checkpoint: HubLandingCheckpoint): void => {
    if (rankOf(journal?.checkpoint) >= rankOf(checkpoint)) {
      return;
    }
    if (rankOf(proven) < rankOf(checkpoint)) {
      return;
    }
    writes.push(checkpoint);
  };
  ensure("opened");
  ensure("base_pinned");
  if (evidence.candidateOid) {
    ensure("candidate_created");
  }
  if (evidence.verificationReusable) {
    ensure("candidate_verified");
  }
  if (evidence.landed) {
    ensure("target_landed");
  }
  if (evidence.closed) {
    ensure("task_closed");
  }
  if (evidence.cleaned) {
    ensure("cleaned");
  }

  for (const checkpoint of writes) {
    appendHubLandingCheckpoint(input.hubProjectDir, {
      type: "checkpoint",
      checkpoint,
      transactionId: evidence.transactionId,
      taskId: evidence.taskId,
      createdAt: now,
      sourceOid: evidence.sourceOid,
      baseOid: evidence.baseOid,
      candidateOid: evidence.candidateOid,
      candidateRef: evidence.candidateRef,
      verifierFingerprint: evidence.verifierFingerprint,
      publishTargetOid: evidence.landed
        ? evidence.candidateOid
        : evidence.publishTargetOid,
      receiptRef: evidence.receiptOid
        ? resolveHubLandingReceiptRef(evidence.transactionId)
        : undefined,
      receiptOid: evidence.receiptOid,
    });
  }
  return writes.length;
};

const toCandidate = (input: {
  readonly evidence: HubLandingTransactionEvidence;
  readonly policy: HubLandingPolicy;
  readonly hubProjectDir: string;
  readonly journal?: HubLandingTransactionState;
}): HubLandingCandidate | undefined => {
  const { evidence } = input;
  if (!evidence.taskId || !evidence.candidateOid || !evidence.candidateRef) {
    return undefined;
  }
  return {
    transactionId: evidence.transactionId,
    taskId: evidence.taskId,
    branch: "",
    sourceOid: evidence.sourceOid ?? "",
    baseOid: evidence.baseOid ?? "",
    candidateOid: evidence.candidateOid,
    candidateRef: evidence.candidateRef,
    worktreeDir: resolveHubLandingWorktreeDir(
      input.hubProjectDir,
      evidence.transactionId,
    ),
    policy: input.policy,
    state:
      input.journal ??
      ({
        transactionId: evidence.transactionId,
        taskId: evidence.taskId,
        checkpoint: evidence.evidenceCheckpoint ?? "opened",
        records: [],
        openedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } satisfies HubLandingTransactionState),
  };
};

export const inspectHubLandingTransactions = (
  input: HubLandingReconciliationInput,
): HubLandingReconciliationInspection => {
  const policy = readHubLandingPolicy(input.hubProjectDir);
  const ids = listHubLandingTransactionIds(input);
  const transactions = ids.map((transactionId) =>
    collectEvidence({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      transactionId,
      policy,
      readTaskClose: input.readTaskClose,
    }),
  );
  const summary = summarize(transactions, "clean");
  const kind =
    summary.kind === "integrity_incident"
      ? "integrity_incident"
      : summary.pendingCount > 0
        ? "pending"
        : "clean";
  return {
    kind,
    transactions,
    pendingCount: summary.pendingCount,
    integrityIncident: summary.integrityIncident,
    message: summary.message,
    nextAction: summary.nextAction,
  };
};

export const reconcileHubLandingTransactions = async (
  input: HubLandingReconciliationInput,
): Promise<HubLandingReconciliationOutcome> => {
  const policy = ensureHubLandingPolicy({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
    now: input.now,
  }).policy;
  const ids = listHubLandingTransactionIds(input);
  let reconstructedCount = 0;
  for (const transactionId of ids) {
    const before = collectEvidence({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      transactionId,
      policy,
      readTaskClose: input.readTaskClose,
    });
    if (before.integrityIncident) {
      const summary = summarize([before], "integrity_incident");
      return {
        ...summary,
        transactions: [before],
      };
    }
    const journal = loadHubLandingTransaction(
      input.hubProjectDir,
      transactionId,
    );
    reconstructedCount += reconstructCheckpoints(input, before, journal);

    if (
      before.landed &&
      !before.closed &&
      before.taskId &&
      before.candidateOid
    ) {
      await closeHubLandingTask({
        hubProjectDir: input.hubProjectDir,
        transactionId,
        taskId: before.taskId,
        candidateOid: before.candidateOid,
        readTaskClose: input.readTaskClose,
        closeTask: input.closeTask,
        now: input.now,
        faultInjection: input.faultInjection,
      });
    }

    const candidate = toCandidate({
      evidence: before,
      policy,
      hubProjectDir: input.hubProjectDir,
      journal,
    });
    if (candidate && before.worktreePresent && (before.landed || before.closed)) {
      await cleanupHubLandingCandidate({
        repoRoot: input.repoRoot,
        hubProjectDir: input.hubProjectDir,
        candidate,
        now: input.now,
        faultInjection: input.faultInjection,
      });
    }
  }

  const after = inspectHubLandingTransactions(input);
  const kind: HubLandingReconciliationKind = after.integrityIncident
    ? "integrity_incident"
    : reconstructedCount > 0 || after.pendingCount > 0
      ? after.pendingCount > 0
        ? "pending"
        : "reconciled"
      : "clean";
  const summary = summarize(after.transactions, kind, reconstructedCount);
  return {
    ...summary,
    transactions: after.transactions,
  };
};
