import { existsSync } from "node:fs";

import {
  type HubProjectListEntry,
  formatHubProjectRegistrySummary,
} from "./hubProjectRegistry.js";
import {
  resolveHubProjectStatus,
  type HubProjectStatus,
} from "./projectStatus.js";
import type {
  SectionBlock,
  SectionFooterBlock,
  SectionHeaderBlock,
  SectionKvBlock,
  SectionProseBlock,
} from "./section.js";

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
  readonly resolveProjectStatus?: (
    project: HubProjectListEntry,
  ) => HubProjectStatus;
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

const createMissingRepoTaskStatus = (): HubProjectListTaskStatus => ({
  state: "missing_repo_path",
});

const createTaskStatusFromProjectStatus = (
  status: HubProjectStatus,
): HubProjectListTaskStatus => {
  if (!status.beadsAvailable) {
    return { state: "runtime_unavailable" };
  }

  if (!status.taskStoreInitialized) {
    return { state: "missing_task_store" };
  }

  return {
    state: "ready",
    counts: {
      ready: status.taskCounts.ready,
      failed: status.statusCounts.failed ?? 0,
      total: status.taskCounts.total,
    },
  };
};

const formatTaskStatusLabel = (
  taskStatus: HubProjectListTaskStatus,
): string => {
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

const formatProjectHeading = (project: HubProjectListProjection): string =>
  `${project.selected ? "*" : " "} ${project.name} [${project.projectProfile}]${project.selected ? " (selected)" : ""}`;

const formatActiveRunsLabel = (activeRunCount: number): string =>
  activeRunCount > 0 ? `active (${activeRunCount})` : "none";

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
        taskStatus: createMissingRepoTaskStatus(),
        activeRunCount: 0,
      };
    }

    const status = resolveProjectStatus(project);

    return {
      ...project,
      pathStatus,
      taskStatus: createTaskStatusFromProjectStatus(status),
      activeRunCount: status.activeBatches.length,
    };
  });
};

export const formatHubProjectListProjectionLines = (
  project: HubProjectListProjection,
): readonly string[] => {
  const lines = [
    formatProjectHeading(project),
    `  repo: ${project.repoRoot}`,
    `  path: ${project.pathStatus}`,
    `  tasks: ${formatTaskStatusLabel(project.taskStatus)}`,
    `  runs: ${formatActiveRunsLabel(project.activeRunCount)}`,
  ];

  return lines;
};

export const formatHubProjectListLines = (
  projects: readonly HubProjectListProjection[],
): readonly string[] => {
  if (projects.length === 0) {
    return [formatHubProjectRegistrySummary([])];
  }

  return projects.flatMap((project) =>
    formatHubProjectListProjectionLines(project),
  );
};

// ---------------------------------------------------------------------------
// project list summary model (Variant C section primitive)
// ---------------------------------------------------------------------------

const PROJECT_LIST_KV_GUTTER = 12;

export interface HubProjectListSummaryModel {
  readonly header: SectionHeaderBlock;
  readonly identity: SectionKvBlock;
  readonly detail: SectionProseBlock;
  readonly footer: SectionFooterBlock;
}

export const buildHubProjectListSummaryModel = (
  projections: readonly HubProjectListProjection[],
): HubProjectListSummaryModel => {
  const selected =
    projections.find((project) => project.selected)?.name ?? "none";
  const detailBody = formatHubProjectListLines(projections).join("\n");

  return {
    header: {
      kind: "header",
      title: "archLoop",
      subtitle: "project · list",
      right: `${projections.length} project${projections.length === 1 ? "" : "s"}`,
    },
    identity: {
      kind: "kv",
      gutter: PROJECT_LIST_KV_GUTTER,
      rows: [
        { key: "Projects", value: String(projections.length) },
        { key: "Selected", value: selected },
      ],
    },
    detail: {
      kind: "prose",
      body: detailBody,
    },
    footer: {
      kind: "footer",
      label: "tip",
      commands: ["archloop project select <name>", "archloop project status"],
    },
  };
};

export const hubProjectListSummaryModelToBlocks = (
  model: HubProjectListSummaryModel,
): readonly SectionBlock[] => [
  model.header,
  model.identity,
  model.detail,
  model.footer,
];
