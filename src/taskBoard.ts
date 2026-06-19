import { execFileSync } from "node:child_process";

import type { PrdWarningSeverity } from "./hubPrdDecomposition.js";
import {
  formatPrdWarningDetailsRow,
  formatPrdWarningListSuffix,
  formatPrdWarningSummaryLine,
  matchesPrdWarningFilter,
  readPrdWarningFromTask,
  summarizeTasksPrdWarnings,
} from "./hubPrdWarning.js";
import {
  appendHubTaskEvent,
  createHubRunContext,
  createHubTaskClaimMetadata,
  isHubTaskClaimActive,
  readHubTaskClaim,
  resolveHubTaskClaimState,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import {
  appendBdAddLabelArgs,
  appendBdMetadataArg,
  appendBdRemoveLabelArgs,
} from "./bdCliArgs.js";
import { TaskBoardError } from "./errors.js";
import { resolveBdExecutable } from "./resolveBdExecutable.js";

export const HUB_TASK_STATUSES = [
  "inbox",
  "needs_info",
  "ready_for_agent",
  "ready_for_human",
  "blocked",
  "implementing",
  "reviewing",
  "waiting_for_merge",
  "merging",
  "done",
  "wontfix",
  "failed",
  "sync_conflict",
] as const;

export type HubTaskStatus = (typeof HUB_TASK_STATUSES)[number];

const HUB_TASK_STATUS_SET = new Set<string>(HUB_TASK_STATUSES);
const BEADS_LIFECYCLE_STATUSES = new Set([
  "open",
  "in_progress",
  "blocked",
  "closed",
]);
const TASK_STATUS_KEYS = [
  "hub_status",
  "hubStatus",
  "task_status",
  "taskStatus",
  "hub_state",
  "hubState",
  "triage_status",
  "triageStatus",
  "task_board_status",
  "taskBoardStatus",
] as const;
const BEADS_LIFECYCLE_KEYS = ["state", "status", "lifecycle"] as const;
const METADATA_STATUS_RULES = [
  {
    keys: [
      "blocked_reason",
      "blockedReason",
      "blocked_reason_kind",
      "blockedReasonKind",
      "blocked",
    ] as const,
    status: "blocked" as const,
  },
  {
    keys: [
      "needs_info",
      "needsInfo",
      "needs_info_reason",
      "needsInfoReason",
    ] as const,
    status: "needs_info" as const,
  },
  {
    keys: [
      "failed",
      "failedReason",
      "failure_reason",
      "failureReason",
    ] as const,
    status: "failed" as const,
  },
  {
    keys: [
      "sync_conflict",
      "syncConflict",
      "sync_conflict_reason",
      "syncConflictReason",
    ] as const,
    status: "sync_conflict" as const,
  },
  {
    keys: ["wontfix", "wontFix", "rejected"] as const,
    status: "wontfix" as const,
  },
] as const;
const IMPLEMENTING_LABEL_STATUSES = new Set([
  "inbox",
  "needs_info",
  "ready_for_agent",
  "ready_for_human",
]);

const STATUS_LABEL_TO_HUB_STATUS: Readonly<Record<string, HubTaskStatus>> = {
  needs_triage: "inbox",
  inbox: "inbox",
  needs_info: "needs_info",
  ready_for_agent: "ready_for_agent",
  ready_for_human: "ready_for_human",
  blocked: "blocked",
  implementing: "implementing",
  reviewing: "reviewing",
  waiting_for_merge: "waiting_for_merge",
  merging: "merging",
  done: "done",
  wontfix: "wontfix",
  failed: "failed",
  sync_conflict: "sync_conflict",
};

export interface BeadsTaskComment {
  readonly author?: string;
  readonly body?: string;
  readonly createdAt?: string;
}

export interface BeadsTaskRecord extends Record<string, unknown> {
  readonly id?: string | number;
  readonly title?: string;
}

export interface HubTaskProjection {
  readonly id: string;
  readonly title: string;
  readonly beadsStatus: string | undefined;
  readonly hubStatus: HubTaskStatus;
  readonly claim: HubTaskClaimMetadata | undefined;
  readonly claimState: "active" | "stale" | undefined;
  readonly labels: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly description: string | undefined;
  readonly notes: string | undefined;
  readonly comments: readonly BeadsTaskComment[];
  readonly remoteRefs: readonly string[];
  readonly runRefs: readonly string[];
}

export interface HubTaskGroup {
  readonly status: HubTaskStatus;
  readonly tasks: readonly HubTaskProjection[];
}

export interface HubTaskBoard {
  readonly tasks: readonly HubTaskProjection[];
  readonly groups: readonly HubTaskGroup[];
}

const normalizeKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const readFirstString = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

const readStringList = (value: unknown, keys?: readonly string[]): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string") {
      const trimmed = item.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }

    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const label = keys ? readFirstString(record, keys) : undefined;
      if (label) {
        return [label];
      }
      const value = readFirstString(record, ["name", "title", "id", "ref"]);
      return value ? [value] : [];
    }

    return [];
  });
};

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readComments = (value: unknown): BeadsTaskComment[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    const body = readFirstString(record, [
      "body",
      "text",
      "message",
      "comment",
    ]);
    const author = readFirstString(record, ["author", "user", "login", "name"]);
    const createdAt = readFirstString(record, [
      "createdAt",
      "created_at",
      "timestamp",
      "date",
    ]);

    if (!body && !author && !createdAt) {
      return [];
    }

    return [{ body, author, createdAt }];
  });
};

