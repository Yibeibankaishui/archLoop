import { appendBdMetadataArg } from "./bdCliArgs.js";
import { TaskBoardError } from "./errors.js";
import {
  createDefaultGithubIssueClient,
  detectSemanticSyncConflict,
  parseGithubRemoteRef,
  resolveRemoteCollaborationStatus,
  type GithubIssueClient,
  type GithubIssueRecord,
  type HubSyncState,
} from "./hubTaskSync.js";
import { runBdTextForHubTaskStore } from "./hubTaskStore.js";
import {
  HUB_TASK_STATUSES,
  loadHubTask,
  updateHubTaskStatus,
  type HubTaskProjection,
  type HubTaskStatus,
} from "./taskBoard.js";
import type {
  SectionBlock,
  SectionFooterBlock,
  SectionHeaderBlock,
  SectionKvBlock,
} from "./section.js";

export type HubConflictKeep = "local" | "remote";

export type HubConflictField = "title" | "hubStatus" | "description";

export interface HubConflictFieldValues {
  readonly title: string;
  readonly hubStatus: HubTaskStatus;
  readonly description: string;
}

export interface ResolveHubTaskConflictInput {
  readonly localValue: HubConflictFieldValues;
  readonly remoteValue: HubConflictFieldValues;
  readonly keep: HubConflictKeep;
  readonly divergedFields: readonly HubConflictField[];
}

export type HubTaskConflictMutationEntry =
  | {
      readonly field: "sync_state";
      readonly value: "push_pending" | "synced";
    }
  | {
      readonly field: "hubStatus";
      readonly value: HubTaskStatus;
    }
  | {
      readonly field: "title";
      readonly value: string;
    }
  | {
      readonly field: "description";
      readonly value: string;
    }
  | {
      readonly field: "sync_conflict" | "sync_conflict_reason";
      readonly action: "clear";
    };

export interface HubTaskConflictBeadsMutation {
  readonly keep: HubConflictKeep;
  readonly syncState: "push_pending" | "synced";
  readonly clearConflictMetadata: true;
  readonly hubStatus: HubTaskStatus;
  readonly title?: string;
  readonly description?: string;
  readonly mutations: readonly HubTaskConflictMutationEntry[];
}

export interface HubTaskConflictResolveJsonResult {
  readonly id: string;
  readonly kept: HubConflictKeep;
  readonly mutations: readonly HubTaskConflictMutationEntry[];
}

export interface HubTaskConflictResolveModel {
  readonly header: SectionHeaderBlock;
  readonly reason?: { readonly kind: "prose"; readonly body: string };
  readonly diff: SectionKvBlock;
  readonly footer: SectionFooterBlock;
}

const SYNC_CONFLICT_REASON_RE =
  /^local (\S+) disagrees with remote (\S+)$/;

const isHubTaskStatus = (value: string): value is HubTaskStatus =>
  (HUB_TASK_STATUSES as readonly string[]).includes(value);

export const parseSyncConflictReasonStatuses = (
  reason: string | undefined,
): { local: HubTaskStatus; remote: HubTaskStatus } | undefined => {
  if (!reason) {
    return undefined;
  }
  const match = SYNC_CONFLICT_REASON_RE.exec(reason.trim());
  if (!match) {
    return undefined;
  }
  const local = match[1]!;
  const remote = match[2]!;
  if (!isHubTaskStatus(local) || !isHubTaskStatus(remote)) {
    return undefined;
  }
  return { local, remote };
};

