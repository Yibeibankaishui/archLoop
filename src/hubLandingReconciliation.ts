import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

import {
  HUB_LANDING_INTEGRITY_INCIDENT,
  cleanupHubLandingCandidate,
  closeHubLandingTask,
  computeHubVerifierParts,
  isMatchingHubLandingBeadsClose,
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
import {
  enqueueHubCheckoutProjection,
} from "./hubCheckoutProjection.js";
import {
  enqueueHubPublicationAfterShipped,
} from "./hubPublication.js";
import {
  isCompletedHubStatus,
  type HubTaskProjection,
} from "./taskBoard.js";
import type { HubTaskEvent } from "./hubExecution.js";
import {
  adoptHubLegacyLandingHistory,
  classifyHubLegacyLandingHistory,
  formatHubLegacyLandingHistoryLines,
  hasHubLegacyLandingHistory,
  type HubLegacyLandingEvidence,
  type HubLegacyLandingTask,
} from "./hubLandingLegacyHistory.js";

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
  readonly legacyHistory?: readonly HubLegacyLandingEvidence[];
}

export interface HubLandingReconciliationOutcome {
  readonly kind: HubLandingReconciliationKind;
  readonly transactions: readonly HubLandingTransactionEvidence[];
  readonly pendingCount: number;
  readonly reconstructedCount: number;
  readonly integrityIncident?: string;
  readonly message: string;
  readonly nextAction: string;
  readonly legacyHistory?: readonly HubLegacyLandingEvidence[];
}

export interface HubLandingReconciliationInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly readTaskClose?: HubLandingTaskCloseReader;
  readonly closeTask?: HubLandingTaskCloser;
  readonly now?: Date;
  readonly faultInjection?: HubLandingFaultInjection;
  readonly tasks?: readonly HubLegacyLandingTask[];
  readonly events?: readonly HubTaskEvent[];
}

const NO_RECOVER_SUFFIX =
  "This is not a task failure and does not require a recovery command.";

const pendingAction =
  "Wait for the automatic retry; Hub will resume from durable landing evidence.";

const integrityAction =
  "Inspect the candidate ref, landing receipt, verification artifact, and journal. Do not land or close the task again automatically.";

export const hubLandingReconciliationHasVisibleOutput = (
  outcome: Pick<HubLandingReconciliationOutcome, "kind" | "legacyHistory">,
): boolean =>
  outcome.kind !== "clean" || hasHubLegacyLandingHistory(outcome.legacyHistory);

export const formatHubLandingReconciliationMessage = (
  inspection:
    | HubLandingReconciliationInspection
    | HubLandingReconciliationOutcome,
): string => {
  const legacyLines = formatHubLegacyLandingHistoryLines(
    inspection.legacyHistory,
  );
  if (legacyLines.length === 0) {
    return inspection.message;
  }
  const primaryLegacyLine = legacyLines[0] ?? inspection.message;
  const replaceWithLegacy =
    inspection.kind === "clean" ||
    inspection.kind === "reconciled" ||
    inspection.message === primaryLegacyLine;
  if (replaceWithLegacy) {
    return primaryLegacyLine;
  }
  return [
    inspection.message,
    ...legacyLines.filter((line) => line !== inspection.message),
  ].join(" ");
};

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
  reconstructedCount = 0,
  legacyHistory: readonly HubLegacyLandingEvidence[] = [],
): {
  readonly kind: HubLandingReconciliationKind;
  readonly pendingCount: number;
  readonly reconstructedCount: number;
  readonly integrityIncident?: string;
  readonly message: string;
  readonly nextAction: string;
  readonly legacyHistory: readonly HubLegacyLandingEvidence[];
} => {
  const incident = transactions.find((entry) => entry.integrityIncident);
  const legacyIncident = legacyHistory.find((entry) => entry.integrityIncident);
  const pendingCount = transactions.filter((entry) => entry.pending).length;
  if (incident?.integrityIncident) {
    return {
      kind: "integrity_incident",
      pendingCount,
      reconstructedCount,
      integrityIncident: incident.integrityIncident,
      message: transactionMessage(incident),
      nextAction: integrityAction,
      legacyHistory,
    };
  }
  if (legacyIncident?.integrityIncident) {
    return {
      kind: "integrity_incident",
      pendingCount,
      reconstructedCount,
      integrityIncident: legacyIncident.integrityIncident,
      message: legacyIncident.message,
      nextAction: legacyIncident.nextAction,
      legacyHistory,
    };
  }
  if (pendingCount > 0) {
    const pending = transactions.find((entry) => entry.pending);
    return {
      kind: "pending",
      pendingCount,
      reconstructedCount,
      message: pending
        ? transactionMessage(pending)
        : `Hub landing reconciliation is pending. ${NO_RECOVER_SUFFIX}`,
      nextAction: pendingAction,
      legacyHistory,
    };
  }
  if (reconstructedCount > 0) {
    return {
      kind: "reconciled",
      pendingCount: 0,
      reconstructedCount,
      message: `Reconstructed ${reconstructedCount} Hub landing checkpoint(s) from durable evidence. ${NO_RECOVER_SUFFIX}`,
      nextAction: pendingAction,
      legacyHistory,
    };
  }
  const acceptedLegacy = legacyHistory.find((entry) => entry.accepted);
  return {
    kind: "clean",
    pendingCount: 0,
    reconstructedCount,
    message: acceptedLegacy
      ? acceptedLegacy.message
      : `No incomplete Hub landing transactions. ${NO_RECOVER_SUFFIX}`,
    nextAction: pendingAction,
    legacyHistory,
  };
};

