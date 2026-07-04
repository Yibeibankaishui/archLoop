import { existsSync } from "node:fs";

import {
  type HubProjectListEntry,
  formatHubProjectRegistrySummary,
} from "./hubProjectRegistry.js";
import {
  resolveHubProjectStatus,
  type HubProjectStatus,
} from "./projectStatus.js";

export interface HubProjectListTaskCounts {
  readonly ready: number;
  readonly failed: number;
  readonly total: number;
}

export type HubProjectListTaskStatus =
  | {
      readonly state: "ready";
      readonly counts: HubProjectListTaskCounts;
    }
  | {
      readonly state: "missing_repo_path";
    }
  | {
      readonly state: "missing_task_store";
    }
  | {
      readonly state: "runtime_unavailable";
    };

export interface HubProjectListProjection extends HubProjectListEntry {
  readonly pathStatus: "valid" | "missing";
  readonly taskStatus: HubProjectListTaskStatus;
  readonly activeRunCount: number;
}

export interface ResolveHubProjectListProjectionsOptions {
  readonly pathExists?: (path: string) => boolean;
  readonly resolveProjectStatus?: (project: HubProjectListEntry) => HubProjectStatus;
}

const resolveDefaultProjectStatus = (
  project: HubProjectListEntry,
): HubProjectStatus =>
  resolveHubProjectStatus({
    cwd: project.repoRoot,
    hubProjectDir: project.hubProjectDir,
    resolveRepoRoot: () => project.repoRoot,
    ensureHubProjectDir: () => false,
  });

const formatTaskStatusLabel = (taskStatus: HubProjectListTaskStatus): string => {
  switch (taskStatus.state) {
    case "ready":
      return `ready ${taskStatus.counts.ready} / failed ${taskStatus.counts.failed} / total ${taskStatus.counts.total}`;
    case "missing_repo_path":
      return "repo path missing";
    case "missing_task_store":
      return "local task store missing";
    case "runtime_unavailable":
      return "archLoop task runtime unavailable";
  }
};

export const resolveHubProjectListProjections = (
  projects: readonly HubProjectListEntry[],
  options: ResolveHubProjectListProjectionsOptions = {},
): readonly HubProjectListProjection[] => {
  const pathExists = options.pathExists ?? existsSync;
  const resolveProjectStatus =
    options.resolveProjectStatus ?? resolveDefaultProjectStatus;

  return projects.map((project) => {
    const pathStatus = pathExists(project.repoRoot) ? "valid" : "missing";
    if (pathStatus === "missing") {
      return {
        ...project,
        pathStatus,
        taskStatus: {
          state: "missing_repo_path",
        },
        activeRunCount: 0,
      };
    }

    const status = resolveProjectStatus(project);
    const taskStatus = !status.beadsAvailable
      ? {
          state: "runtime_unavailable" as const,
        }
      : !status.taskStoreInitialized
        ? {
            state: "missing_task_store" as const,
          }
        : {
            state: "ready" as const,
            counts: {
              ready: status.taskCounts.ready,
              failed: status.statusCounts.failed ?? 0,
              total: status.taskCounts.total,
            },
          };

    return {
      ...project,
      pathStatus,
      taskStatus,
      activeRunCount: status.activeBatches.length,
    };
  });
};

export const formatHubProjectListProjectionLines = (
  project: HubProjectListProjection,
): readonly string[] => {
  const marker = project.selected ? "*" : " ";
  const lines = [
    `${marker} ${project.name} [${project.projectProfile}]${project.selected ? " (selected)" : ""}`,
    `  repo: ${project.repoRoot}`,
    `  path: ${project.pathStatus}`,
    `  tasks: ${formatTaskStatusLabel(project.taskStatus)}`,
    `  runs: ${project.activeRunCount > 0 ? `active (${project.activeRunCount})` : "none"}`,
  ];

  return lines;
};

export const formatHubProjectListLines = (
  projects: readonly HubProjectListProjection[],
): readonly string[] =>
  projects.length === 0
    ? [formatHubProjectRegistrySummary([])]
    : projects.flatMap((project) => formatHubProjectListProjectionLines(project));
