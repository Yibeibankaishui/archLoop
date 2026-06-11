import { execFileSync } from "node:child_process";

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
  const statusKeys = [
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

  for (const key of statusKeys) {
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
  if (
    hasTruthyMetadata(metadata, [
      "blocked_reason",
      "blockedReason",
      "blocked_reason_kind",
      "blockedReasonKind",
      "blocked",
    ])
  ) {
    return "blocked";
  }
  if (
    hasTruthyMetadata(metadata, [
      "needs_info",
      "needsInfo",
      "needs_info_reason",
      "needsInfoReason",
    ])
  ) {
    return "needs_info";
  }
  if (
    hasTruthyMetadata(metadata, [
      "failed",
      "failedReason",
      "failure_reason",
      "failureReason",
    ])
  ) {
    return "failed";
  }
  if (
    hasTruthyMetadata(metadata, [
      "sync_conflict",
      "syncConflict",
      "sync_conflict_reason",
      "syncConflictReason",
    ])
  ) {
    return "sync_conflict";
  }
  if (hasTruthyMetadata(metadata, ["wontfix", "wontFix", "rejected"])) {
    return "wontfix";
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
    readFirstString(task, [
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
    ]),
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

  const labelStatus = resolveStatusFromLabels(labels);
  if (labelStatus) {
    return labelStatus;
  }

  const beadsLifecycle = normalizeBeadsLifecycle(
    readFirstString(task, ["state", "status", "lifecycle"]),
  );
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
  const beadsStatus =
    readFirstString(task, ["state", "status", "lifecycle"]) ?? undefined;

  return {
    id: String(task.id ?? task.key ?? task.slug ?? task.title ?? "unknown"),
    title:
      readFirstString(task, ["title", "summary", "name"]) ??
      String(task.id ?? "untitled"),
    beadsStatus,
    hubStatus: hubStatus ?? "inbox",
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

const runBdJson = (
  cwd: string,
  args: readonly string[],
  failureLabel: string,
): unknown[] => {
  try {
    const stdout = execFileSync("bd", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseBdJsonOutput(stdout);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unable to execute bd";
    throw new TaskBoardError({
      message: `sandcastle ${failureLabel} requires Beads in the current repo: ${message}`,
    });
  }
};

export const loadHubTaskBoard = (cwd: string): HubTaskBoard =>
  projectHubTaskBoard(
    runBdJson(cwd, ["list", "--json"], "tasks list") as BeadsTaskRecord[],
  );

export const loadHubTask = (cwd: string, id: string): HubTaskProjection => {
  const [task] = runBdJson(
    cwd,
    ["show", id, "--json", "--include-comments", "--include-dependents"],
    `tasks show ${id}`,
  ) as BeadsTaskRecord[];

  if (!task) {
    throw new TaskBoardError({
      message: `sandcastle tasks show ${id} did not return a Beads task`,
    });
  }

  return projectHubTask(task);
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

export const formatHubTaskBoardLines = (
  board: HubTaskBoard,
): readonly string[] => {
  const lines: string[] = ["Hub task board"];
  if (board.tasks.length === 0) {
    lines.push("No Beads tasks found.");
    return lines;
  }

  lines.push(`Total tasks: ${board.tasks.length}`);

  for (const status of HUB_TASK_STATUSES) {
    const tasks = board.groups.find((group) => group.status === status)?.tasks;
    if (!tasks || tasks.length === 0) {
      continue;
    }

    lines.push("");
    lines.push(`${status} (${tasks.length})`);
    for (const task of tasks) {
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