export const readSyncConflictReason = (
  metadata: Readonly<Record<string, unknown>>,
): string | undefined => {
  const value =
    metadata.sync_conflict_reason ?? metadata.syncConflictReason;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
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

export const hasHubTaskSyncConflict = (task: HubTaskProjection): boolean => {
  if (task.hubStatus === "sync_conflict") {
    return true;
  }
  if (readSyncState(task.metadata) === "conflict") {
    return true;
  }
  if (readSyncConflictReason(task.metadata) !== undefined) {
    return true;
  }
  const marker = task.metadata.sync_conflict ?? task.metadata.syncConflict;
  return (
    marker === true ||
    marker === "true" ||
    (typeof marker === "string" && marker.trim().length > 0)
  );
};

export const resolveLocalConflictHubStatus = (
  task: HubTaskProjection,
): HubTaskStatus => {
  if (task.hubStatus !== "sync_conflict") {
    return task.hubStatus;
  }
  const parsed = parseSyncConflictReasonStatuses(
    readSyncConflictReason(task.metadata),
  );
  if (parsed) {
    return parsed.local;
  }
  throw new TaskBoardError({
    message: `archloop tasks resolve ${task.id} could not restore the pre-conflict local Hub status from sync_conflict_reason. Re-run archloop tasks pull or set the status manually.`,
  });
};

export const detectDivergedConflictFields = (
  localValue: HubConflictFieldValues,
  remoteValue: HubConflictFieldValues,
  conflictReason?: string,
): HubConflictField[] => {
  const fields: HubConflictField[] = [];
  if (localValue.title !== remoteValue.title) {
    fields.push("title");
  }
  if (
    localValue.hubStatus !== remoteValue.hubStatus ||
    detectSemanticSyncConflict(localValue.hubStatus, remoteValue.hubStatus) ||
    Boolean(conflictReason)
  ) {
    fields.push("hubStatus");
  }
  if (localValue.description !== remoteValue.description) {
    fields.push("description");
  }
  return fields;
};

export const resolveHubTaskConflict = (
  input: ResolveHubTaskConflictInput,
): HubTaskConflictBeadsMutation => {
  const { localValue, remoteValue, keep, divergedFields } = input;
  const diverged = new Set(divergedFields);

  if (keep === "local") {
    const mutations: HubTaskConflictMutationEntry[] = [
      { field: "sync_state", value: "push_pending" },
      { field: "hubStatus", value: localValue.hubStatus },
      { field: "sync_conflict", action: "clear" },
      { field: "sync_conflict_reason", action: "clear" },
    ];
    return {
      keep: "local",
      syncState: "push_pending",
      clearConflictMetadata: true,
      hubStatus: localValue.hubStatus,
      mutations,
    };
  }

  const mutations: HubTaskConflictMutationEntry[] = [
    { field: "sync_state", value: "synced" },
    { field: "hubStatus", value: remoteValue.hubStatus },
    { field: "sync_conflict", action: "clear" },
    { field: "sync_conflict_reason", action: "clear" },
  ];
  const title = diverged.has("title") ? remoteValue.title : undefined;
  const description = diverged.has("description")
    ? remoteValue.description
    : undefined;
  if (title !== undefined) {
    mutations.push({ field: "title", value: title });
  }
  if (description !== undefined) {
    mutations.push({ field: "description", value: description });
  }

  return {
    keep: "remote",
    syncState: "synced",
    clearConflictMetadata: true,
    hubStatus: remoteValue.hubStatus,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    mutations,
  };
};

const truncatePreview = (value: string, max = 48): string => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) {
    return trimmed.length > 0 ? trimmed : "(empty)";
  }
  return `${trimmed.slice(0, max - 1)}…`;
};

const pickPrimaryDivergedValue = (
  values: HubConflictFieldValues,
  divergedFields: readonly HubConflictField[],
): string => {
  if (divergedFields.includes("hubStatus")) {
    return values.hubStatus;
  }
  if (divergedFields.includes("title")) {
    return values.title;
  }
  return values.description;
};

export const formatConflictKeepOptionLabel = (
  keep: HubConflictKeep,
  values: HubConflictFieldValues,
  divergedFields: readonly HubConflictField[],
): string => {
  const primary = pickPrimaryDivergedValue(values, divergedFields);
  const prefix = keep === "local" ? "Keep local" : "Keep remote";
  return `${prefix} · ${truncatePreview(primary)}`;
};

