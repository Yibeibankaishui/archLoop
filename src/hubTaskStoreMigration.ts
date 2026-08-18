import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { TaskBoardError } from "./errors.js";
import {
  ensureHubTaskStoreMigrationGitExcludes,
  installHubTaskStoreRedirect,
  isBeadsStoreDatabasePresent,
  isBeadsStoreFullyInitialized,
  isHubOwnedTaskStoreKind,
  resolveHubTaskStore,
  resolveHubTaskStoreQuarantineDir,
  resolveManagedHubTaskStoreDir,
  type HubTaskStoreKind,
  type HubTaskStoreResolution,
} from "./hubTaskStoreResolver.js";
import { isBdAvailable, resolveBdExecutable } from "./resolveBdExecutable.js";

export const HUB_TASK_STORE_MIGRATION_PHASES = [
  "legacy_active",
  "snapshot_prepared",
  "legacy_quarantined",
  "managed_copied",
  "redirect_installed",
  "verified",
] as const;

export type HubTaskStoreMigrationPhase =
  (typeof HUB_TASK_STORE_MIGRATION_PHASES)[number];

export const HUB_TASK_STORE_MIGRATION_SIDE_EFFECTS = [
  "record_legacy_active",
  "prepare_snapshot",
  "quarantine_legacy",
  "copy_managed",
  "install_redirect",
  "verify_managed",
] as const;

export type HubTaskStoreMigrationSideEffect =
  (typeof HUB_TASK_STORE_MIGRATION_SIDE_EFFECTS)[number];

export interface HubTaskStoreMigrationFaultInjection {
  readonly crashBefore?: HubTaskStoreMigrationSideEffect;
  readonly crashAfter?: HubTaskStoreMigrationSideEffect;
}

export class HubTaskStoreMigrationCrash extends Error {
  readonly name = "HubTaskStoreMigrationCrash";

  constructor(
    readonly sideEffect: HubTaskStoreMigrationSideEffect,
    readonly timing: "before" | "after",
  ) {
    super(`Hub task-store migration crash injected ${timing} ${sideEffect}`);
  }
}

export const HUB_TASK_STORE_MIGRATION_PENDING_REASONS = [
  "active_writer",
  "source_fingerprint_changed",
  "unsafe_snapshot",
  "migration_contention",
] as const;

export type HubTaskStoreMigrationPendingReason =
  (typeof HUB_TASK_STORE_MIGRATION_PENDING_REASONS)[number];

export const HUB_TASK_STORE_SPLIT_BRAIN_INCIDENT = "task_store_split_brain";

export type HubTaskStoreIntegrityIncident =
  | typeof HUB_TASK_STORE_SPLIT_BRAIN_INCIDENT
  | "invalid_redirect";

export interface HubTaskStoreMigrationInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly faultInjection?: HubTaskStoreMigrationFaultInjection;
  readonly now?: () => Date;
}

export type HubTaskStoreMigrationOutcome =
  | {
      readonly kind: "not_needed";
      readonly reason:
        | "uninitialized"
        | "managed"
        | "redirect"
        | "verified"
        | "legacy";
      readonly phase?: HubTaskStoreMigrationPhase;
      readonly beadsDir: string;
    }
  | {
      readonly kind: "migrated";
      readonly phase: "verified";
      readonly beadsDir: string;
      readonly backupDir: string;
      readonly journalPath: string;
    }
  | {
      readonly kind: "deferred";
      readonly reason: HubTaskStoreMigrationPendingReason;
      readonly phase: HubTaskStoreMigrationPhase;
      readonly beadsDir: string;
      readonly pendingUntil: string;
      readonly journalPath: string;
    }
  | {
      readonly kind: "split_brain";
      readonly beadsDir: string;
      readonly legacyBeadsDir: string;
      readonly managedBeadsDir: string;
      readonly integrityError: string;
      readonly journalPath: string;
    };

export interface HubTaskStoreMigrationInspection {
  readonly kind: HubTaskStoreKind;
  readonly beadsDir: string;
  readonly phase?: HubTaskStoreMigrationPhase;
  readonly phases: readonly HubTaskStoreMigrationPhase[];
  readonly backupPresent: boolean;
  readonly backupDir?: string;
  readonly integrityError?: string;
  readonly integrityIncident?: HubTaskStoreIntegrityIncident;
  readonly pendingReason?: HubTaskStoreMigrationPendingReason;
  readonly pendingUntil?: string;
  readonly nextAction?: string;
}

const RUNTIME_ENTRY_NAMES = [
  "embeddeddolt",
  "dolt",
  "issues.jsonl",
  "interactions.jsonl",
  "events.jsonl",
  "backup",
  "export-state",
  "export-state.json",
  "sync-state.json",
  "last-touched",
  "bd.sock",
  "bd.sock.startlock",
  ".exclusive-lock",
] as const;

const STORE_COPY_NAMES = [
  "metadata.json",
  "config.yaml",
  ".gitignore",
] as const;

interface StoreIdentity {
  readonly location: string;
  readonly databaseIdentity: string;
  readonly prefix: string;
  readonly taskIds: readonly string[];
  readonly taskCount: number;
  readonly dependencyCount: number;
  readonly commentCount: number;
  readonly workingState: Readonly<Record<string, number>>;
  readonly fingerprint: string;
}

interface JournalRecord {
  readonly phase?: HubTaskStoreMigrationPhase;
  readonly status?: string;
  readonly at: string;
  readonly fingerprint?: string;
  readonly reason?: string;
}

