import { execFileSync } from "node:child_process";

import { appendBdMetadataArg } from "./bdCliArgs.js";
import { TaskBoardError } from "./errors.js";
import { recordHubTaskSyncConflict } from "./hubTaskLifecycle.js";
import { resolveBdExecutable } from "./resolveBdExecutable.js";
import {
  HUB_COLLABORATION_LABELS_TO_CLEAR,
  isCompletedHubStatus,
  loadHubTaskBoard,
  type HubTaskProjection,
  type HubTaskStatus,
} from "./taskBoard.js";

export const GITHUB_ISSUE_SYNC_LABEL = "Sandcastle";

export const HUB_EXECUTION_STATUSES = new Set<HubTaskStatus>([
  "implementing",
  "reviewing",
  "waiting_for_merge",
  "merging",
  "failed",
]);

const REMOTE_COLLABORATION_LABELS: Readonly<
  Record<string, Exclude<HubTaskStatus, "done">>
> = {
  needs_triage: "inbox",
  inbox: "inbox",
  needs_info: "needs_info",
  ready_for_agent: "ready_for_agent",
  ready_for_human: "ready_for_human",
  blocked: "blocked",
  wontfix: "wontfix",
  sync_conflict: "sync_conflict",
};

const HUB_TO_REMOTE_COLLABORATION_LABEL: Readonly<
  Partial<Record<HubTaskStatus, string>>
> = {
  inbox: "needs-triage",
  needs_info: "needs-info",
  ready_for_agent: "ready-for-agent",
  ready_for_human: "ready-for-human",
  blocked: "blocked",
  wontfix: "wontfix",
  sync_conflict: "sync-conflict",
};

export type HubSyncState =
  | "local_only"
  | "synced"
  | "pull_pending"
  | "push_pending"
  | "conflict";

export interface GithubIssueRecord {
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  readonly state: "OPEN" | "CLOSED";
  readonly labels: readonly string[];
  readonly updatedAt?: string;
}

export interface GithubIssueEditInput {
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
}

export interface GithubIssueClient {
  readonly listIssues: () => readonly GithubIssueRecord[];
  readonly editIssue: (
    issueNumber: number,
    input: GithubIssueEditInput,
  ) => void;
  readonly closeIssue: (issueNumber: number) => void;
}

export interface SyncHubTasksResult {
  readonly pulled: {
    readonly created: readonly string[];
    readonly updated: readonly string[];
    readonly conflicts: readonly string[];
    readonly duplicateCandidates: readonly HubTaskDuplicateCandidate[];
  };
  readonly pushed: {
    readonly synced: readonly string[];
    readonly pushPending: readonly string[];
    readonly closed: readonly string[];
  };
}

export interface HubTaskDuplicateCandidate {
  readonly issueNumber: number;
  readonly title: string;
  readonly localTaskIds: readonly string[];
}

export interface SyncHubTasksInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly github?: GithubIssueClient;
  readonly mode?: "sync" | "pull" | "push";
  readonly includeClosed?: boolean;
  readonly dryRun?: boolean;
}

const normalizeKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

export const formatGithubRemoteRef = (issueNumber: number): string =>
  `github#${issueNumber}`;

export const parseGithubRemoteRef = (ref: string): number | undefined => {
  const match = /^github#(\d+)$/i.exec(ref.trim());
  return match ? Number(match[1]) : undefined;
};

export const isHubExecutionStatus = (status: HubTaskStatus): boolean =>
  HUB_EXECUTION_STATUSES.has(status);

export const resolveRemoteCollaborationStatus = (
  issue: Pick<GithubIssueRecord, "state" | "labels">,
): HubTaskStatus => {
  if (issue.state === "CLOSED") {
    return issue.labels.some((label) => normalizeKey(label) === "wontfix")
      ? "wontfix"
      : "done";
  }

  for (const label of issue.labels) {
    const mapped = REMOTE_COLLABORATION_LABELS[normalizeKey(label)];
    if (mapped) {
      return mapped;
    }
  }

  return "inbox";
};

export const resolveRemoteCollaborationLabel = (
  status: HubTaskStatus,
): string | undefined => {
  if (isHubExecutionStatus(status) || status === "done") {
    return undefined;
  }
  return HUB_TO_REMOTE_COLLABORATION_LABEL[status];
};