const CONFLICT_FIELD_LABEL: Record<HubConflictField, string> = {
  hubStatus: "status",
  title: "title",
  description: "description",
};

export const buildHubTaskConflictResolveModel = (input: {
  readonly taskId: string;
  readonly projectName?: string;
  readonly reason?: string;
  readonly localValue: HubConflictFieldValues;
  readonly remoteValue: HubConflictFieldValues;
  readonly divergedFields: readonly HubConflictField[];
}): HubTaskConflictResolveModel => {
  const rows = input.divergedFields.map((field) => ({
    key: CONFLICT_FIELD_LABEL[field],
    value: String(input.localValue[field]),
    secondary: String(input.remoteValue[field]),
  }));

  return {
    header: {
      kind: "header",
      title: "archLoop",
      subtitle: `resolve · ${input.taskId}${
        input.projectName ? ` · ${input.projectName}` : ""
      }`,
    },
    ...(input.reason
      ? { reason: { kind: "prose" as const, body: input.reason } }
      : {}),
    diff: {
      kind: "kv",
      gutter: 12,
      rows:
        rows.length > 0
          ? rows
          : [
              {
                key: "status",
                value: String(input.localValue.hubStatus),
                secondary: String(input.remoteValue.hubStatus),
              },
            ],
    },
    footer: {
      kind: "footer",
      label: "next",
      command: `archloop tasks push`,
    },
  };
};

export const hubTaskConflictResolveModelToBlocks = (
  model: HubTaskConflictResolveModel,
): readonly SectionBlock[] => {
  const blocks: SectionBlock[] = [model.header];
  if (model.reason) {
    blocks.push(model.reason);
  }
  blocks.push({
    kind: "prose",
    body: "local (left) · remote (right)",
  });
  blocks.push(model.diff);
  blocks.push(model.footer);
  return blocks;
};

const readGithubIssueNumber = (
  task: Pick<HubTaskProjection, "remoteRefs" | "metadata">,
): number | undefined => {
  for (const ref of task.remoteRefs) {
    const issueNumber = parseGithubRemoteRef(ref);
    if (issueNumber !== undefined) {
      return issueNumber;
    }
  }
  const raw = task.metadata.github_issue ?? task.metadata.githubIssue;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return undefined;
};

export const loadRemoteConflictIssue = (
  task: HubTaskProjection,
  github: GithubIssueClient,
): GithubIssueRecord => {
  const issueNumber = readGithubIssueNumber(task);
  if (issueNumber === undefined) {
    throw new TaskBoardError({
      message: `archloop tasks resolve ${task.id} requires a linked GitHub issue (remote_refs / github_issue metadata).`,
    });
  }

  const issue = github.listIssues().find((entry) => entry.number === issueNumber);
  if (!issue) {
    throw new TaskBoardError({
      message: `archloop tasks resolve ${task.id} could not find linked GitHub issue #${issueNumber}. Re-run with network access or refresh via archloop tasks pull.`,
    });
  }
  return issue;
};

export const buildConflictFieldValues = (input: {
  readonly task: HubTaskProjection;
  readonly issue: GithubIssueRecord;
}): {
  readonly localValue: HubConflictFieldValues;
  readonly remoteValue: HubConflictFieldValues;
  readonly divergedFields: HubConflictField[];
  readonly reason: string | undefined;
} => {
  const reason = readSyncConflictReason(input.task.metadata);
  const localStatus = resolveLocalConflictHubStatus(input.task);
  const remoteStatus = resolveRemoteCollaborationStatus(input.issue);
  const localValue: HubConflictFieldValues = {
    title: input.task.title,
    hubStatus: localStatus,
    description: input.task.description ?? "",
  };
  const remoteValue: HubConflictFieldValues = {
    title: input.issue.title,
    hubStatus: remoteStatus,
    description: input.issue.body ?? "",
  };
  return {
    localValue,
    remoteValue,
    divergedFields: detectDivergedConflictFields(
      localValue,
      remoteValue,
      reason,
    ),
    reason,
  };
};