interface PendingRecord {
  readonly status: "task_store_migration_pending";
  readonly reason: HubTaskStoreMigrationPendingReason;
  readonly attempt: number;
  readonly ownerPid: number;
  readonly ownerNonce: string;
  readonly detectedAt: string;
  readonly nextRetryAt: string;
  readonly phase: HubTaskStoreMigrationPhase;
}

const MIGRATION_BACKOFF_MAX_MS = 120_000;
const MIGRATION_BACKOFF_MS = [
  2_000,
  10_000,
  30_000,
  MIGRATION_BACKOFF_MAX_MS,
] as const;

const PENDING_REASON_PROSE: Record<HubTaskStoreMigrationPendingReason, string> =
  {
    active_writer: "an active Beads writer",
    source_fingerprint_changed: "a source fingerprint change",
    unsafe_snapshot: "an unsafe snapshot",
    migration_contention: "migration lease contention",
  };

const PHASE_RANK = new Map(
  HUB_TASK_STORE_MIGRATION_PHASES.map((phase, index) => [phase, index]),
);

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

const resolveMigrationStateDir = (hubProjectDir: string): string =>
  join(hubProjectDir, "task-store-migration");

const resolveJournalPath = (hubProjectDir: string): string =>
  join(resolveMigrationStateDir(hubProjectDir), "journal.jsonl");

const resolveLeasePath = (hubProjectDir: string): string =>
  join(resolveMigrationStateDir(hubProjectDir), "lease.json");

const resolveSnapshotPath = (hubProjectDir: string): string =>
  join(resolveMigrationStateDir(hubProjectDir), "snapshot.json");

const resolvePendingPath = (hubProjectDir: string): string =>
  join(resolveMigrationStateDir(hubProjectDir), "pending.json");

const isPhase = (value: unknown): value is HubTaskStoreMigrationPhase =>
  typeof value === "string" &&
  (HUB_TASK_STORE_MIGRATION_PHASES as readonly string[]).includes(value);

const isPendingReason = (
  value: unknown,
): value is HubTaskStoreMigrationPendingReason =>
  typeof value === "string" &&
  (HUB_TASK_STORE_MIGRATION_PENDING_REASONS as readonly string[]).includes(
    value,
  );

const readJournalPhases = (
  journalPath: string,
): readonly HubTaskStoreMigrationPhase[] => {
  if (!existsSync(journalPath)) {
    return [];
  }
  const phases: HubTaskStoreMigrationPhase[] = [];
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const record = JSON.parse(line) as JournalRecord;
      if (isPhase(record.phase) && !phases.includes(record.phase)) {
        phases.push(record.phase);
      }
    } catch {
      // Truncated journal tails are ignored; physical state is authoritative.
    }
  }
  return HUB_TASK_STORE_MIGRATION_PHASES.filter((phase) =>
    phases.includes(phase),
  );
};

const appendJournalRecord = (
  journalPath: string,
  record: JournalRecord,
): void => {
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, `${JSON.stringify(record)}\n`, {
    flag: "a",
    encoding: "utf8",
  });
  fsyncPath(journalPath);
};

const appendJournalPhase = (
  journalPath: string,
  phase: HubTaskStoreMigrationPhase,
  extra: Readonly<Record<string, unknown>> = {},
): void => {
  const existing = readJournalPhases(journalPath);
  if (existing.includes(phase)) {
    return;
  }
  appendJournalRecord(journalPath, {
    phase,
    at: new Date().toISOString(),
    ...extra,
  });
};

const readPending = (hubProjectDir: string): PendingRecord | undefined => {
  const pendingPath = resolvePendingPath(hubProjectDir);
  if (!existsSync(pendingPath)) {
    return undefined;
  }
  const record = readJsonFile(pendingPath);
  if (
    record.status !== "task_store_migration_pending" ||
    !isPendingReason(record.reason) ||
    typeof record.nextRetryAt !== "string" ||
    typeof record.attempt !== "number"
  ) {
    return undefined;
  }
  return {
    status: "task_store_migration_pending",
    reason: record.reason,
    attempt: record.attempt,
    ownerPid: typeof record.ownerPid === "number" ? record.ownerPid : 0,
    ownerNonce:
      typeof record.ownerNonce === "string" ? record.ownerNonce : "",
    detectedAt:
      typeof record.detectedAt === "string"
        ? record.detectedAt
        : new Date().toISOString(),
    nextRetryAt: record.nextRetryAt,
    phase: isPhase(record.phase) ? record.phase : "legacy_active",
  };
};

const clearPending = (hubProjectDir: string): void => {
  const pendingPath = resolvePendingPath(hubProjectDir);
  if (existsSync(pendingPath)) {
    rmSync(pendingPath, { force: true });
  }
};

const errorCode = (error: unknown): string | undefined => {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as NodeJS.ErrnoException).code);
  }
  return undefined;
};

const recordPending = (input: {
  readonly hubProjectDir: string;
  readonly journalPath: string;
  readonly reason: HubTaskStoreMigrationPendingReason;
  readonly phase: HubTaskStoreMigrationPhase;
  readonly now: Date;
  readonly previous?: PendingRecord;
}): PendingRecord => {
  const attempt = (input.previous?.attempt ?? 0) + 1;
  const delay = MIGRATION_BACKOFF_MS[attempt - 1] ?? MIGRATION_BACKOFF_MAX_MS;
  const pending: PendingRecord = {
    status: "task_store_migration_pending",
    reason: input.reason,
    attempt,
    ownerPid: process.pid,
    ownerNonce: `${process.pid}:${input.now.toISOString()}`,
    detectedAt: input.now.toISOString(),
    nextRetryAt: new Date(input.now.getTime() + delay).toISOString(),
    phase: input.phase,
  };
  writeAtomicJson(resolvePendingPath(input.hubProjectDir), pending);
  appendJournalRecord(input.journalPath, {
    status: "task_store_migration_pending",
    reason: input.reason,
    at: pending.detectedAt,
  });
  return pending;
};

