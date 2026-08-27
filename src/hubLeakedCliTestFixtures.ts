import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  readHubProjectRegistry,
  readSelectedHubProject,
  resolveHubProjectRegistryPath,
  resolveHubProjectSelectionPath,
  resolveRegisteredHubProjectDir,
  selectHubProject,
  type HubProjectRegistryEntry,
  type HubProjectRegistryOptions,
} from "./hubProjectRegistry.js";
import { resolveArchloopUserDataDir } from "./projectStatus.js";

export const LEAKED_CLI_TEST_FIXTURE_NAME_PATTERN = /^(cli-host-|cli-resolve-)/;
export const LEAKED_PATH_HASH_REPO_NAME_PATTERN =
  /^(cli-host-|cli-resolve-|hub-recover-cleanup-|hub-recover-blocked-)/;
export const PATH_HASH_PROJECT_DIR_PATTERN = /^[a-f0-9]{12}$/;
const STABLE_HUB_PROJECT_ID_PATTERN = /^project-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type LeakedCliTestFixtureSelectionAction = "keep" | "select" | "clear";

export interface BlockedLeakedCliTestRegistryEntry {
  readonly entry: HubProjectRegistryEntry;
  readonly reason: string;
}

export interface BackupTreeDigest {
  readonly entries: number;
  readonly files: number;
  readonly directories: number;
  readonly symlinks: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LeakedCliTestFixturesReport {
  readonly registryEntries: readonly HubProjectRegistryEntry[];
  readonly blockedRegistryEntries: readonly BlockedLeakedCliTestRegistryEntry[];
  readonly pathHashProjectDirs: readonly string[];
  readonly selectedProjectId: string | undefined;
  readonly nextSelectedProjectId: string | undefined;
  readonly removedSelectedProjectId: string | undefined;
  readonly selectionAction: LeakedCliTestFixtureSelectionAction;
}

export interface ApplyLeakedCliTestFixturesInput extends HubProjectRegistryOptions {
  readonly apply?: boolean;
  readonly now?: Date;
  /** Dependency-injection seam used by failure-path tests. */
  readonly verifyBackupPayload?: (
    source: string,
    backup: string,
  ) => BackupTreeDigest;
  /** Dependency-injection seam used by failure-path tests. */
  readonly removeProjectDirectory?: (path: string) => void;
}

export interface ApplyLeakedCliTestFixturesResult extends LeakedCliTestFixturesReport {
  readonly applied: boolean;
  readonly backupDir?: string;
}

interface BackupPayloadManifestEntry {
  readonly kind: "registry-project" | "path-hash-run-directory";
  readonly originalPath: string;
  readonly backupRelativePath: string;
  readonly digest: BackupTreeDigest;
}

const isPathInside = (parent: string, child: string): boolean => {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

export const isTemporaryRepoPath = (repoRoot: string): boolean =>
  isPathInside(tmpdir(), repoRoot);

export const isLeakedCliTestFixtureName = (projectName: string): boolean =>
  LEAKED_CLI_TEST_FIXTURE_NAME_PATTERN.test(projectName);

export const isLeakedCliTestRegistryEntry = (
  project: HubProjectRegistryEntry,
): boolean =>
  isLeakedCliTestFixtureName(project.name) &&
  isTemporaryRepoPath(project.repoRoot);

const readJsonl = (path: string): readonly unknown[] | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  const records: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as unknown);
    } catch {
      return undefined;
    }
  }
  return records;
};

const readRunStartedRepoRoots = (
  hubProjectDir: string,
): readonly string[] | undefined => {
  const runsDir = join(hubProjectDir, "runs");
  if (!existsSync(runsDir)) {
    return undefined;
  }

  const roots: string[] = [];
  let runDirectoryCount = 0;
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    runDirectoryCount += 1;
    const events = readJsonl(join(runsDir, entry.name, "events", "run.jsonl"));
    if (!events) {
      return undefined;
    }
    const runRoots: string[] = [];
    for (const event of events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        continue;
      }
      const record = event as Record<string, unknown>;
      if (
        record.type === "run_started" &&
        typeof record.repoRoot === "string" &&
        record.repoRoot.trim().length > 0
      ) {
        runRoots.push(record.repoRoot);
      }
    }
    if (runRoots.length === 0) {
      return undefined;
    }
    roots.push(...runRoots);
  }
  return runDirectoryCount > 0 ? roots : undefined;
};

const resolveLegacyPathHashProjectId = (repoRoot: string): string =>
  createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);

