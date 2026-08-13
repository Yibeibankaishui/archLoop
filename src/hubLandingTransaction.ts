import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const HUB_LANDING_CHECKPOINTS = [
  "opened",
  "base_pinned",
  "candidate_created",
  "candidate_verified",
  "target_landed",
  "task_closed",
  "cleaned",
] as const;

export type HubLandingCheckpoint = (typeof HUB_LANDING_CHECKPOINTS)[number];

export interface HubLandingTransactionRecord {
  readonly type: "checkpoint";
  readonly checkpoint: HubLandingCheckpoint;
  readonly transactionId: string;
  readonly taskId: string;
  readonly createdAt: string;
  readonly sourceOid?: string;
  readonly baseOid?: string;
  readonly candidateOid?: string;
  readonly candidateRef?: string;
  readonly verifierFingerprint?: string;
  readonly verificationArtifactPath?: string;
  readonly publishTargetOid?: string;
  readonly fenceOid?: string;
  readonly receiptRef?: string;
  readonly receiptOid?: string;
}

export interface HubLandingTransactionState {
  readonly transactionId: string;
  readonly taskId: string;
  readonly checkpoint: HubLandingCheckpoint;
  readonly records: readonly HubLandingTransactionRecord[];
  readonly sourceOid?: string;
  readonly baseOid?: string;
  readonly candidateOid?: string;
  readonly candidateRef?: string;
  readonly verifierFingerprint?: string;
  readonly verificationArtifactPath?: string;
  readonly publishTargetOid?: string;
  readonly fenceOid?: string;
  readonly receiptRef?: string;
  readonly receiptOid?: string;
  readonly openedAt: string;
  readonly updatedAt: string;
}

export interface HubLandingShippedProof {
  readonly shipped: boolean;
  readonly reason: string;
  readonly transactionId?: string;
  readonly candidateOid?: string;
  readonly publishTargetOid?: string;
}

const CHECKPOINT_RANK = new Map(
  HUB_LANDING_CHECKPOINTS.map((checkpoint, index) => [checkpoint, index]),
);

const GIT_OID_PATTERN = /^[0-9a-f]{40}$/i;

export const isGitOid = (value: string | undefined): value is string =>
  typeof value === "string" && GIT_OID_PATTERN.test(value);

const isCheckpoint = (value: unknown): value is HubLandingCheckpoint =>
  typeof value === "string" &&
  (HUB_LANDING_CHECKPOINTS as readonly string[]).includes(value);

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

const fsyncFd = (fd: number): void => {
  fsyncSync(fd);
};

export const resolveHubLandingTransactionsDir = (
  hubProjectDir: string,
): string => join(hubProjectDir, "landing", "transactions");

export const resolveHubLandingTransactionId = (input: {
  readonly taskId: string;
  readonly sourceOid: string;
  readonly baseOid: string;
}): string => {
  const digest = createHash("sha256")
    .update(`${input.taskId}\0${input.sourceOid}\0${input.baseOid}`)
    .digest("hex")
    .slice(0, 16);
  const safeTaskId = input.taskId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `ltx-${safeTaskId}-${digest}`;
};

export const resolveHubLandingTransactionDir = (
  hubProjectDir: string,
  transactionId: string,
): string => join(resolveHubLandingTransactionsDir(hubProjectDir), transactionId);

export const resolveHubLandingJournalPath = (
  hubProjectDir: string,
  transactionId: string,
): string =>
  join(resolveHubLandingTransactionDir(hubProjectDir, transactionId), "journal.jsonl");

export const parseHubLandingTransactionRecord = (
  value: unknown,
): HubLandingTransactionRecord | undefined => {
  const record = readObject(value);
  if (record.type !== "checkpoint") {
    return undefined;
  }
  const checkpoint = record.checkpoint;
  const transactionId = readString(record, "transactionId");
  const taskId = readString(record, "taskId");
  const createdAt = readString(record, "createdAt");
  if (!isCheckpoint(checkpoint) || !transactionId || !taskId || !createdAt) {
    return undefined;
  }
  const sourceOid = readString(record, "sourceOid");
  const baseOid = readString(record, "baseOid");
  const candidateOid = readString(record, "candidateOid");
  const publishTargetOid = readString(record, "publishTargetOid");
  const fenceOid = readString(record, "fenceOid");
  const receiptOid = readString(record, "receiptOid");
  for (const oid of [
    sourceOid,
    baseOid,
    candidateOid,
    publishTargetOid,
    fenceOid,
    receiptOid,
  ]) {
    if (oid !== undefined && !isGitOid(oid)) {
      return undefined;
    }
  }
  return {
    type: "checkpoint",
    checkpoint,
    transactionId,
    taskId,
    createdAt,
    sourceOid,
    baseOid,
    candidateOid,
    candidateRef: readString(record, "candidateRef"),
    verifierFingerprint: readString(record, "verifierFingerprint"),
    verificationArtifactPath: readString(record, "verificationArtifactPath"),
    publishTargetOid,
    fenceOid,
    receiptRef: readString(record, "receiptRef"),
    receiptOid,
  };
};