const readRefs = (value: unknown): string[] =>
  readStringList(value, ["url", "ref", "name", "title", "id", "branch"]);

const normalizeHubTaskStatus = (value: unknown): HubTaskStatus | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeKey(value);
  return HUB_TASK_STATUS_SET.has(normalized)
    ? (normalized as HubTaskStatus)
    : undefined;
};

const normalizeBeadsLifecycle = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeKey(value);
  return BEADS_LIFECYCLE_STATUSES.has(normalized) ? normalized : undefined;
};

const resolveMetadataStatus = (
  metadata: Readonly<Record<string, unknown>>,
): HubTaskStatus | undefined => {
  for (const key of TASK_STATUS_KEYS) {
    const status = normalizeHubTaskStatus(metadata[key]);
    if (status) {
      return status;
    }
  }

  return undefined;
};

const resolveStatusFromMetadataReasons = (
  metadata: Readonly<Record<string, unknown>>,
): HubTaskStatus | undefined => {
  for (const rule of METADATA_STATUS_RULES) {
    if (hasTruthyMetadata(metadata, rule.keys)) {
      return rule.status;
    }
  }
  return undefined;
};

const resolveStatusFromLabels = (
  labels: readonly string[],
): HubTaskStatus | undefined => {
  for (const label of labels) {
    const status = STATUS_LABEL_TO_HUB_STATUS[normalizeKey(label)];
    if (status) {
      return status;
    }
  }
  return undefined;
};

const hasTruthyMetadata = (
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean =>
  keys.some((key) => {
    const value = metadata[key];
    return (
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim().length === 0)
    );
  });

const resolveStatusFromTaskShape = (
  task: BeadsTaskRecord,
  labels: readonly string[],
  metadata: Readonly<Record<string, unknown>>,
): HubTaskStatus | undefined => {
  const directStatus = normalizeHubTaskStatus(
    readFirstString(task, TASK_STATUS_KEYS),
  );
  if (directStatus) {
    return directStatus;
  }

  const metadataStatus = resolveMetadataStatus(metadata);
  if (metadataStatus) {
    return metadataStatus;
  }

  const reasonStatus = resolveStatusFromMetadataReasons(metadata);
  if (reasonStatus) {
    return reasonStatus;
  }

  const beadsLifecycle = normalizeBeadsLifecycle(
    readFirstString(task, BEADS_LIFECYCLE_KEYS),
  );

  const labelStatus = resolveStatusFromLabels(labels);
  if (
    beadsLifecycle === "in_progress" &&
    labelStatus &&
    IMPLEMENTING_LABEL_STATUSES.has(labelStatus)
  ) {
    return "implementing";
  }
  if (labelStatus) {
    return labelStatus;
  }

  if (beadsLifecycle === "blocked") {
    return "blocked";
  }
  if (beadsLifecycle === "closed") {
    return "done";
  }
  if (beadsLifecycle === "in_progress") {
    return "implementing";
  }

  return "inbox";
};

