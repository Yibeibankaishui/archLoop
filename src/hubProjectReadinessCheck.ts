import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { HubProjectStatus } from "./projectStatus.js";
import {
  resolveHubProjectStatus,
  resolveArchloopUserDataDir,
  resolveGitRepoRoot,
} from "./projectStatus.js";
import type { HubProjectRegistryEntry } from "./hubProjectRegistry.js";
import { isHubOwnedTaskStoreKind } from "./hubTaskStoreResolver.js";
import {
  formatReadinessCheckLines,
  type HubReadinessCheckReport,
  type HubReadinessFinding,
  type HubReadinessSection,
} from "./hubReadinessCheck.js";

export interface HubProjectReadinessCheckOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly resolveProjectStatus?: (
    project: HubProjectRegistryEntry,
  ) => HubProjectStatus;
}

export interface HubProjectReadinessCheckReport extends HubReadinessCheckReport {
  readonly project: HubProjectRegistryEntry;
}

const createFinding = (
  severity: HubReadinessFinding["severity"],
  title: string,
  message: string,
): HubReadinessFinding => ({
  severity,
  title,
  message,
});

const createSection = (
  title: string,
  findings: readonly HubReadinessFinding[],
): HubReadinessSection => ({
  title,
  findings,
});

const repoPathSection = (
  project: HubProjectRegistryEntry,
): {
  readonly repoRoot: string | undefined;
  readonly section: HubReadinessSection;
  readonly blocked: boolean;
} => {
  if (!existsSync(project.repoRoot)) {
    return {
      repoRoot: undefined,
      blocked: true,
      section: createSection("Checking repository path", [
        createFinding(
          "error",
          "Repository path missing",
          `Hub project ${project.name} points at ${project.repoRoot}, but that path does not exist. Run \`archloop project relink ${project.name} --path <repo-path>\` after moving the repo or choose a different project path.`,
        ),
      ]),
    };
  }

  return {
    repoRoot: project.repoRoot,
    blocked: false,
    section: createSection("Checking repository path", [
      createFinding(
        "success",
        "Repository path exists",
        `Repository path exists at ${project.repoRoot}.`,
      ),
    ]),
  };
};

const gitRepoSection = (
  project: HubProjectRegistryEntry,
  repoRoot: string,
): {
  readonly gitRepoRoot: string | undefined;
  readonly section: HubReadinessSection;
  readonly blocked: boolean;
} => {
  try {
    const gitRepoRoot = resolveGitRepoRoot(repoRoot);
    return {
      gitRepoRoot,
      blocked: false,
      section: createSection("Checking git repository", [
        createFinding(
          "success",
          "Git repository valid",
          `Git repository root: ${gitRepoRoot}.`,
        ),
      ]),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      gitRepoRoot: undefined,
      blocked: true,
      section: createSection("Checking git repository", [
        createFinding(
          "error",
          "Invalid git repository",
          `Hub project ${project.name} points at ${repoRoot}, but that path is not a usable git repository. ${detail}`,
        ),
      ]),
    };
  }
};

const initialCommitSection = (
  project: HubProjectRegistryEntry,
  repoRoot: string,
): {
  readonly section: HubReadinessSection;
  readonly blocked: boolean;
} => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      blocked: false,
      section: createSection("Checking initial commit", [
        createFinding(
          "success",
          "Initial commit present",
          "Initial commit present.",
        ),
      ]),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      blocked: true,
      section: createSection("Checking initial commit", [
        createFinding(
          "error",
          "Initial commit missing",
          `Hub project ${project.name} at ${repoRoot} has no initial commit yet. Run \`git commit -m \"Initial commit\"\` in the repository or relink the project to a committed repo. ${detail}`,
        ),
      ]),
    };
  }
};