export const detectSemanticSyncConflict = (
  localStatus: HubTaskStatus,
  remoteStatus: HubTaskStatus,
): string | undefined => {
  if (localStatus === remoteStatus) {
    return undefined;
  }

  if (isHubExecutionStatus(localStatus)) {
    return undefined;
  }

  if (
    isCompletedHubStatus(localStatus) &&
    !isCompletedHubStatus(remoteStatus)
  ) {
    return undefined;
  }

  return `local ${localStatus} disagrees with remote ${remoteStatus}`;
};

const runBdText = (
  cwd: string,
  args: readonly string[],
  failureLabel: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  try {
    return execFileSync(resolveBdExecutable(env), [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unable to execute bd";
    throw new TaskBoardError({
      message: `sandcastle ${failureLabel} requires Beads in the current repo: ${message}`,
    });
  }
};

const parseBdJsonOutput = (output: string): unknown[] => {
  const parsed = JSON.parse(output) as unknown;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of ["tasks", "issues", "items", "results", "data"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
    return [parsed];
  }
  return [];
};

const readSyncState = (
  metadata: Readonly<Record<string, unknown>>,
): HubSyncState | undefined => {
  const value = metadata.sync_state ?? metadata.syncState;
  if (
    value === "local_only" ||
    value === "synced" ||
    value === "pull_pending" ||
    value === "push_pending" ||
    value === "conflict"
  ) {
    return value;
  }
  return undefined;
};

const readRemoteUpdatedAt = (
  metadata: Readonly<Record<string, unknown>>,
): string | undefined => {
  const value = metadata.remote_updated_at ?? metadata.remoteUpdatedAt;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const buildGithubIssueIndex = (
  tasks: readonly HubTaskProjection[],
): Map<number, HubTaskProjection> => {
  const index = new Map<number, HubTaskProjection>();
  for (const task of tasks) {
    for (const ref of task.remoteRefs) {
      const issueNumber = parseGithubRemoteRef(ref);
      if (issueNumber !== undefined) {
        index.set(issueNumber, task);
      }
    }
  }
  return index;
};

const findTitleDuplicateCandidates = (
  tasks: readonly HubTaskProjection[],
  issueTitle: string,
): readonly HubTaskProjection[] => {
  const normalizedTitle = normalizeKey(issueTitle);
  return tasks.filter((task) => normalizeKey(task.title) === normalizedTitle);
};

const readGithubIssueNumber = (
  task: Pick<HubTaskProjection, "remoteRefs">,
): number | undefined =>
  task.remoteRefs
    .map(parseGithubRemoteRef)
    .find((value) => value !== undefined);

const updateHubTaskRecord = (
  cwd: string,
  taskId: string,
  args: string[],
  failureLabel: string,
  env: NodeJS.ProcessEnv,
): void => {
  runBdText(cwd, ["update", taskId, ...args], failureLabel, env);
};

const setHubTaskSyncMetadata = (
  cwd: string,
  task: HubTaskProjection,
  metadataPatch: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): void => {
  const metadataArgs: string[] = [];
  appendBdMetadataArg(metadataArgs, {
    ...task.metadata,
    ...metadataPatch,
  });
  updateHubTaskRecord(cwd, task.id, metadataArgs, `tasks sync ${task.id}`, env);
};

const importGithubIssueToBeads = (
  cwd: string,
  issue: GithubIssueRecord,
  env: NodeJS.ProcessEnv,
): string => {
  const hubStatus = resolveRemoteCollaborationStatus(issue);
  const label = resolveRemoteCollaborationLabel(hubStatus) ?? "needs-triage";
  const remoteRef = formatGithubRemoteRef(issue.number);
  const metadata = {
    origin: "github-issues",
    github_issue: issue.number,
    remote_refs: [remoteRef],
    sync_state: "synced" as const,
    hubStatus,
    ...(issue.updatedAt ? { remote_updated_at: issue.updatedAt } : {}),
  };

  const args = ["create", issue.title];
  if (issue.body) {
    args.push("--description", issue.body);
  }
  args.push(
    "--type",
    "task",
    "-l",
    label,
    "--metadata",
    JSON.stringify(metadata),
    "--json",
  );

  const output = runBdText(cwd, args, "tasks sync pull", env);
  const [created] = parseBdJsonOutput(output);
  const record =
    created && typeof created === "object"
      ? (created as Record<string, unknown>)
      : {};

  return String(record.id ?? record.key ?? "unknown");
};

const refreshLinkedGithubIssue = (
  cwd: string,
  task: HubTaskProjection,
  issue: GithubIssueRecord,
  env: NodeJS.ProcessEnv,
  dryRun = false,
): "updated" | "conflict" | "unchanged" => {
  const remoteStatus = resolveRemoteCollaborationStatus(issue);
  const conflict = detectSemanticSyncConflict(task.hubStatus, remoteStatus);
  const syncState = readSyncState(task.metadata);
  const remoteUpdatedAt = readRemoteUpdatedAt(task.metadata);
  const metadataPatch: Record<string, unknown> =
    issue.updatedAt !== undefined ? { remote_updated_at: issue.updatedAt } : {};

  if (
    syncState === "push_pending" ||
    syncState === "local_only" ||
    isHubExecutionStatus(task.hubStatus)
  ) {
    if (
      issue.updatedAt !== undefined &&
      issue.updatedAt !== remoteUpdatedAt &&
      syncState !== "local_only"
    ) {
      if (dryRun) {
        return "updated";
      }
      setHubTaskSyncMetadata(cwd, task, metadataPatch, env);
      return "updated";
    }
    return "unchanged";
  }

  const remoteChanged =
    issue.updatedAt !== undefined && issue.updatedAt !== remoteUpdatedAt;

  if (conflict && (remoteChanged || syncState === "synced")) {
    if (dryRun) {
      return "conflict";
    }
    recordHubTaskSyncConflict({
      cwd,
      taskId: task.id,
      reason: conflict,
      env,
    });
    return "conflict";
  }

  const titleChanged = task.title !== issue.title;
  const descriptionChanged =
    (task.description ?? "") !== (issue.body ?? "") && issue.body !== undefined;

  if (titleChanged || descriptionChanged) {
    if (dryRun) {
      return "updated";
    }
    const args: string[] = [];
    appendBdMetadataArg(args, {
      ...task.metadata,
      ...metadataPatch,
      sync_state: "synced",
    });
    if (titleChanged) {
      args.unshift("--title", issue.title);
    }
    if (descriptionChanged && issue.body) {
      args.unshift("--description", issue.body);
    }
    updateHubTaskRecord(cwd, task.id, args, `tasks sync pull ${task.id}`, env);
    return "updated";
  }

  if (remoteUpdatedAt !== issue.updatedAt || syncState !== "synced") {
    if (dryRun) {
      return "updated";
    }
    setHubTaskSyncMetadata(
      cwd,
      task,
      {
        ...metadataPatch,
        sync_state: "synced",
      },
      env,
    );
    return "updated";
  }

  return "unchanged";
};

const pushHubTaskToGithub = (
  task: HubTaskProjection,
  issue: GithubIssueRecord | undefined,
  github: GithubIssueClient,
  dryRun = false,
): "synced" | "push_pending" | "closed" | "skipped" => {
  const issueNumber = readGithubIssueNumber(task);

  if (issueNumber === undefined) {
    return "skipped";
  }

  if (isHubExecutionStatus(task.hubStatus)) {
    return "skipped";
  }

  if (dryRun) {
    if (isCompletedHubStatus(task.hubStatus)) {
      return issue?.state === "CLOSED" ? "synced" : "closed";
    }

    const remoteLabel = resolveRemoteCollaborationLabel(task.hubStatus);
    return remoteLabel ? "synced" : "skipped";
  }

  try {
    if (isCompletedHubStatus(task.hubStatus)) {
      if (task.hubStatus === "wontfix") {
        if (!(issue?.labels ?? task.labels).includes("wontfix")) {
          github.editIssue(issueNumber, { addLabels: ["wontfix"] });
        }
      }
      if (issue?.state !== "CLOSED") {
        github.closeIssue(issueNumber);
        return "closed";
      }
      return "synced";
    }

    const remoteLabel = resolveRemoteCollaborationLabel(task.hubStatus);
    if (!remoteLabel) {
      return "skipped";
    }

    const removeLabels = HUB_COLLABORATION_LABELS_TO_CLEAR.filter((label) =>
      (issue?.labels ?? task.labels).includes(label),
    ).filter((label) => label !== remoteLabel);

    github.editIssue(issueNumber, {
      addLabels: [remoteLabel],
      removeLabels,
    });
    return "synced";
  } catch {
    return "push_pending";
  }
};

const updateHubTaskSyncState = (
  cwd: string,
  task: HubTaskProjection,
  syncState: HubSyncState,
  env: NodeJS.ProcessEnv,
): void => {
  setHubTaskSyncMetadata(cwd, task, { sync_state: syncState }, env);
};

const pullGithubIssues = (
  cwd: string,
  issues: readonly GithubIssueRecord[],
  env: NodeJS.ProcessEnv,
  includeClosed = false,
  dryRun = false,
): SyncHubTasksResult["pulled"] => {
  const board = loadHubTaskBoard(cwd, env);
  const linkedTasks = buildGithubIssueIndex(board.tasks);
  const created: string[] = [];
  const updated: string[] = [];
  const conflicts: string[] = [];
  const duplicateCandidates: HubTaskDuplicateCandidate[] = [];

  for (const issue of issues) {
    if (!includeClosed && issue.state === "CLOSED") {
      continue;
    }

    const linked = linkedTasks.get(issue.number);
    if (!linked) {
      const sameTitleTasks = findTitleDuplicateCandidates(
        board.tasks,
        issue.title,
      );
      if (sameTitleTasks.length > 0) {
        duplicateCandidates.push({
          issueNumber: issue.number,
          title: issue.title,
          localTaskIds: sameTitleTasks.map((task) => task.id),
        });
        continue;
      }
      if (dryRun) {
        created.push(formatGithubRemoteRef(issue.number));
        continue;
      }
      created.push(importGithubIssueToBeads(cwd, issue, env));
      continue;
    }

    const outcome = refreshLinkedGithubIssue(cwd, linked, issue, env, dryRun);
    if (outcome === "conflict") {
      conflicts.push(linked.id);
    } else if (outcome === "updated") {
      updated.push(linked.id);
    }
  }

  return { created, updated, conflicts, duplicateCandidates };
};

const pushHubTasks = (
  cwd: string,
  issues: readonly GithubIssueRecord[],
  env: NodeJS.ProcessEnv,
  github: GithubIssueClient,
  dryRun = false,
): SyncHubTasksResult["pushed"] => {
  const board = loadHubTaskBoard(cwd, env);
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const synced: string[] = [];
  const pushPending: string[] = [];
  const closed: string[] = [];

  for (const task of board.tasks) {
    const issueNumber = readGithubIssueNumber(task);
    if (issueNumber === undefined) {
      continue;
    }

    const syncState = readSyncState(task.metadata);
    if (syncState === "conflict" || task.hubStatus === "sync_conflict") {
      continue;
    }

    const outcome = pushHubTaskToGithub(
      task,
      issuesByNumber.get(issueNumber),
      github,
      dryRun,
    );

    if (outcome === "skipped") {
      continue;
    }

    if (outcome === "push_pending") {
      pushPending.push(task.id);
      if (!dryRun && syncState !== "push_pending") {
        updateHubTaskSyncState(cwd, task, "push_pending", env);
      }
      continue;
    }

    if (outcome === "closed") {
      closed.push(task.id);
      const existingIssue = issuesByNumber.get(issueNumber);
      issuesByNumber.set(issueNumber, {
        number: issueNumber,
        title: existingIssue?.title ?? task.title,
        body: existingIssue?.body,
        state: "CLOSED",
        labels: existingIssue?.labels ?? task.labels,
        updatedAt: existingIssue?.updatedAt,
      });
    } else {
      synced.push(task.id);
    }

    if (!dryRun && syncState !== "synced") {
      updateHubTaskSyncState(cwd, task, "synced", env);
    }
  }

  return { synced, pushPending, closed };
};

const parseGithubIssuesJson = (output: string): GithubIssueRecord[] => {
  const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
  return parsed.map((issue) => ({
    number: Number(issue.number),
    title: String(issue.title ?? ""),
    body: typeof issue.body === "string" ? issue.body : undefined,
    state:
      String(issue.state ?? "OPEN").toUpperCase() === "CLOSED"
        ? "CLOSED"
        : "OPEN",
    labels: Array.isArray(issue.labels)
      ? issue.labels.flatMap((label) => {
          if (typeof label === "string") {
            return [label];
          }
          if (label && typeof label === "object") {
            const name = (label as Record<string, unknown>).name;
            return typeof name === "string" ? [name] : [];
          }
          return [];
        })
      : [],
    updatedAt:
      typeof issue.updatedAt === "string"
        ? issue.updatedAt
        : typeof issue.updated_at === "string"
          ? issue.updated_at
          : undefined,
  }));
};

const runGhJson = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string => {
  try {
    return execFileSync("gh", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unable to execute gh";
    throw new TaskBoardError({
      message: `sandcastle tasks sync requires GitHub CLI access: ${message}`,
    });
  }
};

export interface DefaultGithubIssueClientOptions {
  readonly includeClosed?: boolean;
}

export const createDefaultGithubIssueClient = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DefaultGithubIssueClientOptions = {},
): GithubIssueClient => ({
  listIssues: () =>
    parseGithubIssuesJson(
      runGhJson(
        cwd,
        [
          "issue",
          "list",
          "--state",
          options.includeClosed === true ? "all" : "open",
          "-l",
          GITHUB_ISSUE_SYNC_LABEL,
          "--json",
          "number,title,body,state,labels,updatedAt",
          "--limit",
          "1000",
        ],
        env,
      ),
    ),
  editIssue: (issueNumber, input) => {
    const args = ["issue", "edit", String(issueNumber)];
    if (input.addLabels && input.addLabels.length > 0) {
      args.push("--add-label", input.addLabels.join(","));
    }
    if (input.removeLabels && input.removeLabels.length > 0) {
      args.push("--remove-label", input.removeLabels.join(","));
    }
    runGhJson(cwd, args, env);
  },
  closeIssue: (issueNumber) => {
    runGhJson(cwd, ["issue", "close", String(issueNumber)], env);
  },
});

export const syncHubTasksWithGithub = (
  input: SyncHubTasksInput,
): SyncHubTasksResult => {
  const env = input.env ?? process.env;
  const dryRun = input.dryRun === true;
  const mode = input.mode ?? "sync";
  const includeClosed = input.includeClosed === true;
  const github =
    input.github ??
    createDefaultGithubIssueClient(input.cwd, env, {
      includeClosed: mode === "push" || includeClosed,
    });
  const issues = github.listIssues();
  const pulled =
    mode === "push"
      ? { created: [], updated: [], conflicts: [], duplicateCandidates: [] }
      : pullGithubIssues(input.cwd, issues, env, includeClosed, dryRun);
  const pushed =
    mode === "pull"
      ? { synced: [], pushPending: [], closed: [] }
      : pushHubTasks(input.cwd, issues, env, github, dryRun);
  return { pulled, pushed };
};

const formatDuplicateCandidate = (
  candidate: HubTaskDuplicateCandidate,
): string =>
  `github#${candidate.issueNumber} -> ${candidate.localTaskIds.join(", ")}`;

export const formatHubTaskSyncPreviewLines = (
  result: SyncHubTasksResult,
): readonly string[] => {
  const lines = ["Hub task sync preview"];
  lines.push(
    `Pull: ${result.pulled.created.length} create, ${result.pulled.updated.length} update, ${result.pulled.conflicts.length} conflict`,
  );
  if (result.pulled.duplicateCandidates.length > 0) {
    lines.push(
      `Duplicate link candidates: ${result.pulled.duplicateCandidates
        .map(formatDuplicateCandidate)
        .join(" | ")}`,
    );
  }
  lines.push(
    `Push: ${result.pushed.synced.length} synced, ${result.pushed.closed.length} closed, ${result.pushed.pushPending.length} push pending`,
  );
  return lines;
};

export const formatHubTaskSyncSummaryLines = (
  result: SyncHubTasksResult,
): readonly string[] => {
  const lines = ["Synced Hub tasks with GitHub Issues"];
  lines.push(
    `Pulled: ${result.pulled.created.length} created, ${result.pulled.updated.length} updated, ${result.pulled.conflicts.length} conflicts, ${result.pulled.duplicateCandidates.length} duplicate candidates`,
  );
  lines.push(
    `Pushed: ${result.pushed.synced.length} synced, ${result.pushed.closed.length} closed, ${result.pushed.pushPending.length} push pending`,
  );
  return lines;
};