const maybeCrash = (
  fault: HubTaskStoreMigrationFaultInjection | undefined,
  sideEffect: HubTaskStoreMigrationSideEffect,
  timing: "before" | "after",
): void => {
  if (!fault) {
    return;
  }
  if (timing === "before" && fault.crashBefore === sideEffect) {
    throw new HubTaskStoreMigrationCrash(sideEffect, "before");
  }
  if (timing === "after" && fault.crashAfter === sideEffect) {
    throw new HubTaskStoreMigrationCrash(sideEffect, "after");
  }
};

const withSideEffect = (
  fault: HubTaskStoreMigrationFaultInjection | undefined,
  sideEffect: HubTaskStoreMigrationSideEffect,
  operation: () => void,
): void => {
  maybeCrash(fault, sideEffect, "before");
  operation();
  maybeCrash(fault, sideEffect, "after");
};

const readJsonFile = (path: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const readIssuePrefix = (configPath: string): string => {
  if (!existsSync(configPath)) {
    return "";
  }
  const match = readFileSync(configPath, "utf8").match(
    /^issue-prefix:\s*"?([^"\n#]+)"?/m,
  );
  return match?.[1]?.trim() ?? "";
};

const extractJsonValue = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  const objectIndex = trimmed.indexOf("{");
  const arrayIndex = trimmed.indexOf("[");
  const startCandidates = [objectIndex, arrayIndex].filter(
    (index) => index >= 0,
  );
  if (startCandidates.length === 0) {
    return undefined;
  }
  const start = Math.min(...startCandidates);
  try {
    return JSON.parse(trimmed.slice(start)) as unknown;
  } catch {
    return undefined;
  }
};

const asRecords = (value: unknown): readonly Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "issues",
      "tasks",
      "items",
      "results",
      "data",
      "beads",
    ]) {
      const nested = record[key];
      if (Array.isArray(nested)) {
        return asRecords(nested);
      }
    }
    return [record];
  }
  return [];
};

const countUnknownEntries = (value: unknown): number => {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length;
  }
  return value ? 1 : 0;
};

const execBdJson = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  beadsDir: string,
): unknown => {
  const stdout = execFileSync(resolveBdExecutable(env), [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      BEADS_DIR: beadsDir,
    },
  });
  return extractJsonValue(stdout);
};

const hashStoreTree = (root: string): string => {
  const hash = createHash("sha256");
  const walk = (path: string, rel: string): void => {
    if (!existsSync(path)) {
      return;
    }
    const stats = statSync(path);
    hash.update(rel);
    hash.update("\n");
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        walk(join(path, entry), rel.length > 0 ? `${rel}/${entry}` : entry);
      }
      return;
    }
    hash.update(readFileSync(path));
  };
  walk(root, "");
  return hash.digest("hex");
};

export const detectHubTaskStoreSplitBrain = (input: {
  readonly repoRoot: string;
  readonly hubProjectDir?: string;
}):
  | {
      readonly legacyBeadsDir: string;
      readonly managedBeadsDir: string;
    }
  | undefined => {
  const resolution = resolveHubTaskStore(input);
  if (resolution.kind !== "redirect" || resolution.redirectError) {
    return undefined;
  }
  const leftoverDb = join(resolution.repoBeadsDir, "embeddeddolt");
  const managedDir = resolution.redirectTarget ?? resolution.beadsDir;
  const managedDb = join(managedDir, "embeddeddolt");
  if (!existsSync(leftoverDb) || !existsSync(managedDb)) {
    return undefined;
  }
  if (hashStoreTree(leftoverDb) === hashStoreTree(managedDb)) {
    return undefined;
  }
  return {
    legacyBeadsDir: resolution.repoBeadsDir,
    managedBeadsDir: managedDir,
  };
};

const captureStoreIdentity = (
  cwd: string,
  beadsDir: string,
  env: NodeJS.ProcessEnv,
): StoreIdentity => {
  const metadata = readJsonFile(join(beadsDir, "metadata.json"));
  const databaseIdentity = [
    typeof metadata.project_id === "string" ? metadata.project_id : "",
    typeof metadata.dolt_database === "string" ? metadata.dolt_database : "",
    typeof metadata.database === "string" ? metadata.database : "",
  ]
    .filter((value) => value.length > 0)
    .join(":");
  const prefix = readIssuePrefix(join(beadsDir, "config.yaml"));
  const issues = asRecords(
    execBdJson(cwd, ["list", "--json", "--all", "--limit", "0"], env, beadsDir),
  );
  const taskIds = issues
    .map((issue) => (typeof issue.id === "string" ? issue.id : ""))
    .filter((id) => id.length > 0)
    .sort();
  const workingState: Record<string, number> = {};
  let dependencyCount = 0;
  let commentCount = 0;
  for (const issue of issues) {
    const status = typeof issue.status === "string" ? issue.status : "unknown";
    workingState[status] = (workingState[status] ?? 0) + 1;
    dependencyCount += countUnknownEntries(
      issue.dependencies ?? issue.depends_on ?? issue.deps,
    );
    commentCount += countUnknownEntries(
      issue.comments ??
        issue.comment_count ??
        issue.commentCount ??
        issue.comment_threads,
    );
  }
  const where = execBdJson(cwd, ["where", "--json"], env, beadsDir) as
    | { path?: string }
    | undefined;
  const location =
    typeof where?.path === "string" && where.path.length > 0
      ? where.path
      : beadsDir;
  const fingerprint = createHash("sha256")
    .update(databaseIdentity)
    .update("\n")
    .update(prefix)
    .update("\n")
    .update(taskIds.join(","))
    .update("\n")
    .update(String(issues.length))
    .update("\n")
    .update(String(dependencyCount))
    .update("\n")
    .update(String(commentCount))
    .update("\n")
    .update(
      Object.entries(workingState)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => `${status}:${count}`)
        .join(","),
    )
    .digest("hex");

  return {
    location,
    databaseIdentity,
    prefix,
    taskIds,
    taskCount: taskIds.length,
    dependencyCount,
    commentCount,
    workingState,
    fingerprint,
  };
};

