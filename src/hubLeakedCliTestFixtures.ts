import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { tmpdir } from "node:os";

import {
  readHubProjectRegistry,
  readSelectedHubProject,
  resolveHubProjectRegistryPath,
  resolveHubProjectSelectionPath,
  selectHubProject,
  type HubProjectRegistryEntry,
  type HubProjectRegistryOptions,
} from "./hubProjectRegistry.js";
import { resolveArchloopUserDataDir } from "./projectStatus.js";

export const LEAKED_CLI_TEST_FIXTURE_NAME_PATTERN = /^(cli-host-|cli-resolve-)/;
export const PATH_HASH_PROJECT_DIR_PATTERN = /^[a-f0-9]{12}$/;

export type LeakedCliTestFixtureSelectionAction = "keep" | "select" | "clear";

export interface LeakedCliTestFixturesReport {
  readonly registryEntries: readonly HubProjectRegistryEntry[];
  readonly pathHashProjectDirs: readonly string[];
  readonly selectedProjectId: string | undefined;
  readonly nextSelectedProjectId: string | undefined;
  readonly removedSelectedProjectId: string | undefined;
  readonly selectionAction: LeakedCliTestFixtureSelectionAction;
}

export interface ApplyLeakedCliTestFixturesInput extends HubProjectRegistryOptions {
  readonly apply?: boolean;
  readonly now?: Date;
}

export interface ApplyLeakedCliTestFixturesResult extends LeakedCliTestFixturesReport {
  readonly applied: boolean;
  readonly backupDir?: string;
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

const readJsonl = (path: string): readonly unknown[] => {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return [];
      }
      try {
        return [JSON.parse(trimmed) as unknown];
      } catch {
        return [];
      }
    });
};

const readRunStartedRepoRoots = (hubProjectDir: string): readonly string[] => {
  const runsDir = join(hubProjectDir, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }

  const roots: string[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const event of readJsonl(
      join(runsDir, entry.name, "events", "run.jsonl"),
    )) {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        continue;
      }
      const record = event as Record<string, unknown>;
      if (
        record.type === "run_started" &&
        typeof record.repoRoot === "string" &&
        record.repoRoot.trim().length > 0
      ) {
        roots.push(record.repoRoot);
      }
    }
  }
  return roots;
};

export const isLeakedCliTestPathHashProjectDir = (
  hubProjectDir: string,
): boolean => {
  if (!PATH_HASH_PROJECT_DIR_PATTERN.test(basename(hubProjectDir))) {
    return false;
  }
  const repoRoots = readRunStartedRepoRoots(hubProjectDir);
  if (repoRoots.length === 0) {
    return false;
  }
  return repoRoots.every(
    (repoRoot) =>
      isTemporaryRepoPath(repoRoot) &&
      isLeakedCliTestFixtureName(basename(repoRoot)),
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
  const registryEntries = projects.filter(isLeakedCliTestRegistryEntry);
  const removedIds = new Set(registryEntries.map((project) => project.id));
  const remaining = projects.filter((project) => !removedIds.has(project.id));
  const keptProjectDirs = new Set(
    remaining.map((project) => resolve(project.hubProjectDir)),
  );

  const userDataDir = resolveArchloopUserDataDir(options.env, options.homeDir);
  const projectsDir = join(userDataDir, "hub", "projects");
  const pathHashProjectDirs = listPathHashProjectDirs(projectsDir).filter(
    (projectDir) =>
      !keptProjectDirs.has(resolve(projectDir)) &&
      isLeakedCliTestPathHashProjectDir(projectDir),
  );

  const selection = resolveSelectionPlan(remaining, selected?.id, removedIds);

  return {
    registryEntries,
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
  writeFileSync(
    registryPath,
    `${JSON.stringify({ version: 1, projects }, null, 2)}\n`,
    "utf8",
  );
};

const copyIfExists = (from: string, to: string): void => {
  if (!existsSync(from)) {
    return;
  }
  copyFileSync(from, to);
};

const writeBackup = (
  options: HubProjectRegistryOptions,
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
  mkdirSync(backupDir, { recursive: true });
  copyIfExists(
    resolveHubProjectRegistryPath(options),
    join(backupDir, "project-registry.json"),
  );
  copyIfExists(
    resolveHubProjectSelectionPath(options),
    join(backupDir, "selected-project.json"),
  );
  writeFileSync(
    join(backupDir, "manifest.json"),
    `${JSON.stringify(
      {
        createdAt: now.toISOString(),
        registryEntryIds: report.registryEntries.map((entry) => entry.id),
        registryEntries: report.registryEntries,
        pathHashProjectDirs: report.pathHashProjectDirs,
        selectedProjectId: report.selectedProjectId,
        selectionAction: report.selectionAction,
        nextSelectedProjectId: report.nextSelectedProjectId,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return backupDir;
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
  writeRegistryProjects(remaining, input);

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

  for (const entry of report.registryEntries) {
    rmSync(entry.hubProjectDir, { recursive: true, force: true });
  }
  for (const projectDir of report.pathHashProjectDirs) {
    rmSync(projectDir, { recursive: true, force: true });
  }

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
      "Re-run with --apply --yes to remove these fixtures after writing a recoverable backup.",
    );
  }

  return lines;
};
