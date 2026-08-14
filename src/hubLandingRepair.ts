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

export const HUB_LANDING_REPAIR_BUDGET = 2 as const;

export type HubLandingRepairKind = "merge_conflict" | "verification";

export interface HubLandingRepairAttempt {
  readonly type: "repair_attempt";
  readonly kind: HubLandingRepairKind;
  readonly taskId: string;
  readonly sourceOid: string;
  readonly fingerprint: string;
  readonly attempt: number;
  readonly createdAt: string;
  readonly candidateOid?: string;
  readonly candidateGeneration?: number;
}

export interface HubLandingRepairBudgetState {
  readonly taskId: string;
  readonly sourceOid: string;
  readonly attempts: readonly HubLandingRepairAttempt[];
  readonly mergeConflictAttempts: number;
  readonly verificationAttempts: number;
}

export const computeHubLandingMergeInputFingerprint = (input: {
  readonly sourceOid: string;
  readonly baseOid: string;
}): string =>
  createHash("sha256")
    .update(`${input.sourceOid}\0${input.baseOid}`)
    .digest("hex");

export const resolveHubLandingRepairBudgetPath = (
  hubProjectDir: string,
  taskId: string,
  sourceOid: string,
): string => {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return join(
    hubProjectDir,
    "landing",
    "repair-budgets",
    `${safeTaskId}-${sourceOid}.jsonl`,
  );
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

const parseRepairAttempt = (
  value: unknown,
): HubLandingRepairAttempt | undefined => {
  const record = readObject(value);
  if (record.type !== "repair_attempt") {
    return undefined;
  }
  const kind = readString(record, "kind");
  const taskId = readString(record, "taskId");
  const sourceOid = readString(record, "sourceOid");
  const fingerprint = readString(record, "fingerprint");
  const createdAt = readString(record, "createdAt");
  const attempt =
    typeof record.attempt === "number" && Number.isInteger(record.attempt)
      ? record.attempt
      : undefined;
  if (
    (kind !== "merge_conflict" && kind !== "verification") ||
    !taskId ||
    !sourceOid ||
    !fingerprint ||
    !createdAt ||
    attempt === undefined
  ) {
    return undefined;
  }
  const candidateGeneration =
    typeof record.candidateGeneration === "number" &&
    Number.isInteger(record.candidateGeneration)
      ? record.candidateGeneration
      : undefined;
  return {
    type: "repair_attempt",
    kind,
    taskId,
    sourceOid,
    fingerprint,
    attempt,
    createdAt,
    candidateOid: readString(record, "candidateOid"),
    candidateGeneration,
  };
};

export const readHubLandingRepairAttempts = (
  hubProjectDir: string,
  taskId: string,
  sourceOid: string,
): readonly HubLandingRepairAttempt[] => {
  const path = resolveHubLandingRepairBudgetPath(
    hubProjectDir,
    taskId,
    sourceOid,
  );
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = parseRepairAttempt(JSON.parse(line));
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
};

const countRepairAttempts = (
  attempts: readonly HubLandingRepairAttempt[],
  kind: HubLandingRepairKind,
  fingerprint?: string,
): number =>
  attempts.filter(
    (attempt) =>
      attempt.kind === kind &&
      (fingerprint === undefined || attempt.fingerprint === fingerprint),
  ).length;

const usedAttemptsForKind = (
  budget: HubLandingRepairBudgetState,
  kind: HubLandingRepairKind,
): number =>
  kind === "merge_conflict"
    ? budget.mergeConflictAttempts
    : budget.verificationAttempts;

const remainingFromUsed = (used: number): number =>
  Math.max(0, HUB_LANDING_REPAIR_BUDGET - used);

export const loadHubLandingRepairBudget = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly sourceOid: string;
}): HubLandingRepairBudgetState => {
  const attempts = readHubLandingRepairAttempts(
    input.hubProjectDir,
    input.taskId,
    input.sourceOid,
  );
  return {
    taskId: input.taskId,
    sourceOid: input.sourceOid,
    attempts,
    mergeConflictAttempts: countRepairAttempts(attempts, "merge_conflict"),
    verificationAttempts: countRepairAttempts(attempts, "verification"),
  };
};

export const remainingHubLandingRepairAttempts = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly sourceOid: string;
  readonly kind: HubLandingRepairKind;
  readonly fingerprint?: string;
}): number => {
  const budget = loadHubLandingRepairBudget(input);
  const remaining = remainingFromUsed(usedAttemptsForKind(budget, input.kind));
  if (!input.fingerprint) {
    return remaining;
  }
  return Math.min(
    remaining,
    remainingFromUsed(
      countRepairAttempts(budget.attempts, input.kind, input.fingerprint),
    ),
  );
};

export const recordHubLandingRepairAttempt = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly sourceOid: string;
  readonly kind: HubLandingRepairKind;
  readonly fingerprint: string;
  readonly candidateOid?: string;
  readonly candidateGeneration?: number;
  readonly now?: Date;
}): HubLandingRepairBudgetState => {
  const current = loadHubLandingRepairBudget(input);
  const attempt: HubLandingRepairAttempt = {
    type: "repair_attempt",
    kind: input.kind,
    taskId: input.taskId,
    sourceOid: input.sourceOid,
    fingerprint: input.fingerprint,
    attempt: usedAttemptsForKind(current, input.kind) + 1,
    createdAt: (input.now ?? new Date()).toISOString(),
    candidateOid: input.candidateOid,
    candidateGeneration: input.candidateGeneration,
  };
  const path = resolveHubLandingRepairBudgetPath(
    input.hubProjectDir,
    input.taskId,
    input.sourceOid,
  );
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, Buffer.from(`${JSON.stringify(attempt)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return loadHubLandingRepairBudget(input);
};

const TRANSIENT_ERROR_PATTERN =
  /index\.lock|\/.*?\.lock\b|unable to create.*lock|cannot lock ref|resource temporarily unavailable|eagain|ebusy|enospc|input\/output error|\beio\b|etxtbsy|emfile|enfile/i;

const TRANSIENT_NODE_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "ELOCKED",
  "ETXTBSY",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EIO",
]);

export const isTransientHubLandingError = (error: unknown): boolean => {
  if (!error) {
    return false;
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = record.code;
    if (typeof code === "string" && TRANSIENT_NODE_CODES.has(code)) {
      return true;
    }
    const message = [
      error instanceof Error ? error.message : "",
      typeof record.stdout === "string" ? record.stdout : "",
      typeof record.stderr === "string" ? record.stderr : "",
      typeof record.message === "string" ? record.message : "",
    ].join("\n");
    return TRANSIENT_ERROR_PATTERN.test(message);
  }
  return TRANSIENT_ERROR_PATTERN.test(String(error));
};