export const isLeakedCliTestPathHashProjectDir = (
  hubProjectDir: string,
): boolean => {
  const projectDirName = basename(hubProjectDir);
  if (!PATH_HASH_PROJECT_DIR_PATTERN.test(projectDirName)) {
    return false;
  }
  const repoRoots = readRunStartedRepoRoots(hubProjectDir);
  if (!repoRoots || repoRoots.length === 0) {
    return false;
  }
  return repoRoots.every(
    (repoRoot) =>
      isTemporaryRepoPath(repoRoot) &&
      LEAKED_PATH_HASH_REPO_NAME_PATTERN.test(basename(repoRoot)) &&
      resolveLegacyPathHashProjectId(repoRoot) === projectDirName,
  );
};

const listPathHashProjectDirs = (projectsDir: string): readonly string[] => {
  if (!existsSync(projectsDir)) {
    return [];
  }
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && PATH_HASH_PROJECT_DIR_PATTERN.test(entry.name),
    )
    .map((entry) => join(projectsDir, entry.name))
    .sort();
};

const validateRegistryFixtureDirectory = (
  entry: HubProjectRegistryEntry,
  userDataDir: string,
): string | undefined => {
  if (!STABLE_HUB_PROJECT_ID_PATTERN.test(entry.id)) {
    return `project id ${JSON.stringify(entry.id)} is not a stable Hub project id`;
  }
  const expected = resolveRegisteredHubProjectDir(userDataDir, entry.id);
  if (resolve(entry.hubProjectDir) !== resolve(expected)) {
    return `Hub project directory is not the canonical path ${expected}`;
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(expected);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return "Hub project directory is a symbolic link";
  }
  if (!stat.isDirectory()) {
    return "Hub project path is not a directory";
  }
  return undefined;
};

const resolveSelectionPlan = (
  remaining: readonly HubProjectRegistryEntry[],
  selectedProjectId: string | undefined,
  removedIds: ReadonlySet<string>,
): {
  readonly selectionAction: LeakedCliTestFixtureSelectionAction;
  readonly nextSelectedProjectId: string | undefined;
  readonly removedSelectedProjectId: string | undefined;
} => {
  if (!selectedProjectId || !removedIds.has(selectedProjectId)) {
    return {
      selectionAction: "keep",
      nextSelectedProjectId: selectedProjectId,
      removedSelectedProjectId: undefined,
    };
  }

  const nextSelected = remaining
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))[0];
  if (!nextSelected) {
    return {
      selectionAction: "clear",
      nextSelectedProjectId: undefined,
      removedSelectedProjectId: selectedProjectId,
    };
  }

  return {
    selectionAction: "select",
    nextSelectedProjectId: nextSelected.id,
    removedSelectedProjectId: selectedProjectId,
  };
};

export const diagnoseLeakedCliTestFixtures = (
  options: HubProjectRegistryOptions = {},
): LeakedCliTestFixturesReport => {
  const projects = readHubProjectRegistry(options);
  const selected = readSelectedHubProject(options);
  const userDataDir = resolveArchloopUserDataDir(options.env, options.homeDir);
  const registryCandidates = projects.filter(isLeakedCliTestRegistryEntry);
  const registryEntries: HubProjectRegistryEntry[] = [];
  const blockedRegistryEntries: BlockedLeakedCliTestRegistryEntry[] = [];
  for (const entry of registryCandidates) {
    const reason = validateRegistryFixtureDirectory(entry, userDataDir);
    if (reason) {
      blockedRegistryEntries.push({ entry, reason });
    } else {
      registryEntries.push(entry);
    }
  }

  const removedIds = new Set(registryEntries.map((project) => project.id));
  const blockedIds = new Set(
    blockedRegistryEntries.map(({ entry }) => entry.id),
  );
  const remaining = projects.filter((project) => !removedIds.has(project.id));
  const selectableRemaining = remaining.filter(
    (project) => !blockedIds.has(project.id),
  );
  const keptProjectDirs = new Set(
    remaining.map((project) => resolve(project.hubProjectDir)),
  );

  const projectsDir = join(userDataDir, "hub", "projects");
  const pathHashProjectDirs = listPathHashProjectDirs(projectsDir).filter(
    (projectDir) =>
      !keptProjectDirs.has(resolve(projectDir)) &&
      isLeakedCliTestPathHashProjectDir(projectDir),
  );

  const selection = resolveSelectionPlan(
    selectableRemaining,
    selected?.id,
    removedIds,
  );

  return {
    registryEntries,
    blockedRegistryEntries,
    pathHashProjectDirs,
    selectedProjectId: selected?.id,
    ...selection,
  };
};