export const projectHubTask = (task: BeadsTaskRecord): HubTaskProjection => {
  const metadata = readObject(
    task.metadata ?? task.meta ?? task.custom_metadata ?? task.customMetadata,
  );
  const labels = readStringList(task.labels ?? task.tags ?? task.labelNames);
  const comments = readComments(
    task.comments ?? task.comment_threads ?? task.commentThreads,
  );
  const remoteRefs = readRefs(
    task.remoteRefs ?? task.remote_refs ?? task.remoteReferences,
  );
  const runRefs = readRefs(task.runRefs ?? task.run_refs ?? task.runReferences);
  const hubStatus = resolveStatusFromTaskShape(task, labels, metadata);
  const beadsStatus = readFirstString(task, BEADS_LIFECYCLE_KEYS) ?? undefined;
  const claim = readHubTaskClaim(metadata);
  const resolvedHubStatus = hubStatus ?? "inbox";
  const claimState = resolveHubTaskClaimState(resolvedHubStatus, claim);

  return {
    id: String(task.id ?? task.key ?? task.slug ?? task.title ?? "unknown"),
    title:
      readFirstString(task, ["title", "summary", "name"]) ??
      String(task.id ?? "untitled"),
    beadsStatus,
    hubStatus: resolvedHubStatus,
    claim,
    claimState,
    labels,
    metadata,
    description: readFirstString(task, ["description", "body", "details"]),
    notes: readFirstString(task, ["notes", "note"]),
    comments,
    remoteRefs,
    runRefs,
  };
};

const compareTaskIds = (left: HubTaskProjection, right: HubTaskProjection) =>
  left.id.localeCompare(right.id);

export const groupHubTasks = (
  tasks: readonly HubTaskProjection[],
): HubTaskGroup[] =>
  HUB_TASK_STATUSES.map((status) => ({
    status,
    tasks: tasks
      .filter((task) => task.hubStatus === status)
      .sort(compareTaskIds),
  })).filter((group) => group.tasks.length > 0);

export const projectHubTaskBoard = (
  tasks: readonly BeadsTaskRecord[],
): HubTaskBoard => {
  const projected = tasks.map(projectHubTask).sort(compareTaskIds);
  return {
    tasks: projected,
    groups: groupHubTasks(projected),
  };
};

const parseBdJsonOutput = (output: string): unknown[] => {
  const parsed = JSON.parse(output) as unknown;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of [
      "tasks",
      "issues",
      "items",
      "results",
      "data",
      "beads",
    ]) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
    return [parsed];
  }
  return [];
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

const runBdJson = (
  cwd: string,
  args: readonly string[],
  failureLabel: string,
  env: NodeJS.ProcessEnv = process.env,
): unknown[] => {
  const stdout = runBdText(cwd, args, failureLabel, env);
  return parseBdJsonOutput(stdout);
};

const tryRunBdJson = (
  cwd: string,
  args: readonly string[],
  failureLabel: string,
  env: NodeJS.ProcessEnv = process.env,
): unknown[] => {
  try {
    return runBdJson(cwd, args, failureLabel, env);
  } catch {
    return [];
  }
};

const mergeOptionalTaskDetails = (
  task: BeadsTaskRecord,
  optionalRecords: readonly BeadsTaskRecord[],
): BeadsTaskRecord => {
  const merged: Record<string, unknown> = { ...task };

  for (const record of optionalRecords) {
    if (!record || typeof record !== "object") {
      continue;
    }

    for (const key of [
      "comments",
      "comment_threads",
      "commentThreads",
      "remoteRefs",
      "remote_refs",
      "remoteReferences",
      "runRefs",
      "run_refs",
      "runReferences",
    ]) {
      if (merged[key] === undefined && record[key] !== undefined) {
        merged[key] = record[key];
      }
    }
  }

  return merged as BeadsTaskRecord;
};

export const loadHubTaskBoard = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): HubTaskBoard =>
  projectHubTaskBoard(
    runBdJson(cwd, ["list", "--json"], "tasks list", env) as BeadsTaskRecord[],
  );

export const getHubTaskBoardDisplayTasks = (
  board: HubTaskBoard,
): readonly HubTaskProjection[] => board.groups.flatMap((group) => group.tasks);

const isPositiveIntegerSelector = (value: string): boolean =>
  /^[1-9]\d*$/.test(value);

const formatSelectorCandidates = (
  tasks: readonly HubTaskProjection[],
): string => tasks.map((task) => task.id).join(", ");