const buildDevelopmentContractSection = (
  project: HubProjectRegistryEntry,
  status: HubProjectStatus,
): HubReadinessSection => {
  if (status.projectDevelopmentContractPersisted) {
    return createSection("Checking development contract", [
      createFinding(
        "success",
        "Development contract persisted",
        `Hub project development contract is persisted at ${status.projectDevelopmentContractPath}.`,
      ),
    ]);
  }

  return createSection("Checking development contract", [
    createFinding(
      "warn",
      "Using fallback development contract",
      `Hub project development contract is using the fallback generic contract at ${status.projectDevelopmentContractPath}. Run \`archloop project configure --project ${project.name} --project-profile ${status.projectProfile ?? "generic"}\` to specialize it.`,
    ),
  ]);
};

const buildTaskStoreSection = (
  status: HubProjectStatus,
): HubReadinessSection => {
  if (!status.beadsAvailable) {
    return createSection("Checking local task store", [
      createFinding(
        "warn",
        "Task runtime unavailable",
        "archLoop task runtime unavailable. Install dependencies, set ARCHLOOP_BD_PATH, or ensure the bundled Beads runtime is available.",
      ),
    ]);
  }

  if (status.taskStoreRedirectError) {
    return createSection("Checking local task store", [
      createFinding(
        "error",
        "Task store redirect is invalid",
        status.taskStoreRedirectError,
      ),
    ]);
  }

  if (status.taskStoreInitialized) {
    const message = isHubOwnedTaskStoreKind(status.taskStoreKind)
      ? `Hub-owned task store is initialized at ${status.taskStoreDir}.`
      : status.taskStoreKind === "legacy"
        ? "Repository-local Beads store is initialized and will migrate automatically on the next mutating Hub command."
        : "Local task store is initialized.";
    return createSection("Checking local task store", [
      createFinding("success", "Local task store is initialized", message),
    ]);
  }

  return createSection("Checking local task store", [
    createFinding(
      "warn",
      "Local task store is missing",
      "Local task store not initialized. Run `archloop tasks init` in this repository first.",
    ),
  ]);
};

const buildTaskSummarySection = (
  status: HubProjectStatus,
): HubReadinessSection => {
  const taskStoreReady = status.beadsAvailable && status.taskStoreInitialized;
  const message = taskStoreReady
    ? `Ready tasks: ${status.taskCounts.ready}. Failed tasks: ${status.failedTasks.length}. Total: ${status.taskCounts.total}.`
    : "Task summary is unavailable until the local task store is initialized.";

  return createSection("Checking task summary", [
    createFinding(taskStoreReady ? "success" : "warn", "Task summary", message),
  ]);
};

const buildFailedTaskSection = (
  status: HubProjectStatus,
): HubReadinessSection => {
  if (status.failedTasks.length === 0) {
    return createSection("Checking failed task summary", [
      createFinding("success", "Failed tasks", "No failed tasks."),
    ]);
  }

  return createSection("Checking failed task summary", [
    createFinding(
      "warn",
      "Failed tasks detected",
      status.failedTasks
        .map(
          (task) =>
            `  ${task.id}: ${task.failureReason ?? "unknown"} - ${task.nextAction}`,
        )
        .join("\n"),
    ),
  ]);
};

const formatActiveRunLine = (
  batch: HubProjectStatus["activeBatches"][number],
): string => {
  const details: string[] = [];
  if (batch.flowId) {
    details.push(`flow ${batch.flowId}`);
  }
  if (batch.taskCount !== undefined) {
    details.push(`${batch.taskCount} tasks`);
  }

  const detailSuffix = details.length === 0 ? "" : ` (${details.join(", ")})`;
  return `  ${batch.runId} / ${batch.batchId}: ${batch.status}${detailSuffix}\n    Run directory: ${batch.runDir}`;
};

const buildActiveRunsSection = (
  status: HubProjectStatus,
): HubReadinessSection => {
  if (status.activeBatches.length === 0) {
    return createSection("Checking active runs", [
      createFinding("success", "Active runs", "No active Hub runs."),
    ]);
  }

  return createSection("Checking active runs", [
    createFinding(
      "success",
      "Active runs",
      [
        `Active runs: ${status.activeBatches.length}.`,
        ...status.activeBatches.map((batch) => formatActiveRunLine(batch)),
      ].join("\n"),
    ),
  ]);
};