const writeRegistryProjects = (
  projects: readonly HubProjectRegistryEntry[],
  options: HubProjectRegistryOptions,
): void => {
  const registryPath = resolveHubProjectRegistryPath(options);
  mkdirSync(dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.prune-${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, projects }, null, 2)}\n`,
    "utf8",
  );
  renameSync(temporaryPath, registryPath);
};

const copyIfExists = (from: string, to: string): void => {
  if (!existsSync(from)) {
    return;
  }
  copyFileSync(from, to);
  const sourceHash = createHash("sha256")
    .update(readFileSync(from))
    .digest("hex");
  const backupHash = createHash("sha256")
    .update(readFileSync(to))
    .digest("hex");
  if (sourceHash !== backupHash) {
    throw new Error(`Backup verification failed for metadata file ${from}.`);
  }
};

export const fingerprintBackupTree = (root: string): BackupTreeDigest => {
  const hash = createHash("sha256");
  let entries = 0;
  let files = 0;
  let directories = 0;
  let symlinks = 0;
  let bytes = 0;

  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    entries += 1;
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      const target = readlinkSync(path);
      hash.update(`l\0${relativePath}\0${target}\0`);
      return;
    }
    if (stat.isDirectory()) {
      directories += 1;
      hash.update(`d\0${relativePath}\0`);
      for (const entry of readdirSync(path, { withFileTypes: true })
        .map((item) => item.name)
        .sort()) {
        visit(
          join(path, entry),
          relativePath ? join(relativePath, entry) : entry,
        );
      }
      return;
    }
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      hash.update(`f\0${relativePath}\0${stat.size}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
      return;
    }
    throw new Error(`Cannot back up unsupported filesystem entry: ${path}`);
  };

  visit(root, "");
  return {
    entries,
    files,
    directories,
    symlinks,
    bytes,
    sha256: hash.digest("hex"),
  };
};

export const verifyBackupTree = (
  source: string,
  backup: string,
): BackupTreeDigest => {
  const sourceDigest = fingerprintBackupTree(source);
  const backupDigest = fingerprintBackupTree(backup);
  if (JSON.stringify(sourceDigest) !== JSON.stringify(backupDigest)) {
    throw new Error(
      `Backup verification failed for ${source}; copied payload at ${backup} does not match the source.`,
    );
  }
  return sourceDigest;
};