const identitiesMatch = (
  expected: StoreIdentity,
  actual: StoreIdentity,
): boolean =>
  expected.fingerprint === actual.fingerprint &&
  expected.databaseIdentity === actual.databaseIdentity &&
  expected.prefix === actual.prefix &&
  expected.taskCount === actual.taskCount &&
  expected.dependencyCount === actual.dependencyCount &&
  expected.commentCount === actual.commentCount &&
  expected.taskIds.join("\0") === actual.taskIds.join("\0");

const formatIdentityMismatch = (
  expected: StoreIdentity,
  actual: StoreIdentity,
): string =>
  `Hub Beads migration verification failed: the managed store does not match the quarantined legacy snapshot (tasks ${actual.taskCount}/${expected.taskCount}, prefix ${actual.prefix || "(none)"}/${expected.prefix || "(none)"}). The original data remains in the recoverable backup. Do not treat this as a task failure; inspect the Hub project task-store migration journal and retry the same command.`;

const walkAndFsync = (root: string): void => {
  const stats = statSync(root);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(root)) {
      walkAndFsync(join(root, entry));
    }
  }
  try {
    fsyncPath(root);
  } catch {
    // Some directories cannot be fsynced with a read-only descriptor.
  }
};

const copyDirSynced = (source: string, destination: string): void => {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
  walkAndFsync(destination);
};

const listRuntimeEntries = (beadsDir: string): readonly string[] => {
  if (!existsSync(beadsDir)) {
    return [];
  }
  return readdirSync(beadsDir).filter((name) =>
    (RUNTIME_ENTRY_NAMES as readonly string[]).includes(name),
  );
};

const quarantineLegacyStore = (
  repoRoot: string,
  repoBeadsDir: string,
  quarantineDir: string,
): void => {
  mkdirSync(quarantineDir, { recursive: true });
  for (const name of listRuntimeEntries(repoBeadsDir)) {
    const from = join(repoBeadsDir, name);
    const to = join(quarantineDir, name);
    if (existsSync(to)) {
      continue;
    }
    try {
      renameSync(from, to);
    } catch (error) {
      if (errorCode(error) === "EXDEV") {
        throw new TaskBoardError({
          message:
            "Hub Beads migration cannot move a live database across filesystems. Quarantine the store on its original filesystem first; only the cold quarantined copy is copied to Hub-owned storage.",
        });
      }
      throw error;
    }
  }
  ensureHubTaskStoreMigrationGitExcludes(repoRoot);
};

const copyManagedStore = (
  repoBeadsDir: string,
  quarantineDir: string,
  managedBeadsDir: string,
): void => {
  mkdirSync(managedBeadsDir, { recursive: true });
  for (const name of readdirSync(quarantineDir)) {
    const from = join(quarantineDir, name);
    const to = join(managedBeadsDir, name);
    if (existsSync(to)) {
      continue;
    }
    copyDirSynced(from, to);
  }
  for (const name of STORE_COPY_NAMES) {
    const from = join(repoBeadsDir, name);
    const to = join(managedBeadsDir, name);
    if (!existsSync(from) || existsSync(to)) {
      continue;
    }
    copyDirSynced(from, to);
  }
};

const readSnapshot = (snapshotPath: string): StoreIdentity | undefined => {
  if (!existsSync(snapshotPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(snapshotPath, "utf8")) as StoreIdentity;
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
    return errorCode(error) === "EPERM";
  }
};

const acquireMigrationLease = (
  hubProjectDir: string,
): { readonly acquired: true } | { readonly acquired: false; readonly ownerPid: number } => {
  const leasePath = resolveLeasePath(hubProjectDir);
  if (existsSync(leasePath)) {
    const lease = readJsonFile(leasePath);
    const pid = typeof lease.pid === "number" ? lease.pid : undefined;
    if (pid !== undefined && pid !== process.pid && isProcessAlive(pid)) {
      return { acquired: false, ownerPid: pid };
    }
  }
  writeAtomicJson(leasePath, {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  });
  return { acquired: true };
};

const releaseMigrationLease = (hubProjectDir: string): void => {
  const leasePath = resolveLeasePath(hubProjectDir);
  if (existsSync(leasePath)) {
    rmSync(leasePath, { force: true });
  }
};