const buildFlowReadinessSection = (
  status: HubProjectStatus,
  repoRoot: string,
  gitRepoRoot: string,
): HubReadinessSection => {
  const repoPathExists = existsSync(repoRoot);
  const gitRepoValid = gitRepoRoot.length > 0;
  const flowReady =
    repoPathExists &&
    gitRepoValid &&
    status.projectDevelopmentContractPersisted &&
    status.taskStoreInitialized;

  if (flowReady) {
    return createSection("Checking flow readiness signals", [
      createFinding(
        "success",
        "Project ready for flows",
        "Project is ready for flow execution.",
      ),
    ]);
  }

  return createSection("Checking flow readiness signals", [
    createFinding(
      "warn",
      "Project not fully ready for flows",
      [
        `Repo path: ${repoPathExists ? "exists" : "missing"}.`,
        `Git repo: ${gitRepoValid ? "valid" : "invalid"}.`,
        `Development contract: ${status.projectDevelopmentContractPersisted ? "persisted" : "fallback"}.`,
        `Local task store: ${status.taskStoreInitialized ? "initialized" : "missing"}.`,
      ].join("\n"),
    ),
  ]);
};

const resolveDefaultProjectStatus = (
  project: HubProjectRegistryEntry,
  options: HubProjectReadinessCheckOptions,
): HubProjectStatus =>
  resolveHubProjectStatus({
    cwd: project.repoRoot,
    archloopUserDataDir: resolveArchloopUserDataDir(
      options.env,
      options.homeDir,
    ),
    hubProjectDir: project.hubProjectDir,
    resolveRepoRoot: () => project.repoRoot,
    ensureHubProjectDir: () => false,
  });

export const collectHubProjectReadinessCheck = async (
  project: HubProjectRegistryEntry,
  options: HubProjectReadinessCheckOptions = {},
): Promise<HubProjectReadinessCheckReport> => {
  const createEarlyExitReport = (
    sections: readonly HubReadinessSection[],
  ): HubProjectReadinessCheckReport => ({
    project,
    sections,
    hasWarnings: false,
    hasErrors: true,
  });

  const repoPath = repoPathSection(project);
  const sections: HubReadinessSection[] = [repoPath.section];

  if (repoPath.blocked || !repoPath.repoRoot) {
    return createEarlyExitReport(sections);
  }

  const gitRepo = gitRepoSection(project, repoPath.repoRoot);
  sections.push(gitRepo.section);
  if (gitRepo.blocked || !gitRepo.gitRepoRoot) {
    return createEarlyExitReport(sections);
  }

  const initialCommit = initialCommitSection(project, gitRepo.gitRepoRoot);
  sections.push(initialCommit.section);
  if (initialCommit.blocked) {
    return createEarlyExitReport(sections);
  }

  const status =
    options.resolveProjectStatus?.(project) ??
    resolveDefaultProjectStatus(project, options);
  sections.push(buildDevelopmentContractSection(project, status));
  sections.push(buildTaskStoreSection(status));
  sections.push(buildTaskSummarySection(status));
  sections.push(buildFailedTaskSection(status));
  sections.push(buildActiveRunsSection(status));
  sections.push(
    buildFlowReadinessSection(status, repoPath.repoRoot, gitRepo.gitRepoRoot),
  );

  const hasWarnings = sections.some((section) =>
    section.findings.some((finding) => finding.severity === "warn"),
  );
  const hasErrors = sections.some((section) =>
    section.findings.some((finding) => finding.severity === "error"),
  );

  return {
    project,
    sections,
    hasWarnings,
    hasErrors,
  };
};

export const formatHubProjectReadinessCheckLines = (
  project: HubProjectRegistryEntry,
  report: HubProjectReadinessCheckReport,
): readonly string[] =>
  formatReadinessCheckLines(
    `Hub project readiness check: ${project.name}`,
    report,
    "Hub project readiness check",
  );