export const resolveHubTaskSelector = (
  cwd: string,
  selector: string,
  env: NodeJS.ProcessEnv = process.env,
): HubTaskProjection => {
  const trimmedSelector = selector.trim();
  if (trimmedSelector.length === 0) {
    throw new TaskBoardError({
      message:
        "sandcastle tasks require a task id, exact title, or list number.",
    });
  }

  if (!isPositiveIntegerSelector(trimmedSelector)) {
    const [task] = tryRunBdJson(
      cwd,
      ["show", trimmedSelector, "--json"],
      `tasks show ${trimmedSelector}`,
      env,
    ) as BeadsTaskRecord[];
    if (task) {
      return projectHubTask(task);
    }
  }

  const board = loadHubTaskBoard(cwd, env);

  const idMatch = board.tasks.find((task) => task.id === trimmedSelector);
  if (idMatch) {
    return idMatch;
  }

  const titleMatches = board.tasks.filter(
    (task) => task.title === trimmedSelector,
  );
  if (titleMatches.length === 1) {
    return titleMatches[0]!;
  }
  if (titleMatches.length > 1) {
    throw new TaskBoardError({
      message: `sandcastle tasks selector "${selector}" matched multiple tasks with the same exact title: ${formatSelectorCandidates(titleMatches)}. Use a Beads id or the list number instead.`,
    });
  }

  if (isPositiveIntegerSelector(trimmedSelector)) {
    const displayTasks = getHubTaskBoardDisplayTasks(board);
    const position = Number(trimmedSelector);
    if (position < 1 || position > displayTasks.length) {
      throw new TaskBoardError({
        message: `sandcastle tasks selector ${position} is out of range for the current task list (1-${displayTasks.length}).`,
      });
    }
    return displayTasks[position - 1]!;
  }

  throw new TaskBoardError({
    message: `sandcastle tasks selector "${selector}" did not match a Beads id, an exact task title, or a list number.`,
  });
};

export const resolveHubTaskSelectors = (
  cwd: string,
  selectors: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): HubTaskProjection[] => {
  if (selectors.length === 0) {
    throw new TaskBoardError({
      message: "sandcastle tasks delete requires at least one task selector.",
    });
  }

  const seen = new Set<string>();
  const resolved: HubTaskProjection[] = [];
  for (const selector of selectors) {
    const task = resolveHubTaskSelector(cwd, selector, env);
    if (seen.has(task.id)) {
      continue;
    }
    seen.add(task.id);
    resolved.push(task);
  }
  return resolved;
};

export const loadHubTask = (
  cwd: string,
  selector: string,
  env: NodeJS.ProcessEnv = process.env,
): HubTaskProjection => {
  const resolvedTask = resolveHubTaskSelector(cwd, selector, env);
  const [task] = runBdJson(
    cwd,
    ["show", resolvedTask.id, "--json", "--long"],
    `tasks show ${resolvedTask.id}`,
    env,
  ) as BeadsTaskRecord[];

  if (!task) {
    throw new TaskBoardError({
      message: `sandcastle tasks show ${resolvedTask.id} did not return a Beads task`,
    });
  }

  const optionalRecords = [
    ...tryRunBdJson(
      cwd,
      ["show", resolvedTask.id, "--json", "--thread"],
      `tasks show ${resolvedTask.id} thread`,
      env,
    ),
    ...tryRunBdJson(
      cwd,
      ["show", resolvedTask.id, "--json", "--refs"],
      `tasks show ${resolvedTask.id} refs`,
      env,
    ),
  ] as BeadsTaskRecord[];

  return projectHubTask(mergeOptionalTaskDetails(task, optionalRecords));
};

export interface ClaimHubTaskInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly branch: string;
  readonly hubProjectDir?: string;
  readonly runId?: string;
  readonly batchId?: string;
  readonly startedAt?: Date;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ClaimHubTaskResult {
  readonly outcome: "claimed" | "skipped";
  readonly reason?: "active_claim";
  readonly runId: string;
  readonly batchId: string;
  readonly runDir: string;
  readonly eventsDir: string;
  readonly task: HubTaskProjection;
  readonly claim: HubTaskClaimMetadata | undefined;
}

export type HubFailureReason =
  | "agent_failed"
  | "sandbox_failed"
  | "merge_conflict"
  | "verification_failure"
  | "close_failed"
  | "unknown";

