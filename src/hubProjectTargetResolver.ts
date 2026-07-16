import { HubProjectRegistryError } from "./errors.js";
import {
  listHubProjects,
  readSelectedHubProject,
  resolveHubProjectBySelector,
  type HubProjectListEntry,
  type HubProjectRegistryEntry,
  type HubProjectRegistryOptions,
} from "./hubProjectRegistry.js";

export interface ResolveHubProjectTargetInput
  extends HubProjectRegistryOptions {
  readonly projectSelector?: string;
  readonly isTTY?: boolean;
  readonly selectProject?: (
    projects: readonly HubProjectListEntry[],
  ) => Promise<string>;
}

export interface ResolveHubProjectTargetResult {
  readonly project: HubProjectRegistryEntry;
  readonly source: "explicit" | "selected" | "interactive";
}

const NO_REGISTERED_PROJECTS_MESSAGE =
  "No Hub projects are registered yet. Run `archloop project add` first.";

const NO_SELECTED_PROJECT_MESSAGE =
  "No selected Hub project exists. Run `archloop project add` to register one, `archloop project select <name>` to choose one, or pass `--project <name>`.";

const resolveInteractiveHubProjectTarget = async (
  input: ResolveHubProjectTargetInput,
  projects: readonly HubProjectListEntry[],
): Promise<ResolveHubProjectTargetResult> => {
  if (!input.selectProject) {
    throw new HubProjectRegistryError({
      message: NO_SELECTED_PROJECT_MESSAGE,
    });
  }

  const projectSelector = (await input.selectProject(projects)).trim();
  if (projectSelector.length === 0) {
    throw new HubProjectRegistryError({
      message: "Project selection cancelled.",
    });
  }

  return {
    project: resolveHubProjectBySelector(input, projectSelector),
    source: "interactive",
  };
};

export const resolveHubProjectTarget = async (
  input: ResolveHubProjectTargetInput = {},
): Promise<ResolveHubProjectTargetResult> => {
  const projectSelector = input.projectSelector?.trim();
  if (projectSelector && projectSelector.length > 0) {
    return {
      project: resolveHubProjectBySelector(input, projectSelector),
      source: "explicit",
    };
  }

  const selectedProject = readSelectedHubProject(input);
  if (selectedProject) {
    return {
      project: selectedProject,
      source: "selected",
    };
  }

  const projects = listHubProjects(input);
  if (projects.length === 0) {
    throw new HubProjectRegistryError({
      message: NO_REGISTERED_PROJECTS_MESSAGE,
    });
  }

  if (!input.isTTY) {
    throw new HubProjectRegistryError({
      message: NO_SELECTED_PROJECT_MESSAGE,
    });
  }

  return resolveInteractiveHubProjectTarget(input, projects);
};