export const applyHubTaskConflictResolution = (input: {
  readonly cwd: string;
  readonly taskId: string;
  readonly mutation: HubTaskConflictBeadsMutation;
  readonly remoteUpdatedAt?: string;
  readonly env?: NodeJS.ProcessEnv;
}): HubTaskProjection => {
  const env = input.env ?? process.env;
  const task = loadHubTask(input.cwd, input.taskId, env);
  const metadata: Record<string, unknown> = {
    ...task.metadata,
    sync_state: input.mutation.syncState,
  };
  delete metadata.sync_conflict;
  delete metadata.syncConflict;
  delete metadata.sync_conflict_reason;
  delete metadata.syncConflictReason;
  if (input.remoteUpdatedAt) {
    metadata.remote_updated_at = input.remoteUpdatedAt;
  }

  const updated = updateHubTaskStatus({
    cwd: input.cwd,
    taskId: input.taskId,
    hubStatus: input.mutation.hubStatus,
    metadata,
    env,
  });

  if (
    input.mutation.title === undefined &&
    input.mutation.description === undefined
  ) {
    return updated;
  }

  const args: string[] = [];
  if (input.mutation.title !== undefined) {
    args.push("--title", input.mutation.title);
  }
  if (input.mutation.description !== undefined) {
    args.push("--description", input.mutation.description);
  }
  appendBdMetadataArg(args, {
    ...updated.metadata,
    sync_state: input.mutation.syncState,
  });
  runBdTextForHubTaskStore(
    input.cwd,
    ["update", input.taskId, ...args],
    `tasks resolve ${input.taskId}`,
    env,
  );
  return loadHubTask(input.cwd, input.taskId, env);
};

export interface ResolveHubTaskSyncConflictInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly keep: HubConflictKeep;
  readonly env?: NodeJS.ProcessEnv;
  readonly github?: GithubIssueClient;
}

export interface ResolveHubTaskSyncConflictResult {
  readonly id: string;
  readonly kept: HubConflictKeep;
  readonly mutations: readonly HubTaskConflictMutationEntry[];
  readonly task: HubTaskProjection;
  readonly model: HubTaskConflictResolveModel;
}

export const resolveHubTaskSyncConflict = (
  input: ResolveHubTaskSyncConflictInput,
): ResolveHubTaskSyncConflictResult => {
  const env = input.env ?? process.env;
  const task = loadHubTask(input.cwd, input.taskId, env);

  if (!hasHubTaskSyncConflict(task)) {
    throw new TaskBoardError({
      message: `archloop tasks resolve ${task.id}: nothing to resolve. This task has no sync conflict. Try archloop tasks show ${task.id}.`,
    });
  }

  const github =
    input.github ??
    createDefaultGithubIssueClient(input.cwd, env, { includeClosed: true });
  const issue = loadRemoteConflictIssue(task, github);
  const { localValue, remoteValue, divergedFields, reason } =
    buildConflictFieldValues({ task, issue });
  const mutation = resolveHubTaskConflict({
    localValue,
    remoteValue,
    keep: input.keep,
    divergedFields,
  });
  const resolvedTask = applyHubTaskConflictResolution({
    cwd: input.cwd,
    taskId: task.id,
    mutation,
    remoteUpdatedAt: issue.updatedAt,
    env,
  });

  return {
    id: task.id,
    kept: input.keep,
    mutations: mutation.mutations,
    task: resolvedTask,
    model: buildHubTaskConflictResolveModel({
      taskId: task.id,
      reason,
      localValue,
      remoteValue,
      divergedFields,
    }),
  };
};

export const formatResolveHubTaskConflictJson = (
  result: Pick<ResolveHubTaskSyncConflictResult, "id" | "kept" | "mutations">,
): string =>
  JSON.stringify(
    {
      id: result.id,
      kept: result.kept,
      mutations: result.mutations,
    } satisfies HubTaskConflictResolveJsonResult,
    null,
    2,
  );