const copyAndVerifyPayload = (
  source: string,
  backup: string,
  verify: (source: string, backup: string) => BackupTreeDigest,
): BackupTreeDigest => {
  cpSync(source, backup, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  return verify(source, backup);
};

const writeBackup = (
  options: ApplyLeakedCliTestFixturesInput,
  report: LeakedCliTestFixturesReport,
  now: Date,
): string => {
  const userDataDir = resolveArchloopUserDataDir(options.env, options.homeDir);
  const backupDir = join(
    userDataDir,
    "hub",
    "backups",
    `leaked-cli-test-fixtures-${now.toISOString().replace(/[:.]/g, "-")}`,
  );
  const stagingDir = `${backupDir}.partial-${process.pid}`;
  if (existsSync(backupDir)) {
    throw new Error(`Backup destination already exists: ${backupDir}`);
  }
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  try {
    copyIfExists(
      resolveHubProjectRegistryPath(options),
      join(stagingDir, "project-registry.json"),
    );
    copyIfExists(
      resolveHubProjectSelectionPath(options),
      join(stagingDir, "selected-project.json"),
    );

    const verify = options.verifyBackupPayload ?? verifyBackupTree;
    const payloads: BackupPayloadManifestEntry[] = [];
    for (const entry of report.registryEntries) {
      if (!existsSync(entry.hubProjectDir)) {
        continue;
      }
      const backupRelativePath = join("payload", "registry-projects", entry.id);
      const backupPath = join(stagingDir, backupRelativePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      payloads.push({
        kind: "registry-project",
        originalPath: entry.hubProjectDir,
        backupRelativePath,
        digest: copyAndVerifyPayload(entry.hubProjectDir, backupPath, verify),
      });
    }
    for (const projectDir of report.pathHashProjectDirs) {
      const backupRelativePath = join(
        "payload",
        "path-hash-run-directories",
        basename(projectDir),
      );
      const backupPath = join(stagingDir, backupRelativePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      payloads.push({
        kind: "path-hash-run-directory",
        originalPath: projectDir,
        backupRelativePath,
        digest: copyAndVerifyPayload(projectDir, backupPath, verify),
      });
    }

    writeFileSync(
      join(stagingDir, "manifest.json"),
      `${JSON.stringify(
        {
          version: 1,
          createdAt: now.toISOString(),
          registryEntryIds: report.registryEntries.map((entry) => entry.id),
          registryEntries: report.registryEntries,
          blockedRegistryEntries: report.blockedRegistryEntries,
          pathHashProjectDirs: report.pathHashProjectDirs,
          payloads,
          selectedProjectId: report.selectedProjectId,
          selectionAction: report.selectionAction,
          nextSelectedProjectId: report.nextSelectedProjectId,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    renameSync(stagingDir, backupDir);
    return backupDir;
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
};

export const applyLeakedCliTestFixtures = (
  input: ApplyLeakedCliTestFixturesInput = {},
): ApplyLeakedCliTestFixturesResult => {
  const report = diagnoseLeakedCliTestFixtures(input);
  const hasWork =
    report.registryEntries.length > 0 || report.pathHashProjectDirs.length > 0;
  if (!input.apply || !hasWork) {
    return {
      ...report,
      applied: false,
    };
  }

  const now = input.now ?? new Date();
  const backupDir = writeBackup(input, report, now);
  const removedIds = new Set(report.registryEntries.map((entry) => entry.id));
  const remaining = readHubProjectRegistry(input).filter(
    (project) => !removedIds.has(project.id),
  );

  // Keep registry entries until every payload deletion has succeeded. If a
  // deletion or selection update fails, the next invocation can still
  // diagnose the same candidate and converge using the completed backup.
  const removeProjectDirectory =
    input.removeProjectDirectory ??
    ((path: string): void => rmSync(path, { recursive: true, force: true }));
  for (const entry of report.registryEntries) {
    removeProjectDirectory(entry.hubProjectDir);
  }
  for (const projectDir of report.pathHashProjectDirs) {
    removeProjectDirectory(projectDir);
  }

  if (report.selectionAction === "clear") {
    const selectionPath = resolveHubProjectSelectionPath(input);
    if (existsSync(selectionPath)) {
      unlinkSync(selectionPath);
    }
  } else if (
    report.selectionAction === "select" &&
    report.nextSelectedProjectId
  ) {
    selectHubProject({
      ...input,
      projectSelector: report.nextSelectedProjectId,
      now,
    });
  }
  writeRegistryProjects(remaining, input);

  return {
    ...report,
    applied: true,
    backupDir,
  };
};

export const formatLeakedCliTestFixturesLines = (
  result: ApplyLeakedCliTestFixturesResult,
): readonly string[] => {
  const lines = [
    result.applied
      ? "Removed leaked CLI-test Hub fixtures."
      : "Leaked CLI-test Hub fixtures (dry run).",
    `Registry entries: ${result.registryEntries.length}`,
    ...result.registryEntries.map(
      (entry) =>
        `  - ${entry.name} (${entry.id}) repo=${entry.repoRoot} dir=${entry.hubProjectDir}`,
    ),
    `Blocked registry entries: ${result.blockedRegistryEntries.length}`,
    ...result.blockedRegistryEntries.map(
      ({ entry, reason }) =>
        `  - ${entry.name} (${entry.id}) preserved: ${reason}`,
    ),
    `Path-hash run directories: ${result.pathHashProjectDirs.length}`,
    ...result.pathHashProjectDirs.map((dir) => `  - ${dir}`),
  ];

  if (result.selectionAction === "clear") {
    lines.push(
      `Selection: clear ${result.removedSelectedProjectId} (no remaining projects).`,
    );
  } else if (result.selectionAction === "select") {
    lines.push(
      `Selection: replace ${result.removedSelectedProjectId} with ${result.nextSelectedProjectId}.`,
    );
  } else if (result.selectedProjectId) {
    lines.push(`Selection: keep ${result.selectedProjectId}.`);
  } else {
    lines.push("Selection: none.");
  }

  if (result.backupDir) {
    lines.push(`Backup: ${result.backupDir}`);
  } else if (!result.applied) {
    lines.push(
      "Re-run with --apply --yes to remove these fixtures after writing a verified, recoverable backup.",
    );
  }

  return lines;
};