export const reduceHubLandingTransaction = (
  records: readonly HubLandingTransactionRecord[],
): HubLandingTransactionState | undefined => {
  const valid = records.filter((record, index, list) => {
    if (index === 0) {
      return true;
    }
    return record.transactionId === list[0]?.transactionId;
  });
  if (valid.length === 0) {
    return undefined;
  }
  let state: HubLandingTransactionState = {
    transactionId: valid[0]!.transactionId,
    taskId: valid[0]!.taskId,
    checkpoint: valid[0]!.checkpoint,
    records: valid,
    sourceOid: valid[0]!.sourceOid,
    baseOid: valid[0]!.baseOid,
    candidateOid: valid[0]!.candidateOid,
    candidateRef: valid[0]!.candidateRef,
    verifierFingerprint: valid[0]!.verifierFingerprint,
    verificationArtifactPath: valid[0]!.verificationArtifactPath,
    publishTargetOid: valid[0]!.publishTargetOid,
    fenceOid: valid[0]!.fenceOid,
    receiptRef: valid[0]!.receiptRef,
    receiptOid: valid[0]!.receiptOid,
    openedAt: valid[0]!.createdAt,
    updatedAt: valid[0]!.createdAt,
  };
  for (const record of valid.slice(1)) {
    const currentRank = CHECKPOINT_RANK.get(state.checkpoint) ?? -1;
    const nextRank = CHECKPOINT_RANK.get(record.checkpoint) ?? -1;
    state = {
      ...state,
      checkpoint: nextRank >= currentRank ? record.checkpoint : state.checkpoint,
      sourceOid: record.sourceOid ?? state.sourceOid,
      baseOid: record.baseOid ?? state.baseOid,
      candidateOid: record.candidateOid ?? state.candidateOid,
      candidateRef: record.candidateRef ?? state.candidateRef,
      verifierFingerprint:
        record.verifierFingerprint ?? state.verifierFingerprint,
      verificationArtifactPath:
        record.verificationArtifactPath ?? state.verificationArtifactPath,
      publishTargetOid: record.publishTargetOid ?? state.publishTargetOid,
      fenceOid: record.fenceOid ?? state.fenceOid,
      receiptRef: record.receiptRef ?? state.receiptRef,
      receiptOid: record.receiptOid ?? state.receiptOid,
      updatedAt: record.createdAt,
    };
  }
  return state;
};

export const readHubLandingJournal = (
  hubProjectDir: string,
  transactionId: string,
): readonly HubLandingTransactionRecord[] => {
  const path = resolveHubLandingJournalPath(hubProjectDir, transactionId);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = parseHubLandingTransactionRecord(JSON.parse(line));
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
};

export const loadHubLandingTransaction = (
  hubProjectDir: string,
  transactionId: string,
): HubLandingTransactionState | undefined =>
  reduceHubLandingTransaction(readHubLandingJournal(hubProjectDir, transactionId));

export const appendHubLandingCheckpoint = (
  hubProjectDir: string,
  record: HubLandingTransactionRecord,
): HubLandingTransactionState => {
  const path = resolveHubLandingJournalPath(
    hubProjectDir,
    record.transactionId,
  );
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    fsyncFd(fd);
  } finally {
    closeSync(fd);
  }
  const state = reduceHubLandingTransaction(
    readHubLandingJournal(hubProjectDir, record.transactionId),
  );
  if (!state) {
    throw new Error(
      `Failed to reduce Hub landing journal for ${record.transactionId}`,
    );
  }
  return state;
};

export const deriveHubLandingShipped = (input: {
  readonly publishPolicy: "off" | "best_effort" | "required";
  readonly taskClosed: boolean;
  readonly transactionId?: string;
  readonly closedTransactionId?: string;
  readonly candidateOid?: string;
  readonly closedCandidateOid?: string;
  readonly publishTargetOid?: string;
}): HubLandingShippedProof => {
  if (input.publishPolicy === "required") {
    return {
      shipped: false,
      reason: "required_publication_not_in_scope",
      transactionId: input.transactionId,
      candidateOid: input.candidateOid,
      publishTargetOid: input.publishTargetOid,
    };
  }
  if (!input.taskClosed) {
    return {
      shipped: false,
      reason: "task_not_closed",
      transactionId: input.transactionId,
      candidateOid: input.candidateOid,
      publishTargetOid: input.publishTargetOid,
    };
  }
  if (
    !input.transactionId ||
    input.closedTransactionId !== input.transactionId
  ) {
    return {
      shipped: false,
      reason: "transaction_metadata_mismatch",
      transactionId: input.transactionId,
      candidateOid: input.candidateOid,
      publishTargetOid: input.publishTargetOid,
    };
  }
  if (!isGitOid(input.candidateOid)) {
    return {
      shipped: false,
      reason: "missing_candidate_oid",
      transactionId: input.transactionId,
      publishTargetOid: input.publishTargetOid,
    };
  }
  if (input.closedCandidateOid !== input.candidateOid) {
    return {
      shipped: false,
      reason: "candidate_metadata_mismatch",
      transactionId: input.transactionId,
      candidateOid: input.candidateOid,
      publishTargetOid: input.publishTargetOid,
    };
  }
  if (input.publishTargetOid !== input.candidateOid) {
    return {
      shipped: false,
      reason: "publish_target_does_not_contain_candidate",
      transactionId: input.transactionId,
      candidateOid: input.candidateOid,
      publishTargetOid: input.publishTargetOid,
    };
  }
  return {
    shipped: true,
    reason: "verified_landing_and_matching_closure",
    transactionId: input.transactionId,
    candidateOid: input.candidateOid,
    publishTargetOid: input.publishTargetOid,
  };
};
