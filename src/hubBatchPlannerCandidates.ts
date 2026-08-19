import { parseDeclaredHubBlockers } from "./hubBlockerResolution.js";
import { runBdTextForHubTaskStore } from "./hubTaskStore.js";
import {
  isCompletedHubStatus,
  loadHubTaskBoard,
  type HubTaskBoard,
  type HubTaskProjection,
} from "./taskBoard.js";

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
  readonly blockersResolved: readonly HubBatchPlannerResolvedBlocker[];
  readonly openBlockers: readonly string[];
  readonly unknownBlockers: readonly string[];
  readonly blockerSource: HubBatchPlannerBlockerSource;
}

export interface HubBatchPlannerResolvedBlocker {
  readonly ref: string;
  readonly taskId: string;
  readonly title: string;
  readonly hubStatus: HubTaskProjection["hubStatus"];
  readonly claimState?: HubTaskProjection["claimState"];
}

interface HubTaskBlockerIndexes {
  readonly byId: ReadonlyMap<string, HubTaskProjection>;
  readonly byRemoteRef: ReadonlyMap<string, HubTaskProjection>;
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

const tryLoadHubTaskBoard = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): HubTaskBoard | undefined => {
  try {
    return loadHubTaskBoard(cwd, env);
  } catch {
    return undefined;
  }
};

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

const resolveBlockerSource = (input: {
  readonly beadsDependencyBlockers: readonly string[];
  readonly metadataBlockers: readonly string[];
  readonly blockersDeclared: readonly string[];
}): HubBatchPlannerBlockerSource => {
  if (
    input.beadsDependencyBlockers.length > 0 ||
    input.metadataBlockers.length > 0
  ) {
    return "beads_dependency";
  }
  if (input.blockersDeclared.length > 0) {
    return "description";
  }
  return "none";
};

const buildHubTaskIndexes = (board: HubTaskBoard): HubTaskBlockerIndexes => {
  const byId = new Map<string, HubTaskProjection>();
  const byRemoteRef = new Map<string, HubTaskProjection>();

  for (const task of board.tasks) {
    byId.set(task.id, task);
    for (const ref of task.remoteRefs) {
      if (!byRemoteRef.has(ref)) {
        byRemoteRef.set(ref, task);
      }
    }
  }

  return { byId, byRemoteRef };
};

const resolveDeclaredBlocker = (
  ref: string,
  indexes: HubTaskBlockerIndexes,
): HubTaskProjection | undefined => {
  if (ref.startsWith("github#")) {
    return indexes.byRemoteRef.get(ref);
  }

  return indexes.byId.get(ref);
};

const resolveDeclaredBlockers = (
  declaredBlockers: readonly string[],
  indexes: HubTaskBlockerIndexes | undefined,
): {
  readonly blockersResolved: readonly HubBatchPlannerResolvedBlocker[];
  readonly openBlockers: readonly string[];
  readonly unknownBlockers: readonly string[];
} => {
  if (!indexes) {
    return {
      blockersResolved: [],
      openBlockers: [],
      unknownBlockers: declaredBlockers,
    };
  }

  const blockersResolved: HubBatchPlannerResolvedBlocker[] = [];
  const openBlockers: string[] = [];
  const unknownBlockers: string[] = [];

  for (const ref of declaredBlockers) {
    const task = resolveDeclaredBlocker(ref, indexes);
    if (!task) {
      unknownBlockers.push(ref);
      continue;
    }

    blockersResolved.push({
      ref,
      taskId: task.id,
      title: task.title,
      hubStatus: task.hubStatus,
      claimState: task.claimState,
    });

    if (!isCompletedHubStatus(task.hubStatus)) {
      openBlockers.push(ref);
    }
  }

  return {
    blockersResolved,
    openBlockers: uniqueStrings(openBlockers),
    unknownBlockers: uniqueStrings(unknownBlockers),
  };
};

const firstNonEmptyText = (
  ...values: readonly (string | undefined)[]
): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
};

const mergePlannerCandidateFields = (
  task: HubTaskProjection,
  boardTask: HubTaskProjection | undefined,
): {
  readonly description?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly remoteRefs: readonly string[];
} => {
  const description = firstNonEmptyText(
    task.description,
    boardTask?.description,
  );
  const metadata = {
    ...(boardTask?.metadata ?? {}),
    ...(task.metadata ?? {}),
  };
  const remoteRefs = uniqueStrings([
    ...(boardTask?.remoteRefs ?? []),
    ...(task.remoteRefs ?? []),
  ]);

  return { description, metadata, remoteRefs };
};

export const enrichHubBatchPlannerCandidate = (
  task: HubTaskProjection,
  input: {
    readonly beadsDependencyBlockers?: readonly string[];
    readonly hubTaskBlockerIndexes?: HubTaskBlockerIndexes;
  } = {},
): HubBatchPlannerCandidate => {
  const boardTask = input.hubTaskBlockerIndexes?.byId.get(task.id);
  const { description, metadata, remoteRefs } = mergePlannerCandidateFields(
    task,
    boardTask,
  );
  const metadataBlockers = readMetadataBlockers(metadata);
  const beadsDependencyBlockers = input.beadsDependencyBlockers ?? [];
  const explicitBlockers =
    beadsDependencyBlockers.length > 0
      ? beadsDependencyBlockers
      : metadataBlockers;

  const declaredBlockers = parseDeclaredHubBlockers(description ?? "");
  const blockersDeclared =
    explicitBlockers.length > 0 ? explicitBlockers : declaredBlockers;
  const blockerSource = resolveBlockerSource({
    beadsDependencyBlockers,
    metadataBlockers,
    blockersDeclared,
  });
  const blockerResolution = resolveDeclaredBlockers(
    blockersDeclared,
    input.hubTaskBlockerIndexes,
  );

  return {
    id: task.id,
    title: task.title,
    description,
    priority: readPriority(metadata),
    labels: task.labels ?? [],
    hubStatus: task.hubStatus,
    claimState: task.claimState,
    metadata,
    remoteRefs,
    parentPrdRef: readParentPrdRef(metadata, remoteRefs),
    explicitBlockers,
    blockersDeclared,
    blockersResolved: blockerResolution.blockersResolved,
    openBlockers: blockerResolution.openBlockers,
    unknownBlockers: blockerResolution.unknownBlockers,
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
  const hubTaskBlockerIndexes = (() => {
    const hubTaskBoard = tryLoadHubTaskBoard(input.cwd, input.env);
    return hubTaskBoard ? buildHubTaskIndexes(hubTaskBoard) : undefined;
  })();

  return input.candidates.map((task) =>
    enrichHubBatchPlannerCandidate(task, {
      beadsDependencyBlockers: beadsDependencyBlockersByTaskId[task.id],
      hubTaskBlockerIndexes,
    }),
  );
};

type HubBatchPlannerPromptCandidate = Omit<
  HubBatchPlannerCandidate,
  "description" | "blockersDeclared" | "blockerSource"
>;

const toHubBatchPlannerPromptCandidate = (
  candidate: HubBatchPlannerCandidate,
): HubBatchPlannerPromptCandidate => {
  const {
    description: _description,
    blockersDeclared: _blockersDeclared,
    blockerSource: _blockerSource,
    ...promptCandidate
  } = candidate;

  return promptCandidate;
};

export const serializeHubBatchPlannerCandidates = (
  candidates: readonly HubBatchPlannerCandidate[],
): string =>
  JSON.stringify(candidates.map(toHubBatchPlannerPromptCandidate), null, 2);
