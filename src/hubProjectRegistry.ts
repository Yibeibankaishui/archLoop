import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { HubProjectRegistryError } from "./errors.js";
import { resolveArchloopUserDataDir } from "./projectStatus.js";
import {
  configureHubProjectDevelopmentContract,
  resolveHubProjectDevelopmentContractPath,
} from "./hubProjectDevelopmentContract.js";
import { DEFAULT_PROJECT_PROFILE_NAME } from "./InitService.js";
import { initHubTaskStore } from "./hubTaskStore.js";
import { resolveHubProjectRegistrationRepoRoot } from "./hubProjectOnboarding.js";

export interface HubProjectRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly projectProfile: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HubProjectListEntry extends HubProjectRegistryEntry {
  readonly selected: boolean;
}

interface HubProjectRegistryState {
  readonly version: 1;
  readonly projects: readonly HubProjectRegistryEntry[];
}

interface HubProjectSelectionState {
  readonly version: 1;
  readonly selectedProjectId: string;
  readonly selectedAt: string;
}

export interface HubProjectRegistryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export interface RegisterHubProjectInput extends HubProjectRegistryOptions {
  readonly repoPath: string;
  readonly projectName: string;
  readonly projectProfileName?: string;
  readonly initializeTaskStore?: boolean;
  readonly now?: Date;
  readonly generateProjectId?: () => string;
}

export interface RegisterHubProjectResult {
  readonly project: HubProjectRegistryEntry;
  readonly selectedProjectId: string;
  readonly projectDevelopmentContractPath: string;
  readonly taskStoreInitialized: boolean;
}

export interface SelectHubProjectInput extends HubProjectRegistryOptions {
  readonly projectSelector: string;
  readonly now?: Date;
}

const REGISTRY_FILE_NAME = "project-registry.json";
const SELECTION_FILE_NAME = "selected-project.json";
const EMPTY_REGISTRY_STATE: HubProjectRegistryState = {
  version: 1,
  projects: [],
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

const normalizeName = (value: string): string => value.trim().toLowerCase();

const nowIso = (now?: Date): string => (now ?? new Date()).toISOString();

const readProjectRegistryEntry = (
  value: unknown,
): HubProjectRegistryEntry | undefined => {
  const projectRecord = readObject(value);
  const id = readString(projectRecord, "id");
  const name = readString(projectRecord, "name");
  const repoRoot = readString(projectRecord, "repoRoot");
  const hubProjectDir = readString(projectRecord, "hubProjectDir");
  const projectProfile = readString(projectRecord, "projectProfile");
  const createdAt = readString(projectRecord, "createdAt");
  const updatedAt = readString(projectRecord, "updatedAt");

  if (
    !id ||
    !name ||
    !repoRoot ||
    !hubProjectDir ||
    !projectProfile ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }

  return {
    id,
    name,
    repoRoot,
    hubProjectDir,
    projectProfile,
    createdAt,
    updatedAt,
  };
};

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export const resolveHubProjectRegistryPath = (
  options: HubProjectRegistryOptions = {},
): string =>
  join(
    resolveArchloopUserDataDir(options.env, options.homeDir),
    "hub",
    REGISTRY_FILE_NAME,
  );

export const resolveHubProjectSelectionPath = (
  options: HubProjectRegistryOptions = {},
): string =>
  join(
    resolveArchloopUserDataDir(options.env, options.homeDir),
    "hub",
    SELECTION_FILE_NAME,
  );

export const resolveRegisteredHubProjectDir = (
  archloopUserDataDir: string,
  projectId: string,
): string => join(archloopUserDataDir, "hub", "projects", projectId);

const readRegistryState = (
  options: HubProjectRegistryOptions = {},
): HubProjectRegistryState => {
  const registryPath = resolveHubProjectRegistryPath(options);
  const raw = readJson<unknown>(registryPath, EMPTY_REGISTRY_STATE);
  const record = readObject(raw);
  const projects = Array.isArray(record.projects)
    ? record.projects.flatMap((project) => {
        const entry = readProjectRegistryEntry(project);
        return entry ? [entry] : [];
      })
    : [];

  return { version: 1, projects };
};

const writeRegistryState = (
  state: HubProjectRegistryState,
  options: HubProjectRegistryOptions = {},
): string => {
  const registryPath = resolveHubProjectRegistryPath(options);
  writeJson(registryPath, state);
  return registryPath;
};

const readSelectionState = (
  options: HubProjectRegistryOptions = {},
): HubProjectSelectionState | undefined => {
  const selectionPath = resolveHubProjectSelectionPath(options);
  const raw = readJson<unknown>(selectionPath, undefined);
  if (!raw) {
    return undefined;
  }
  const record = readObject(raw);
  const selectedProjectId = readString(record, "selectedProjectId");
  const selectedAt = readString(record, "selectedAt");
  if (!selectedProjectId || !selectedAt) {
    return undefined;
  }
  return { version: 1, selectedProjectId, selectedAt };
};

const writeSelectionState = (
  state: HubProjectSelectionState,
  options: HubProjectRegistryOptions = {},
): string => {
  const selectionPath = resolveHubProjectSelectionPath(options);
  writeJson(selectionPath, state);
  return selectionPath;
};

const resolveProjectDir = (
  options: HubProjectRegistryOptions,
  projectId: string,
): string =>
  resolveRegisteredHubProjectDir(
    resolveArchloopUserDataDir(options.env, options.homeDir),
    projectId,
  );

const findProjectById = (
  projects: readonly HubProjectRegistryEntry[],
  projectId: string,
): HubProjectRegistryEntry | undefined =>
  projects.find((project) => project.id === projectId);

const findProjectBySelector = (
  projects: readonly HubProjectRegistryEntry[],
  selector: string,
): HubProjectRegistryEntry | undefined => {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const byId = projects.find((project) => project.id === trimmed);
  if (byId) {
    return byId;
  }

  const normalized = normalizeName(trimmed);
  return projects.find((project) => normalizeName(project.name) === normalized);
};

const ensureUniqueProjectName = (
  projects: readonly HubProjectRegistryEntry[],
  projectName: string,
): void => {
  const normalized = normalizeName(projectName);
  const existing = projects.find(
    (project) => normalizeName(project.name) === normalized,
  );
  if (existing) {
    throw new HubProjectRegistryError({
      message:
        `Hub project name "${projectName}" is already registered for ${existing.repoRoot}. Use ` +
        `a different name with \`archloop project add\`, or \`archloop project rename\` after registration.`,
    });
  }
};

const ensureUniqueRepoRoot = (
  projects: readonly HubProjectRegistryEntry[],
  repoRoot: string,
): void => {
  const existing = projects.find((project) => project.repoRoot === repoRoot);
  if (existing) {
    throw new HubProjectRegistryError({
      message:
        `Repository path ${repoRoot} is already registered as Hub project "${existing.name}". ` +
        `Use \`archloop project select ${existing.name}\` or \`archloop project relink\` after registration.`,
    });
  }
};

export const readHubProjectRegistry = (
  options: HubProjectRegistryOptions = {},
): readonly HubProjectRegistryEntry[] => readRegistryState(options).projects;

export const listHubProjects = (
  options: HubProjectRegistryOptions = {},
): readonly HubProjectListEntry[] => {
  const projects = readRegistryState(options).projects;
  const selection = readSelectionState(options);
  return projects
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => ({
      ...project,
      selected: selection?.selectedProjectId === project.id,
    }));
};

