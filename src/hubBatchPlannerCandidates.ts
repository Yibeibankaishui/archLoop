import { parseDeclaredBeadsBlockers } from "./hubBlockerResolution.js";
import { runBdTextForHubTaskStore } from "./hubTaskStore.js";
import type { HubTaskProjection } from "./taskBoard.js";

export type HubBatchPlannerBlockerSource =
  | "beads_dependency"
  | "description"
  | "none";

export interface HubBatchPlannerCandidate {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: string | number;
  readonly labels: readonly string[];
  readonly hubStatus: string;
  readonly claimState?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly remoteRefs: readonly string[];
  readonly parentPrdRef?: string;
  readonly explicitBlockers: readonly string[];
  readonly blockersDeclared: readonly string[];
  readonly blockerSource: HubBatchPlannerBlockerSource;
}

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

const readStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const id = readFirstString(record, [
        "id",
        "issue_id",
        "issueId",
        "depends_on_id",
        "dependsOnId",
        "blocker_id",
        "blockerId",
        "ref",
      ]);
      return id ? [id] : [];
    }
    return [];
  });
};

const readDependencyIds = (
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): readonly string[] => {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      return readStringList(value);
    }
  }
  return [];
};

const uniqueStrings = (values: readonly string[]): string[] => [
  ...new Set(values),
];

const parseBdJsonOutput = (stdout: string): unknown[] => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
};

const tryLoadBeadsDependencyBlockers = (input: {
  readonly cwd: string;
  readonly taskIds: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): Readonly<Record<string, readonly string[]>> => {
  if (input.taskIds.length === 0) {
    return {};
  }

  try {
    const stdout = runBdTextForHubTaskStore(
      input.cwd,
      ["dep", "list", ...input.taskIds, "--json", "--type", "blocks"],
      "batch planner dependency lookup",
      input.env,
    );
    const records = parseBdJsonOutput(stdout);
    const blockersByTaskId: Record<string, string[]> = {};

    for (const record of records) {
      if (!record || typeof record !== "object") {
        continue;
      }
      const row = record as Record<string, unknown>;
      const dependentId = readFirstString(row, [
        "issue_id",
        "issueId",
        "dependent_id",
        "dependentId",
        "id",
      ]);
      const blockerId = readFirstString(row, [
        "depends_on_id",
        "dependsOnId",
        "blocker_id",
        "blockerId",
        "blocks",
      ]);
      if (!dependentId || !blockerId) {
        continue;
      }
      blockersByTaskId[dependentId] = uniqueStrings([
        ...(blockersByTaskId[dependentId] ?? []),
        blockerId,
      ]);
    }

    return blockersByTaskId;
  } catch {
    return {};
  }
};

const readMetadataBlockers = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): readonly string[] =>
  readDependencyIds(metadata ?? {}, ["blockers", "blocked_by", "blockedBy"]);

const readParentPrdRef = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  remoteRefs: readonly string[],
): string | undefined => {
  const record = metadata ?? {};
  const metadataParent = readFirstString(record, [
    "parent_prd",
    "parentPrd",
    "parent",
    "github_issue",
    "githubIssue",
  ]);
  if (metadataParent) {
    return metadataParent;
  }

  const githubRemote = remoteRefs.find((ref) => ref.startsWith("github#"));
  return githubRemote;
};

const readPriority = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | number | undefined => {
  const record = metadata ?? {};
  const priority = record.priority ?? record.Priority;
  if (typeof priority === "number" || typeof priority === "string") {
    return priority;
  }
  return undefined;
};

export const enrichHubBatchPlannerCandidate = (
  task: HubTaskProjection,
  input: {
    readonly beadsDependencyBlockers?: readonly string[];
  } = {},
): HubBatchPlannerCandidate => {
  const metadataBlockers = readMetadataBlockers(task.metadata);
  const beadsDependencyBlockers = input.beadsDependencyBlockers ?? [];
  const explicitBlockers =
    beadsDependencyBlockers.length > 0
      ? beadsDependencyBlockers
      : metadataBlockers;

  const blockerBody = task.description ?? "";
  const declaredBlockers = parseDeclaredBeadsBlockers(blockerBody);
  const blockersDeclared =
    explicitBlockers.length > 0 ? explicitBlockers : declaredBlockers;

  const blockerSource: HubBatchPlannerBlockerSource =
    beadsDependencyBlockers.length > 0
      ? "beads_dependency"
      : metadataBlockers.length > 0
        ? "beads_dependency"
        : blockersDeclared.length > 0
          ? "description"
          : "none";

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: readPriority(task.metadata),
    labels: task.labels ?? [],
    hubStatus: task.hubStatus,
    claimState: task.claimState,
    metadata: task.metadata ?? {},
    remoteRefs: task.remoteRefs ?? [],
    parentPrdRef: readParentPrdRef(task.metadata, task.remoteRefs ?? []),
    explicitBlockers,
    blockersDeclared,
    blockerSource,
  };
};

export const enrichHubBatchPlannerCandidates = (input: {
  readonly cwd: string;
  readonly candidates: readonly HubTaskProjection[];
  readonly env?: NodeJS.ProcessEnv;
}): readonly HubBatchPlannerCandidate[] => {
  const taskIds = input.candidates.map((task) => task.id);
  const beadsDependencyBlockersByTaskId = tryLoadBeadsDependencyBlockers({
    cwd: input.cwd,
    taskIds,
    env: input.env,
  });

  return input.candidates.map((task) =>
    enrichHubBatchPlannerCandidate(task, {
      beadsDependencyBlockers: beadsDependencyBlockersByTaskId[task.id],
    }),
  );
};

export const serializeHubBatchPlannerCandidates = (
  candidates: readonly HubBatchPlannerCandidate[],
): string => JSON.stringify(candidates, null, 2);