const inspectionKind = (
  kind: HubLandingReconciliationKind,
): HubLandingReconciliationInspection["kind"] => {
  if (kind === "integrity_incident") {
    return "integrity_incident";
  }
  if (kind === "pending") {
    return "pending";
  }
  return "clean";
};

export const beadsCloseEvidenceFromHubTask = (
  task: Pick<HubTaskProjection, "hubStatus" | "metadata"> | undefined,
): HubLandingBeadsCloseEvidence | undefined => {
  if (!task) {
    return undefined;
  }
  const transactionId = task.metadata.landingTransactionId;
  const candidateOid = task.metadata.landingCandidateOid;
  return {
    closed: isCompletedHubStatus(task.hubStatus) || task.metadata.done === true,
    transactionId: typeof transactionId === "string" ? transactionId : undefined,
    candidateOid: typeof candidateOid === "string" ? candidateOid : undefined,
  };
};

export const hubLandingTaskCloseReaderFromTasks = (
  tasks: readonly Pick<HubTaskProjection, "id" | "hubStatus" | "metadata">[],
): HubLandingTaskCloseReader =>
  (taskId) =>
    beadsCloseEvidenceFromHubTask(
      tasks.find((task) => task.id === taskId),
    );

const listTransactionIdsFromDisk = (hubProjectDir: string): string[] => {
  const dir = resolveHubLandingTransactionsDir(hubProjectDir);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
};

const TRANSACTION_REF_PATTERN =
  /^refs\/archloop\/(?:candidates|receipts)\/(.+)$/;

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
    .map((ref) => ref.match(TRANSACTION_REF_PATTERN)?.[1])
    .filter((value): value is string => value !== undefined);
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

const candidateOidMismatchIncident = (
  source: "journal" | "manifest",
  recordedOid: string | undefined,
  refOid: string | undefined,
): string | undefined => {
  if (!recordedOid || !refOid || recordedOid === refOid) {
    return undefined;
  }
  return `${HUB_LANDING_INTEGRITY_INCIDENT}: ${source} candidate ${recordedOid} does not match ref ${refOid}`;
};