export const loadHubReadyQueue = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): HubTaskBoard =>
  projectHubTaskBoard(
    runBdJson(
      cwd,
      ["ready", "--json"],
      "tasks ready",
      env,
    ) as BeadsTaskRecord[],
  );

export const selectHubFlowTasks = (
  board: HubTaskBoard,
): readonly HubTaskProjection[] =>
  board.tasks.filter(
    (task) =>
      task.hubStatus === "ready_for_agent" && task.claimState !== "active",
  );

export const selectHubBatchMergeTasks = (
  board: HubTaskBoard,
  batchId: string,
): readonly HubTaskProjection[] =>
  board.tasks.filter(
    (task) =>
      task.hubStatus === "waiting_for_merge" && task.claim?.batchId === batchId,
  );

const slugifyHubTaskTitle = (title: string): string => {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 48) : "task";
};

export const resolveHubTaskBranch = (taskId: string, title: string): string => {
  const normalizedId = taskId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `sandcastle/${normalizedId}-${slugifyHubTaskTitle(title)}`;
};

const HUB_STATUS_LABELS: Readonly<Partial<Record<HubTaskStatus, string>>> = {
  implementing: "implementing",
  reviewing: "reviewing",
  waiting_for_merge: "waiting-for-merge",
  merging: "merging",
  failed: "failed",
  ready_for_agent: "ready-for-agent",
  ready_for_human: "ready-for-human",
  needs_info: "needs-info",
  inbox: "needs-triage",
  sync_conflict: "sync-conflict",
};

const HUB_STATUS_BEADS_LIFECYCLE: Readonly<
  Partial<Record<HubTaskStatus, string>>
> = {
  implementing: "in_progress",
  reviewing: "in_progress",
  waiting_for_merge: "in_progress",
  merging: "in_progress",
  failed: "open",
  ready_for_agent: "open",
  ready_for_human: "open",
  needs_info: "open",
  inbox: "open",
  blocked: "blocked",
  done: "closed",
  wontfix: "closed",
  sync_conflict: "blocked",
};

const EXECUTION_STATUS_LABELS = new Set([
  "implementing",
  "reviewing",
  "waiting-for-merge",
  "merging",
  "failed",
]);

export interface UpdateHubTaskStatusInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly hubStatus: HubTaskStatus;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly failureReason?: HubFailureReason;
  readonly replaceMetadata?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export const updateHubTaskStatus = (
  input: UpdateHubTaskStatusInput,
): HubTaskProjection => {
  const task = loadHubTask(input.cwd, input.taskId, input.env);
  const label = HUB_STATUS_LABELS[input.hubStatus];
  const beadsStatus = HUB_STATUS_BEADS_LIFECYCLE[input.hubStatus];
  const labelKey = normalizeKey(label ?? "");
  const metadata: Record<string, unknown> = input.replaceMetadata
    ? {
        ...(input.metadata ?? {}),
        hubStatus: input.hubStatus,
      }
    : {
        ...task.metadata,
        ...(input.metadata ?? {}),
        hubStatus: input.hubStatus,
      };

  if (input.failureReason) {
    metadata.failureReason = input.failureReason;
    metadata.failed = true;
  } else {
    delete metadata.failureReason;
    delete metadata.failed;
  }

  const args = ["update", input.taskId];
  if (beadsStatus) {
    args.push("--status", beadsStatus);
  }
  if (label) {
    appendBdAddLabelArgs(args, label);
  }

  const labelsToRemove = task.labels.filter(
    (existingLabel) =>
      EXECUTION_STATUS_LABELS.has(existingLabel) &&
      normalizeKey(existingLabel) !== labelKey,
  );
  if (labelsToRemove.length > 0) {
    appendBdRemoveLabelArgs(args, labelsToRemove);
  }

  appendBdMetadataArg(args, metadata);
  runBdText(input.cwd, args, `tasks update ${input.taskId}`, input.env);

  return loadHubTask(input.cwd, input.taskId, input.env);
};

export interface CloseHubTaskInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}