const highestPhase = (
  phases: readonly HubTaskStoreMigrationPhase[],
): HubTaskStoreMigrationPhase | undefined => {
  let highest: HubTaskStoreMigrationPhase | undefined;
  let highestRank = -1;
  for (const phase of phases) {
    const rank = PHASE_RANK.get(phase) ?? -1;
    if (rank > highestRank) {
      highest = phase;
      highestRank = rank;
    }
  }
  return highest;
};

type DurableMigrationEvidence = {
  readonly quarantineDir: string;
  readonly snapshot?: StoreIdentity;
  readonly journalPhases: readonly HubTaskStoreMigrationPhase[];
};

/**
 * Physical `managed store + redirect` is both the normal steady state for a
 * fresh Hub project and a late phase of real legacy migration. Only durable
 * migration artifacts distinguish those cases; layout alone must not invent
 * an interrupted `redirect_installed` / `managed_copied` phase.
 */
const hasDurableMigrationEvidence = (
  input: DurableMigrationEvidence,
): boolean =>
  input.journalPhases.length > 0 ||
  input.snapshot !== undefined ||
  isBeadsStoreDatabasePresent(input.quarantineDir);

/**
 * Map a late managed layout onto a migration phase only when durable evidence
 * proves legacy migration actually started; otherwise report steady state.
 */
const phaseForManagedLayout = (
  layoutPhase: "managed_copied" | "redirect_installed",
  migrationEvidence: boolean,
): HubTaskStoreMigrationPhase | undefined => {
  if (!migrationEvidence) {
    return undefined;
  }
  return layoutPhase;
};

const MISSING_SOURCE_SNAPSHOT_MESSAGE =
  "Hub Beads migration could not prepare a source snapshot. Inspect the Hub project task-store migration journal and snapshot under task-store-migration/; this is not a task failure and does not require `archloop tasks recover`.";

const derivePhase = (
  input: {
    readonly resolution: HubTaskStoreResolution;
  } & DurableMigrationEvidence,
): HubTaskStoreMigrationPhase | undefined => {
  const managedBeadsDir = input.resolution.managedBeadsDir;
  const managedReady =
    managedBeadsDir !== undefined &&
    isBeadsStoreFullyInitialized(managedBeadsDir);
  const redirectReady =
    input.resolution.kind === "redirect" &&
    !input.resolution.redirectError &&
    managedReady;
  const quarantined = isBeadsStoreDatabasePresent(input.quarantineDir);
  const legacyLive = input.resolution.kind === "legacy";
  const migrationEvidence = hasDurableMigrationEvidence(input);

  if (redirectReady && input.journalPhases.includes("verified")) {
    return "verified";
  }
  if (redirectReady) {
    return phaseForManagedLayout("redirect_installed", migrationEvidence);
  }
  if (managedReady) {
    return phaseForManagedLayout("managed_copied", migrationEvidence);
  }
  if (quarantined) {
    return "legacy_quarantined";
  }
  if (input.snapshot) {
    return "snapshot_prepared";
  }
  if (legacyLive || input.journalPhases.includes("legacy_active")) {
    return "legacy_active";
  }
  return highestPhase(input.journalPhases);
};

export const inspectHubTaskStoreMigration = (
  input: HubTaskStoreMigrationInput,
): HubTaskStoreMigrationInspection => {
  const resolution = resolveHubTaskStore({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
  });
  const quarantineDir = resolveHubTaskStoreQuarantineDir(input.repoRoot);
  const journalPhases = readJournalPhases(
    resolveJournalPath(input.hubProjectDir),
  );
  const snapshot = readSnapshot(resolveSnapshotPath(input.hubProjectDir));
  const phase = derivePhase({
    resolution,
    quarantineDir,
    snapshot,
    journalPhases,
  });
  const backupPresent = isBeadsStoreDatabasePresent(quarantineDir);
  const pending = readPending(input.hubProjectDir);
  const splitBrain = detectHubTaskStoreSplitBrain({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
  });
  let integrityIncident: HubTaskStoreIntegrityIncident | undefined;
  let integrityError: string | undefined;
  if (resolution.redirectError) {
    integrityIncident = "invalid_redirect";
    integrityError = resolution.redirectError;
  } else if (splitBrain) {
    integrityIncident = HUB_TASK_STORE_SPLIT_BRAIN_INCIDENT;
    integrityError = formatHubTaskStoreSplitBrainMessage(
      splitBrain.legacyBeadsDir,
      splitBrain.managedBeadsDir,
    );
  }
  return {
    kind: resolution.kind,
    beadsDir: resolution.beadsDir,
    phase,
    phases: journalPhases.length > 0 ? journalPhases : phase ? [phase] : [],
    backupPresent,
    ...(backupPresent ? { backupDir: quarantineDir } : {}),
    ...(integrityError
      ? { integrityError, integrityIncident, nextAction: integrityError }
      : {}),
    ...(pending && !splitBrain
      ? {
          pendingReason: pending.reason,
          pendingUntil: pending.nextRetryAt,
          nextAction:
            "Wait for the automatic retry; keep using the verified repository-local Beads store. This is not a task failure and does not require a recovery command.",
        }
      : {}),
  };
};

const isMigrationOutcome = (
  value: HubTaskStoreMigrationOutcome | HubTaskStoreMigrationInspection,
): value is HubTaskStoreMigrationOutcome =>
  value.kind === "migrated" ||
  value.kind === "not_needed" ||
  value.kind === "deferred" ||
  value.kind === "split_brain";