const isPendingReconciliation = (input: {
  readonly integrityIncident?: string;
  readonly evidenceCheckpoint?: HubLandingCheckpoint;
  readonly landed: boolean;
  readonly closed: boolean;
  readonly worktreePresent: boolean;
}): boolean => {
  if (input.integrityIncident) {
    return false;
  }
  if (rankOf(input.evidenceCheckpoint) < rankOf("cleaned")) {
    return true;
  }
  if (input.landed && !input.closed) {
    return true;
  }
  return input.worktreePresent && (input.landed || input.closed);
};

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
  let integrityIncident = candidateOidMismatchIncident(
    "journal",
    journal?.candidateOid,
    refOid,
  );
  if (!integrityIncident) {
    integrityIncident = candidateOidMismatchIncident(
      "manifest",
      manifest?.candidateOid,
      refOid,
    );
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
  const closedFromBeads = isMatchingHubLandingBeadsClose(beadsClose, {
    transactionId: input.transactionId,
    candidateOid: candidateOid ?? storedReceipt?.receipt.candidateOid,
  });
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

  const pending = isPendingReconciliation({
    integrityIncident,
    evidenceCheckpoint,
    landed,
    closed,
    worktreePresent,
  });

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
  const proven = evidence.evidenceCheckpoint;
  if (!proven) {
    return 0;
  }
  const journalRank = rankOf(journal?.checkpoint);
  const provenRank = rankOf(proven);
  const provenCheckpoints: HubLandingCheckpoint[] = ["opened", "base_pinned"];
  if (evidence.candidateOid) {
    provenCheckpoints.push("candidate_created");
  }
  if (evidence.verificationReusable) {
    provenCheckpoints.push("candidate_verified");
  }
  if (evidence.landed) {
    provenCheckpoints.push("target_landed");
  }
  if (evidence.closed) {
    provenCheckpoints.push("task_closed");
  }
  if (evidence.cleaned) {
    provenCheckpoints.push("cleaned");
  }
  const writes = provenCheckpoints.filter(
    (checkpoint) =>
      journalRank < rankOf(checkpoint) && provenRank >= rankOf(checkpoint),
  );
  const now = (input.now ?? new Date()).toISOString();
  const publishTargetOid = evidence.landed
    ? evidence.candidateOid
    : evidence.publishTargetOid;
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
      publishTargetOid,
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

const taskIdsFromTransactions = (
  transactions: readonly HubLandingTransactionEvidence[],
): Set<string> =>
  new Set(
    transactions.flatMap((entry) => (entry.taskId ? [entry.taskId] : [])),
  );

const collectLegacyHistory = (
  input: HubLandingReconciliationInput,
  policy: HubLandingPolicy | undefined,
  transactions: readonly HubLandingTransactionEvidence[],
): readonly HubLegacyLandingEvidence[] => {
  if (!input.tasks || input.tasks.length === 0) {
    return [];
  }
  return classifyHubLegacyLandingHistory({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
    tasks: input.tasks,
    events: input.events,
    policy,
    existingTaskIds: taskIdsFromTransactions(transactions),
  });
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
  const legacyHistory = collectLegacyHistory(input, policy, transactions);
  const summary = summarize(transactions, 0, legacyHistory);
  return {
    kind: inspectionKind(summary.kind),
    transactions,
    pendingCount: summary.pendingCount,
    integrityIncident: summary.integrityIncident,
    message: summary.message,
    nextAction: summary.nextAction,
    legacyHistory,
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
  let legacyHistory: readonly HubLegacyLandingEvidence[] = [];
  if (input.tasks && input.tasks.length > 0) {
    const existingTaskIds = taskIdsFromTransactions(
      listHubLandingTransactionIds(input).map((transactionId) =>
        collectEvidence({
          repoRoot: input.repoRoot,
          hubProjectDir: input.hubProjectDir,
          transactionId,
          policy,
          readTaskClose: input.readTaskClose,
        }),
      ),
    );
    legacyHistory = await adoptHubLegacyLandingHistory({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      tasks: input.tasks,
      events: input.events,
      policy,
      existingTaskIds,
      now: input.now,
      readTaskClose: input.readTaskClose,
      closeTask: input.closeTask,
      faultInjection: input.faultInjection,
    });
  }
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
      return {
        ...summarize([before], 0, legacyHistory),
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
        repoRoot: input.repoRoot,
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
    if (before.landed && before.taskId && before.candidateOid) {
      enqueueHubCheckoutProjection({
        repoRoot: input.repoRoot,
        hubProjectDir: input.hubProjectDir,
        candidate: {
          transactionId,
          taskId: before.taskId,
          policy,
        },
        candidateOid: before.candidateOid,
        now: input.now,
      });
      // Publication stays decoupled from GitHub task sync and does not affect shipped.
      enqueueHubPublicationAfterShipped({
        repoRoot: input.repoRoot,
        hubProjectDir: input.hubProjectDir,
        transactionId,
        taskId: before.taskId,
        candidateOid: before.candidateOid,
        policy,
        now: input.now,
      });
    }
  }

  const after = inspectHubLandingTransactions(input);
  const mergedLegacy = hasHubLegacyLandingHistory(after.legacyHistory)
    ? after.legacyHistory
    : legacyHistory;
  return {
    ...summarize(after.transactions, reconstructedCount, mergedLegacy),
    transactions: after.transactions,
  };
};