export const readSelectedHubProject = (
  options: HubProjectRegistryOptions = {},
): HubProjectRegistryEntry | undefined => {
  const registry = readRegistryState(options).projects;
  const selection = readSelectionState(options);
  if (!selection) {
    return undefined;
  }
  return findProjectById(registry, selection.selectedProjectId);
};

export const resolveSelectedHubProject = readSelectedHubProject;

export const resolveHubProjectBySelector = (
  options: HubProjectRegistryOptions = {},
  projectSelector: string,
): HubProjectRegistryEntry => {
  const registry = readRegistryState(options).projects;
  const project = findProjectBySelector(registry, projectSelector);
  if (!project) {
    throw new HubProjectRegistryError({
      message: `No Hub project named "${projectSelector}". Run \`archloop project list\` to see registered projects.`,
    });
  }

  return project;
};

export const registerHubProject = (
  input: RegisterHubProjectInput,
): RegisterHubProjectResult => {
  const now = nowIso(input.now);
  const repoRoot = resolveHubProjectRegistrationRepoRoot(input.repoPath);

  const registry = readRegistryState(input);
  ensureUniqueProjectName(registry.projects, input.projectName);
  ensureUniqueRepoRoot(registry.projects, repoRoot);

  const projectId = `project-${input.generateProjectId?.() ?? randomUUID()}`;
  const hubProjectDir = resolveProjectDir(input, projectId);
  mkdirSync(hubProjectDir, { recursive: true });

  const projectProfile =
    input.projectProfileName ?? DEFAULT_PROJECT_PROFILE_NAME;
  const contract = configureHubProjectDevelopmentContract({
    repoRoot,
    hubProjectDir,
    projectProfileName: projectProfile,
    now: input.now,
  });

  const project: HubProjectRegistryEntry = {
    id: projectId,
    name: input.projectName.trim(),
    repoRoot,
    hubProjectDir,
    projectProfile: contract.contract.projectProfile,
    createdAt: now,
    updatedAt: now,
  };

  const nextRegistry: HubProjectRegistryState = {
    version: 1,
    projects: [...registry.projects, project],
  };
  writeRegistryState(nextRegistry, input);
  writeSelectionState(
    {
      version: 1,
      selectedProjectId: projectId,
      selectedAt: now,
    },
    input,
  );

  const taskStoreInitialized = input.initializeTaskStore
    ? Boolean(initHubTaskStore(repoRoot, input.env))
    : false;

  return {
    project,
    selectedProjectId: projectId,
    projectDevelopmentContractPath:
      resolveHubProjectDevelopmentContractPath(hubProjectDir),
    taskStoreInitialized,
  };
};

export const selectHubProject = (
  input: SelectHubProjectInput,
): HubProjectRegistryEntry => {
  const project = resolveHubProjectBySelector(input, input.projectSelector);

  writeSelectionState(
    {
      version: 1,
      selectedProjectId: project.id,
      selectedAt: nowIso(input.now),
    },
    input,
  );

  return project;
};

export const formatHubProjectRegistrySummary = (
  projects: readonly HubProjectListEntry[],
): string =>
  projects.length === 0
    ? "No Hub projects registered."
    : projects
        .map((project) => {
          const selected = project.selected ? " (selected)" : "";
          return `${project.name}${selected} - ${project.repoRoot}`;
        })
        .join("\n");
