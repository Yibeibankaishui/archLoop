import type { HubTaskProjection } from "./taskBoard.js";
import {
  formatPrdWarningDetailsRow,
  readPrdWarningFromTask,
} from "./hubPrdWarning.js";

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

export const formatHubTaskBoardStatusLabel = (status: HubTaskStatus): string =>
  status.replaceAll("_", " ");

export const isCanonicalHubTaskStatus = (
  value: unknown,
): value is HubTaskStatus =>
  typeof value === "string" &&
  (HUB_TASK_STATUSES as readonly string[]).includes(value);

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

const formatComment = (
  comment: HubTaskProjection["comments"][number],
): string => {
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
