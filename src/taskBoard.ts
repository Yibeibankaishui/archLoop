import { execFileSync } from "node:child_process";

import {
  appendHubTaskEvent,
  createHubRunContext,
  createHubTaskClaimMetadata,
  isHubTaskClaimActive,
  readHubTaskClaim,
  resolveHubTaskClaimState,
  type HubTaskClaimMetadata,
} from "./hubExecution.js";
import { TaskBoardError } from "./errors.js";

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
    return execFileSync("bd", [...args], {
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

export const loadHubTaskBoard = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): HubTaskBoard =>
  projectHubTaskBoard(
    runBdJson(cwd, ["list", "--json"], "tasks list", env) as BeadsTaskRecord[],
  );

export const loadHubTask = (
  cwd: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): HubTaskProjection => {
  const [task] = runBdJson(
    cwd,
    ["show", id, "--json", "--include-comments", "--include-dependents"],
    `tasks show ${id}`,
    env,
  ) as BeadsTaskRecord[];

  if (!task) {
    throw new TaskBoardError({
      message: `sandcastle tasks show ${id} did not return a Beads task`,
    });
  }

  return projectHubTask(task);
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

  runBdText(
    input.cwd,
    [
      "update",
      input.taskId,
      "--status",
      "in_progress",
      "--add-labels",
      "implementing",
      "--set-metadata",
      JSON.stringify(metadata),
    ],
    `tasks claim ${input.taskId}`,
    input.env,
  );

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

export interface CreateHubTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly origin?: "manual" | "user-feedback";
  readonly kind?: string;
}

export interface CreateHubTaskResult {
  readonly id: string;
  readonly title: string;
}

export const createHubTask = (
  cwd: string,
  input: CreateHubTaskInput,
): CreateHubTaskResult => {
  const metadata: Record<string, string> = {
    origin: input.origin ?? "manual",
  };
  if (input.kind) {
    metadata.kind = input.kind;
  }

  const args = ["create", input.title];
  if (input.description) {
    args.push("--description", input.description);
  }
  args.push(
    "--type",
    "task",
    "-l",
    "needs-triage",
    "--metadata",
    JSON.stringify(metadata),
    "--json",
  );

  const output = runBdText(cwd, args, "tasks create");
  const parsed = parseBdJsonOutput(output);
  const [created] = parsed;
  const record =
    created && typeof created === "object"
      ? (created as Record<string, unknown>)
      : {};

  return {
    id: String(record.id ?? record.issue_id ?? record.key ?? "unknown"),
    title: String(record.title ?? input.title),
  };
};

export const appendHubTaskComment = (
  cwd: string,
  id: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  runBdText(cwd, ["comments", "add", id, body], `tasks comment ${id}`, env);

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

export const formatHubTaskBoardLines = (
  board: HubTaskBoard,
): readonly string[] => {
  const lines: string[] = ["Hub task board"];
  if (board.tasks.length === 0) {
    lines.push("No Beads tasks found.");
    return lines;
  }

  lines.push(`Total tasks: ${board.tasks.length}`);

  for (const group of board.groups) {
    lines.push("");
    lines.push(`${group.status} (${group.tasks.length})`);
    for (const task of group.tasks) {
      lines.push(`  ${task.id}: ${task.title}`);
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
