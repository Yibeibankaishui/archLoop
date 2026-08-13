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
import {
  isBdAvailable,
  resolveBdExecutable,
} from "./resolveBdExecutable.js";

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
    super(
      `Hub task-store migration crash injected ${timing} ${sideEffect}`,
    );
  }
}

export interface HubTaskStoreMigrationInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly faultInjection?: HubTaskStoreMigrationFaultInjection;
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
    };

export interface HubTaskStoreMigrationInspection {
  readonly kind: HubTaskStoreKind;
  readonly beadsDir: string;
  readonly phase?: HubTaskStoreMigrationPhase;
  readonly phases: readonly HubTaskStoreMigrationPhase[];
  readonly backupPresent: boolean;
  readonly backupDir?: string;
  readonly integrityError?: string;
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
  readonly phase: HubTaskStoreMigrationPhase;
  readonly at: string;
  readonly fingerprint?: string;
}

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

const isPhase = (value: unknown): value is HubTaskStoreMigrationPhase =>
  typeof value === "string" &&
  (HUB_TASK_STORE_MIGRATION_PHASES as readonly string[]).includes(value);

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

const appendJournalPhase = (
  journalPath: string,
  phase: HubTaskStoreMigrationPhase,
  extra: Readonly<Record<string, unknown>> = {},
): void => {
  const existing = readJournalPhases(journalPath);
  if (existing.includes(phase)) {
    return;
  }
  mkdirSync(dirname(journalPath), { recursive: true });
  const record: JournalRecord = {
    phase,
    at: new Date().toISOString(),
    ...extra,
  };
  writeFileSync(journalPath, `${JSON.stringify(record)}\n`, {
    flag: "a",
    encoding: "utf8",
  });
  fsyncPath(journalPath);
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
  const startCandidates = [objectIndex, arrayIndex].filter((index) => index >= 0);
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
    for (const key of ["issues", "tasks", "items", "results", "data", "beads"]) {
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
    const status =
      typeof issue.status === "string" ? issue.status : "unknown";
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
    renameSync(from, to);
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
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : undefined;
    return code === "EPERM";
  }
};

const acquireMigrationLease = (hubProjectDir: string): void => {
  const leasePath = resolveLeasePath(hubProjectDir);
  if (existsSync(leasePath)) {
    const lease = readJsonFile(leasePath);
    const pid = typeof lease.pid === "number" ? lease.pid : undefined;
    if (pid !== undefined && pid !== process.pid && isProcessAlive(pid)) {
      throw new TaskBoardError({
        message: `Hub Beads store migration is already running (pid ${pid}). Retry the same command after that process exits. This is not a task failure and does not require \`archloop tasks recover\`.`,
      });
    }
  }
  writeAtomicJson(leasePath, {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  });
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

const derivePhase = (input: {
  readonly resolution: HubTaskStoreResolution;
  readonly quarantineDir: string;
  readonly snapshot?: StoreIdentity;
  readonly journalPhases: readonly HubTaskStoreMigrationPhase[];
}): HubTaskStoreMigrationPhase | undefined => {
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

  if (redirectReady && input.journalPhases.includes("verified")) {
    return "verified";
  }
  if (redirectReady) {
    return "redirect_installed";
  }
  if (managedReady) {
    return "managed_copied";
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
  return {
    kind: resolution.kind,
    beadsDir: resolution.beadsDir,
    phase,
    phases: journalPhases.length > 0 ? journalPhases : phase ? [phase] : [],
    backupPresent,
    ...(backupPresent ? { backupDir: quarantineDir } : {}),
    ...(resolution.redirectError
      ? { integrityError: resolution.redirectError }
      : {}),
  };
};

const isMigrationOutcome = (
  value: HubTaskStoreMigrationOutcome | HubTaskStoreMigrationInspection,
): value is HubTaskStoreMigrationOutcome =>
  value.kind === "migrated" || value.kind === "not_needed";

export const formatHubTaskStoreMigrationMessage = (
  outcome: HubTaskStoreMigrationOutcome | HubTaskStoreMigrationInspection,
): string => {
  if (isMigrationOutcome(outcome)) {
    if (outcome.kind === "migrated") {
      return `Migrated the repository-local Beads store into Hub-owned storage at ${outcome.beadsDir}. Direct \`bd\` commands continue through .beads/redirect. A recoverable backup remains at ${outcome.backupDir}.`;
    }
    if (outcome.reason === "verified" || outcome.phase === "verified") {
      return `Hub-owned Beads store is already migrated at ${outcome.beadsDir}.`;
    }
    return `Hub Beads store does not need migration (${outcome.reason}).`;
  }

  if (outcome.integrityError) {
    return outcome.integrityError;
  }
  if (outcome.phase === "verified") {
    return `Hub-owned Beads store is migrated and verified at ${outcome.beadsDir}.`;
  }
  if (outcome.phase) {
    return `Hub Beads store migration progress: ${outcome.phase}.`;
  }
  return "Hub Beads store migration has not started.";
};

const assertWriterFree = (repoBeadsDir: string): void => {
  const pidPath = join(repoBeadsDir, "dolt-server.pid");
  if (!existsSync(pidPath)) {
    return;
  }
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (isProcessAlive(pid)) {
    throw new TaskBoardError({
      message: `Hub Beads store migration found an active Beads writer (pid ${pid}). Retry the same mutating command after that writer exits. This is not a task failure and does not require \`archloop tasks recover\`.`,
    });
  }
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
  if (actual.location !== managedBeadsDir && !actual.location.startsWith(managedBeadsDir)) {
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

  if (resolution.kind === "legacy" && !quarantinePresent) {
    try {
      captureStoreIdentity(input.repoRoot, repoBeadsDir, env);
    } catch {
      return {
        kind: "not_needed",
        reason: "legacy",
        beadsDir: resolution.beadsDir,
      };
    }
  }

  acquireMigrationLease(input.hubProjectDir);
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
        assertWriterFree(repoBeadsDir);
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
      throw new TaskBoardError({
        message:
          "Hub Beads migration could not prepare a source snapshot. Retry the same mutating command. This is not a task failure and does not require `archloop tasks recover`.",
      });
    }
    snapshot = sourceSnapshot;

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
    if (
      copyProgress.phase === "legacy_quarantined" ||
      (isBeadsStoreDatabasePresent(quarantineDir) &&
        !isBeadsStoreFullyInitialized(managedBeadsDir))
    ) {
      withSideEffect(fault, "copy_managed", () => {
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

    return {
      kind: "migrated",
      phase: "verified",
      beadsDir: managedBeadsDir,
      backupDir: quarantineDir,
      journalPath,
    };
  } finally {
    const finished = inspectHubTaskStoreMigration(input);
    if (finished.phase === "verified") {
      releaseMigrationLease(input.hubProjectDir);
    }
  }
};