const formatDeferredMigrationMessage = (
  reason: HubTaskStoreMigrationPendingReason,
  pendingUntil: string,
): string =>
  `Hub Beads store migration is pending because ${PENDING_REASON_PROSE[reason]} was detected before quarantine. The verified repository-local store remains active. Automatic retry is scheduled by ${pendingUntil}. This is not a task failure and does not require a recovery command.`;

export const formatHubTaskStoreSplitBrainMessage = (
  legacyBeadsDir: string,
  managedBeadsDir: string,
): string =>
  `Hub Beads task-store split brain detected: both ${legacyBeadsDir} and ${managedBeadsDir} were modified independently after redirect. Automatic task-store writes are stopped. Inspect both databases and keep the intended history; do not merge or delete either store automatically. This is not a task failure and does not require a recovery command.`;

export function throwIfHubTaskStoreSplitBrain(
  outcome: HubTaskStoreMigrationOutcome,
): asserts outcome is Exclude<
  HubTaskStoreMigrationOutcome,
  { kind: "split_brain" }
> {
  if (outcome.kind === "split_brain") {
    throw new TaskBoardError({ message: outcome.integrityError });
  }
}

export const formatHubTaskStoreMigrationMessage = (
  outcome: HubTaskStoreMigrationOutcome | HubTaskStoreMigrationInspection,
): string => {
  if (isMigrationOutcome(outcome)) {
    if (outcome.kind === "migrated") {
      return `Migrated the repository-local Beads store into Hub-owned storage at ${outcome.beadsDir}. Direct \`bd\` commands continue through .beads/redirect. A recoverable backup remains at ${outcome.backupDir}.`;
    }
    if (outcome.kind === "deferred") {
      return formatDeferredMigrationMessage(
        outcome.reason,
        outcome.pendingUntil,
      );
    }
    if (outcome.kind === "split_brain") {
      return outcome.integrityError;
    }
    if (outcome.reason === "verified" || outcome.phase === "verified") {
      return `Hub-owned Beads store is already migrated at ${outcome.beadsDir}.`;
    }
    return `Hub Beads store does not need migration (${outcome.reason}).`;
  }

  if (outcome.integrityError) {
    return outcome.integrityError;
  }
  if (outcome.pendingReason && outcome.pendingUntil) {
    return formatDeferredMigrationMessage(
      outcome.pendingReason,
      outcome.pendingUntil,
    );
  }
  if (outcome.phase === "verified") {
    return `Hub-owned Beads store is migrated and verified at ${outcome.beadsDir}.`;
  }
  if (outcome.phase) {
    return `Hub Beads store migration progress: ${outcome.phase}.`;
  }
  return "Hub Beads store migration has not started.";
};