export const closeHubTask = (input: CloseHubTaskInput): HubTaskProjection => {
  const task = loadHubTask(input.cwd, input.taskId, input.env);
  const metadata: Record<string, unknown> = {
    ...task.metadata,
    ...(input.metadata ?? {}),
    hubStatus: "done",
    done: true,
  };
  delete metadata.failureReason;
  delete metadata.failed;
  delete metadata.claim;

  const labelsToRemove = task.labels.filter((existingLabel) =>
    EXECUTION_STATUS_LABELS.has(existingLabel),
  );
  const args = ["update", input.taskId, "--status", "closed"];
  appendBdMetadataArg(args, metadata);
  appendBdAddLabelArgs(args, "done");
  if (labelsToRemove.length > 0) {
    appendBdRemoveLabelArgs(args, labelsToRemove);
  }

  runBdText(input.cwd, args, `tasks close ${input.taskId}`, input.env);

  return loadHubTask(input.cwd, input.taskId, input.env);
};

export interface DeleteHubTasksInput {
  readonly cwd: string;
  readonly taskIds: readonly string[];
  readonly dryRun?: boolean;
  readonly cascade?: boolean;
  readonly force?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

const hubBeadsTaskExists = (
  cwd: string,
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const [task] = tryRunBdJson(
    cwd,
    ["show", taskId, "--json"],
    `tasks delete verify ${taskId}`,
    env,
  ) as BeadsTaskRecord[];
  return task !== undefined;
};

const verifyHubTasksDeleted = (
  cwd: string,
  taskIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void => {
  const stillPresent = taskIds.filter((taskId) =>
    hubBeadsTaskExists(cwd, taskId, env),
  );
  if (stillPresent.length === 0) {
    return;
  }

  throw new TaskBoardError({
    message: [
      `sandcastle tasks delete reported success, but Beads still has: ${stillPresent.join(", ")}.`,
      `Retry with: bd delete ${stillPresent.join(" ")} --force`,
    ].join(" "),
  });
};

export const deleteHubTasks = (input: DeleteHubTasksInput): string => {
  if (input.taskIds.length === 0) {
    throw new TaskBoardError({
      message:
        "sandcastle tasks delete requires at least one resolved Beads task id.",
    });
  }

  const args = ["delete", ...input.taskIds];
  if (input.dryRun) {
    args.push("--dry-run");
  }
  if (input.cascade) {
    args.push("--cascade");
  }
  if (input.force && !input.dryRun) {
    args.push("--force");
  }

  const output = runBdText(
    input.cwd,
    args,
    `tasks delete ${input.taskIds.join(" ")}`,
    input.env,
  );

  if (!input.dryRun && input.force) {
    verifyHubTasksDeleted(input.cwd, input.taskIds, input.env);
  }

  return output;
};

export const claimHubTask = (input: ClaimHubTaskInput): ClaimHubTaskResult => {
  const startedAt = input.startedAt ?? new Date();
  const claimedAt = startedAt.toISOString();
  const context = createHubRunContext({
    cwd: input.cwd,
    hubProjectDir: input.hubProjectDir,
    branch: input.branch,
    runId: input.runId,
    batchId: input.batchId,
    startedAt,
    env: input.env,
  });

  const task = loadHubTask(input.cwd, input.taskId, input.env);
  const existingClaim = task.claim;

  if (isHubTaskClaimActive(task.hubStatus)) {
    appendHubTaskEvent(context.runDir, {
      type: "task_claim_skipped",
      runId: context.runId,
      batchId: context.batchId,
      taskId: input.taskId,
      branch: input.branch,
      createdAt: claimedAt,
      status: task.hubStatus,
      reason: "active_claim",
      claim: existingClaim,
    });

    return {
      outcome: "skipped",
      reason: "active_claim",
      runId: context.runId,
      batchId: context.batchId,
      runDir: context.runDir,
      eventsDir: context.eventsDir,
      task,
      claim: existingClaim,
    };
  }

  const claim = createHubTaskClaimMetadata({
    runId: context.runId,
    batchId: context.batchId,
    branch: input.branch,
    claimedAt,
  });
  const metadata = {
    ...task.metadata,
    claim: claim.raw,
  };

  const claimArgs = ["update", input.taskId, "--status", "in_progress"];
  appendBdMetadataArg(claimArgs, metadata);
  appendBdAddLabelArgs(claimArgs, "implementing");
  runBdText(input.cwd, claimArgs, `tasks claim ${input.taskId}`, input.env);

  const updatedTask = loadHubTask(input.cwd, input.taskId, input.env);
  appendHubTaskEvent(context.runDir, {
    type: "task_claimed",
    runId: context.runId,
    batchId: context.batchId,
    taskId: input.taskId,
    branch: input.branch,
    createdAt: claimedAt,
    status: updatedTask.hubStatus,
    claim,
  });

  return {
    outcome: "claimed",
    runId: context.runId,
    batchId: context.batchId,
    runDir: context.runDir,
    eventsDir: context.eventsDir,
    task: updatedTask,
    claim,
  };
};

export interface CreateHubTaskPrdWarning {
  readonly severity: "low" | "medium" | "high";
  readonly message: string;
}

export interface CreateHubTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly origin?: "manual" | "user-feedback" | "prd-decomposition";
  readonly kind?: string;
  readonly sliceType?: "AFK" | "HITL";
  readonly prdRef?: string;
  readonly proposalRunId?: string;
  readonly hubStatus?: "inbox" | "ready_for_agent" | "ready_for_human";
  readonly sliceTempId?: string;
  readonly prdWarning?: CreateHubTaskPrdWarning;
  readonly extraLabels?: readonly string[];
}

export interface CreateHubTaskResult {
  readonly id: string;
  readonly title: string;
  readonly prdWarning?: CreateHubTaskPrdWarning & {
    readonly sliceTempId: string;
  };
}

const CREATE_HUB_STATUS_LABELS: Readonly<
  Record<NonNullable<CreateHubTaskInput["hubStatus"]>, string>
> = {
  inbox: "needs-triage",
  ready_for_agent: "ready-for-agent",
  ready_for_human: "ready-for-human",
};

export const createHubTask = (
  cwd: string,
  input: CreateHubTaskInput,
  env: NodeJS.ProcessEnv = process.env,
): CreateHubTaskResult => {
  const metadata: Record<string, string> = {
    origin: input.origin ?? "manual",
  };
  if (input.kind) {
    metadata.kind = input.kind;
  }
  if (input.sliceType) {
    metadata.slice_type = input.sliceType;
  }
  if (input.prdRef) {
    metadata.prd_ref = input.prdRef;
  }
  if (input.proposalRunId) {
    metadata.proposal_run_id = input.proposalRunId;
  }
  if (input.sliceTempId) {
    metadata.slice_temp_id = input.sliceTempId;
  }
  if (input.prdWarning) {
    metadata.warning_severity = input.prdWarning.severity;
    metadata.warning_message = input.prdWarning.message;
  }

  const args = ["create", input.title];
  if (input.description) {
    args.push("--description", input.description);
  }
  args.push("--type", "task");
  args.push("-l", CREATE_HUB_STATUS_LABELS[input.hubStatus ?? "inbox"]);
  for (const label of input.extraLabels ?? []) {
    args.push("-l", label);
  }
  args.push("--metadata", JSON.stringify(metadata), "--json");

  const output = runBdText(cwd, args, "tasks create", env);
  const parsed = parseBdJsonOutput(output);
  const [created] = parsed;
  const record =
    created && typeof created === "object"
      ? (created as Record<string, unknown>)
      : {};

  const result: CreateHubTaskResult = {
    id: String(record.id ?? record.issue_id ?? record.key ?? "unknown"),
    title: String(record.title ?? input.title),
  };

  if (input.prdWarning && input.sliceTempId) {
    return {
      ...result,
      prdWarning: {
        sliceTempId: input.sliceTempId,
        severity: input.prdWarning.severity,
        message: input.prdWarning.message,
      },
    };
  }

  return result;
};

export const appendHubTaskComment = (
  cwd: string,
  id: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  runBdText(cwd, ["comments", "add", id, body], `tasks comment ${id}`, env);

export const addHubTaskDependency = (
  cwd: string,
  dependentId: string,
  blockerId: string,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  runBdText(
    cwd,
    ["dep", "add", dependentId, blockerId, "--type", "blocks"],
    `tasks dependency ${dependentId} -> ${blockerId}`,
    env,
  );
};

const cleanJoinedValues = (values: readonly string[]): string =>
  values.filter((value) => value.trim().length > 0).join(", ");

const formatInlineObject = (
  value: Readonly<Record<string, unknown>>,
): string => {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }
  return JSON.stringify(value);
};

const formatComment = (comment: BeadsTaskComment): string => {
  const parts: string[] = [];
  if (comment.author) {
    parts.push(comment.author);
  }
  if (comment.createdAt) {
    parts.push(comment.createdAt);
  }
  const prefix = parts.length > 0 ? `${parts.join(" · ")}: ` : "";
  return `${prefix}${comment.body ?? ""}`.trim();
};

export const filterHubTasksByPrdWarning = (
  tasks: readonly HubTaskProjection[],
  filter: PrdWarningSeverity,
): readonly HubTaskProjection[] =>
  tasks.filter((task) => matchesPrdWarningFilter(task, filter));

export interface FormatHubTaskBoardLinesOptions {
  readonly warningFilter?: PrdWarningSeverity;
}

export const formatHubTaskBoardLines = (
  board: HubTaskBoard,
  options?: FormatHubTaskBoardLinesOptions,
): readonly string[] => {
  const lines: string[] = ["Hub task board"];
  if (board.tasks.length === 0) {
    lines.push("No Beads tasks found.");
    return lines;
  }

  const visibleTasks = options?.warningFilter
    ? filterHubTasksByPrdWarning(board.tasks, options.warningFilter)
    : board.tasks;
  const visibleGroups = groupHubTasks(visibleTasks);
  const warningSummaryLine = formatPrdWarningSummaryLine(
    summarizeTasksPrdWarnings(visibleTasks),
  );

  lines.push(`Total tasks: ${visibleTasks.length}`);
  if (warningSummaryLine) {
    lines.push(warningSummaryLine);
  }

  if (visibleTasks.length === 0) {
    lines.push("No tasks match the current PRD warning filter.");
    return lines;
  }

  const displayIndexById = new Map<string, number>();
  visibleGroups
    .flatMap((group) => group.tasks)
    .forEach((task, index) => {
      displayIndexById.set(task.id, index + 1);
    });

  for (const group of visibleGroups) {
    lines.push("");
    lines.push(`${group.status} (${group.tasks.length})`);
    for (const task of group.tasks) {
      const displayIndex = displayIndexById.get(task.id);
      const warning = readPrdWarningFromTask(task);
      const warningSuffix = warning
        ? ` ${formatPrdWarningListSuffix(warning.severity)}`
        : "";
      lines.push(
        `  ${displayIndex ?? "?"}. ${task.id}: ${task.title}${warningSuffix}`,
      );
    }
  }

  return lines;
};

export const formatHubTaskDetailsRows = (
  task: HubTaskProjection,
): Record<string, string> => {
  const rows: Record<string, string> = {
    "Beads id": task.id,
    Title: task.title,
    "Hub status": task.hubStatus,
  };

  if (task.beadsStatus) {
    rows["Beads status"] = task.beadsStatus;
  }
  if (task.description) {
    rows.Description = task.description;
  }
  if (task.notes) {
    rows.Notes = task.notes;
  }
  if (task.labels.length > 0) {
    rows.Labels = cleanJoinedValues(task.labels);
  }
  if (Object.keys(task.metadata).length > 0) {
    rows.Metadata = formatInlineObject(task.metadata);
  }
  if (task.claim) {
    rows.Claim = formatInlineObject(task.claim.raw);
    rows["Claim state"] = task.claimState ?? "stale";
  }
  if (task.remoteRefs.length > 0) {
    rows["Remote refs"] = cleanJoinedValues(task.remoteRefs);
  }
  if (task.runRefs.length > 0) {
    rows["Run refs"] = cleanJoinedValues(task.runRefs);
  }
  if (task.comments.length > 0) {
    rows.Comments = String(task.comments.length);
  }

  const warning = readPrdWarningFromTask(task);
  if (warning) {
    const proposalRunId =
      typeof task.metadata.proposal_run_id === "string"
        ? task.metadata.proposal_run_id
        : undefined;
    rows["PRD warning"] = formatPrdWarningDetailsRow(warning, proposalRunId);
  }

  return rows;
};

export const formatHubTaskCommentLines = (
  task: HubTaskProjection,
): readonly string[] => {
  if (task.comments.length === 0) {
    return [];
  }

  const lines = ["Comments"];
  for (const comment of task.comments) {
    lines.push(`  - ${formatComment(comment)}`);
  }
  return lines;
};

export const isCanonicalHubTaskStatus = (
  value: unknown,
): value is HubTaskStatus => normalizeHubTaskStatus(value) !== undefined;