const readPidFile = (path: string): number | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  const raw = readFileSync(path, "utf8").trim();
  const match = raw.match(/\d+/);
  if (!match) {
    return undefined;
  }
  const pid = Number.parseInt(match[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

const findActiveWriterPid = (repoBeadsDir: string): number | undefined => {
  for (const name of ["dolt-server.pid", ".exclusive-lock"] as const) {
    const pid = readPidFile(join(repoBeadsDir, name));
    if (pid !== undefined && isProcessAlive(pid)) {
      return pid;
    }
  }
  return undefined;
};

type DeferredMigrationOutcome = Extract<
  HubTaskStoreMigrationOutcome,
  { kind: "deferred" }
>;
type SplitBrainMigrationOutcome = Extract<
  HubTaskStoreMigrationOutcome,
  { kind: "split_brain" }
>;

const deferredOutcomeFromPending = (input: {
  readonly pending: PendingRecord;
  readonly beadsDir: string;
  readonly journalPath: string;
  readonly reason?: HubTaskStoreMigrationPendingReason;
}): DeferredMigrationOutcome => ({
  kind: "deferred",
  reason: input.reason ?? input.pending.reason,
  phase: input.pending.phase,
  beadsDir: input.beadsDir,
  pendingUntil: input.pending.nextRetryAt,
  journalPath: input.journalPath,
});

const deferMigration = (input: {
  readonly hubProjectDir: string;
  readonly journalPath: string;
  readonly beadsDir: string;
  readonly reason: HubTaskStoreMigrationPendingReason;
  readonly phase: HubTaskStoreMigrationPhase;
  readonly now: Date;
}): DeferredMigrationOutcome => {
  const pending = recordPending({
    hubProjectDir: input.hubProjectDir,
    journalPath: input.journalPath,
    reason: input.reason,
    phase: input.phase,
    now: input.now,
    previous: readPending(input.hubProjectDir),
  });
  return {
    kind: "deferred",
    reason: input.reason,
    phase: input.phase,
    beadsDir: input.beadsDir,
    pendingUntil: pending.nextRetryAt,
    journalPath: input.journalPath,
  };
};

const recordSplitBrainOutcome = (input: {
  readonly hubProjectDir: string;
  readonly beadsDir: string;
  readonly splitBrain: {
    readonly legacyBeadsDir: string;
    readonly managedBeadsDir: string;
  };
  readonly now: Date;
}): SplitBrainMigrationOutcome => {
  const journalPath = resolveJournalPath(input.hubProjectDir);
  const integrityError = formatHubTaskStoreSplitBrainMessage(
    input.splitBrain.legacyBeadsDir,
    input.splitBrain.managedBeadsDir,
  );
  appendJournalRecord(journalPath, {
    status: HUB_TASK_STORE_SPLIT_BRAIN_INCIDENT,
    at: input.now.toISOString(),
  });
  return {
    kind: "split_brain",
    beadsDir: input.beadsDir,
    legacyBeadsDir: input.splitBrain.legacyBeadsDir,
    managedBeadsDir: input.splitBrain.managedBeadsDir,
    integrityError,
    journalPath,
  };
};

const verifyManagedStore = (
  cwd: string,
  managedBeadsDir: string,
  expected: StoreIdentity,
  env: NodeJS.ProcessEnv,
): void => {
  if (!isBeadsStoreFullyInitialized(managedBeadsDir)) {
    throw new TaskBoardError({
      message:
        "Hub Beads migration verification failed: the managed store is missing after copy. The original data remains in the recoverable backup.",
    });
  }
  const actual = captureStoreIdentity(cwd, managedBeadsDir, env);
  if (
    actual.location !== managedBeadsDir &&
    !actual.location.startsWith(managedBeadsDir)
  ) {
    throw new TaskBoardError({
      message: `Hub Beads migration verification failed: Beads location is ${actual.location}, expected ${managedBeadsDir}.`,
    });
  }
  if (!identitiesMatch(expected, actual)) {
    throw new TaskBoardError({
      message: formatIdentityMismatch(expected, actual),
    });
  }
};

const notNeededReasonForKind = (
  kind: HubTaskStoreKind,
): "uninitialized" | "managed" | "redirect" => {
  if (kind === "uninitialized") {
    return "uninitialized";
  }
  if (kind === "managed") {
    return "managed";
  }
  return "redirect";
};

export const ensureHubTaskStoreMigrated = (
  input: HubTaskStoreMigrationInput,
): HubTaskStoreMigrationOutcome => {
  const env = input.env ?? process.env;
  const now = input.now?.() ?? new Date();
  if (!isBdAvailable(env)) {
    throw new TaskBoardError({
      message:
        "archLoop task-store migration requires the archLoop task runtime. Install dependencies, set ARCHLOOP_BD_PATH, or ensure the bundled Beads runtime is available.",
    });
  }

  const location = {
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
  };
  const resolution = resolveHubTaskStore(location);
  if (resolution.redirectError) {
    throw new TaskBoardError({ message: resolution.redirectError });
  }

  const splitBrain = detectHubTaskStoreSplitBrain({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
  });
  if (splitBrain) {
    return recordSplitBrainOutcome({
      hubProjectDir: input.hubProjectDir,
      beadsDir: resolution.beadsDir,
      splitBrain,
      now,
    });
  }

  const managedBeadsDir =
    resolution.managedBeadsDir ??
    resolveManagedHubTaskStoreDir(input.hubProjectDir);
  const repoBeadsDir = resolution.repoBeadsDir;
  const quarantineDir = resolveHubTaskStoreQuarantineDir(input.repoRoot);
  const journalPath = resolveJournalPath(input.hubProjectDir);
  const snapshotPath = resolveSnapshotPath(input.hubProjectDir);
  const inspection = inspectHubTaskStoreMigration(input);
  const quarantinePresent = isBeadsStoreDatabasePresent(quarantineDir);

  if (
    inspection.phase === "verified" &&
    isHubOwnedTaskStoreKind(resolution.kind)
  ) {
    return {
      kind: "not_needed",
      reason: "verified",
      phase: "verified",
      beadsDir: resolution.beadsDir,
    };
  }

  if (
    resolution.kind !== "legacy" &&
    inspection.phase === undefined &&
    !quarantinePresent
  ) {
    return {
      kind: "not_needed",
      reason: notNeededReasonForKind(resolution.kind),
      beadsDir: resolution.beadsDir,
    };
  }

  const existingPending = readPending(input.hubProjectDir);
  if (existingPending) {
    const pendingUntilMs = Date.parse(existingPending.nextRetryAt);
    const stillBackingOff =
      Number.isFinite(pendingUntilMs) && now.getTime() < pendingUntilMs;
    const ownedByLivePeer =
      existingPending.ownerPid !== process.pid &&
      isProcessAlive(existingPending.ownerPid);
    if (stillBackingOff || ownedByLivePeer) {
      return deferredOutcomeFromPending({
        pending: existingPending,
        beadsDir: resolution.beadsDir,
        journalPath,
        reason:
          ownedByLivePeer && !stillBackingOff
            ? "migration_contention"
            : existingPending.reason,
      });
    }
  }

  if (resolution.kind === "legacy" && !quarantinePresent) {
    try {
      captureStoreIdentity(input.repoRoot, repoBeadsDir, env);
    } catch {
      if (readSnapshot(resolveSnapshotPath(input.hubProjectDir))) {
        return deferMigration({
          hubProjectDir: input.hubProjectDir,
          journalPath,
          beadsDir: resolution.beadsDir,
          reason: "unsafe_snapshot",
          phase: "snapshot_prepared",
          now,
        });
      }
      return {
        kind: "not_needed",
        reason: "legacy",
        beadsDir: resolution.beadsDir,
      };
    }
  }

  const lease = acquireMigrationLease(input.hubProjectDir);
  if (!lease.acquired) {
    return deferMigration({
      hubProjectDir: input.hubProjectDir,
      journalPath,
      beadsDir: resolution.beadsDir,
      reason: "migration_contention",
      phase: inspection.phase ?? "legacy_active",
      now,
    });
  }
  try {
    let snapshot = readSnapshot(snapshotPath);
    const fault = input.faultInjection;
    const syncJournal = (
      phase: HubTaskStoreMigrationPhase,
      extra?: Readonly<Record<string, unknown>>,
    ) => {
      appendJournalPhase(journalPath, phase, extra);
    };
    const readProgress = () => {
      const currentResolution = resolveHubTaskStore(location);
      return {
        resolution: currentResolution,
        phase: derivePhase({
          resolution: currentResolution,
          quarantineDir,
          snapshot,
          journalPhases: readJournalPhases(journalPath),
        }),
      };
    };

    const startPhase = readProgress().phase;
    if (startPhase === undefined || startPhase === "legacy_active") {
      if (resolution.kind === "legacy") {
        const writerPid = findActiveWriterPid(repoBeadsDir);
        if (writerPid !== undefined) {
          return deferMigration({
            hubProjectDir: input.hubProjectDir,
            journalPath,
            beadsDir: resolution.beadsDir,
            reason: "active_writer",
            phase: "legacy_active",
            now,
          });
        }
      }
      // Durable lease/journal start boundary. The source fingerprint is
      // recorded with the snapshot in the next step.
      maybeCrash(fault, "record_legacy_active", "before");
      maybeCrash(fault, "record_legacy_active", "after");
      syncJournal("legacy_active");
    }

    const snapshotProgress = readProgress();
    if (
      snapshotProgress.phase === "legacy_active" ||
      (!snapshot && snapshotProgress.resolution.kind === "legacy")
    ) {
      withSideEffect(fault, "prepare_snapshot", () => {
        snapshot = captureStoreIdentity(input.repoRoot, repoBeadsDir, env);
        writeAtomicJson(snapshotPath, snapshot);
      });
      snapshot = snapshot ?? readSnapshot(snapshotPath);
      syncJournal("snapshot_prepared", {
        fingerprint: snapshot?.fingerprint,
      });
    }

    const sourceSnapshot = snapshot ?? readSnapshot(snapshotPath);
    if (!sourceSnapshot) {
      throw new TaskBoardError({ message: MISSING_SOURCE_SNAPSHOT_MESSAGE });
    }
    snapshot = sourceSnapshot;

    if (
      isBeadsStoreDatabasePresent(repoBeadsDir) &&
      !isBeadsStoreDatabasePresent(quarantineDir)
    ) {
      let currentIdentity: StoreIdentity | undefined;
      try {
        currentIdentity = captureStoreIdentity(
          input.repoRoot,
          repoBeadsDir,
          env,
        );
      } catch {
        return deferMigration({
          hubProjectDir: input.hubProjectDir,
          journalPath,
          beadsDir: resolution.beadsDir,
          reason: "unsafe_snapshot",
          phase: "snapshot_prepared",
          now,
        });
      }
      if (!identitiesMatch(sourceSnapshot, currentIdentity)) {
        if (existsSync(snapshotPath)) {
          rmSync(snapshotPath, { force: true });
        }
        snapshot = undefined;
        return deferMigration({
          hubProjectDir: input.hubProjectDir,
          journalPath,
          beadsDir: resolution.beadsDir,
          reason: "source_fingerprint_changed",
          phase: "legacy_active",
          now,
        });
      }
    }

    const quarantineProgress = readProgress();
    if (
      quarantineProgress.phase === "snapshot_prepared" ||
      (quarantineProgress.phase === "legacy_active" &&
        isBeadsStoreDatabasePresent(repoBeadsDir))
    ) {
      withSideEffect(fault, "quarantine_legacy", () => {
        quarantineLegacyStore(input.repoRoot, repoBeadsDir, quarantineDir);
      });
      syncJournal("legacy_quarantined", {
        fingerprint: sourceSnapshot.fingerprint,
      });
    }

    const copyProgress = readProgress();
    const journalPhases = readJournalPhases(journalPath);
    if (
      isBeadsStoreDatabasePresent(quarantineDir) &&
      !journalPhases.includes("verified") &&
      (copyProgress.phase === "legacy_quarantined" ||
        copyProgress.phase === "managed_copied" ||
        copyProgress.phase === "redirect_installed" ||
        !isBeadsStoreFullyInitialized(managedBeadsDir))
    ) {
      withSideEffect(fault, "copy_managed", () => {
        if (existsSync(managedBeadsDir)) {
          rmSync(managedBeadsDir, { recursive: true, force: true });
        }
        copyManagedStore(repoBeadsDir, quarantineDir, managedBeadsDir);
      });
      syncJournal("managed_copied", {
        fingerprint: sourceSnapshot.fingerprint,
      });
    }

    const redirectProgress = readProgress();
    if (
      redirectProgress.resolution.kind !== "redirect" ||
      redirectProgress.resolution.redirectError ||
      redirectProgress.phase === "managed_copied"
    ) {
      withSideEffect(fault, "install_redirect", () => {
        installHubTaskStoreRedirect(input.repoRoot, managedBeadsDir);
      });
      syncJournal("redirect_installed", {
        fingerprint: sourceSnapshot.fingerprint,
      });
    }

    withSideEffect(fault, "verify_managed", () => {
      verifyManagedStore(input.repoRoot, managedBeadsDir, sourceSnapshot, env);
    });
    syncJournal("verified", { fingerprint: sourceSnapshot.fingerprint });
    clearPending(input.hubProjectDir);

    return {
      kind: "migrated",
      phase: "verified",
      beadsDir: managedBeadsDir,
      backupDir: quarantineDir,
      journalPath,
    };
  } finally {
    // Always release: success, deferral, split-brain, and terminal errors
    // (including missing source snapshot). Hard kills still leave lease.json;
    // resume uses durable journal/snapshot/quarantine plus PID supersession.
    releaseMigrationLease(input.hubProjectDir);
  }
};
