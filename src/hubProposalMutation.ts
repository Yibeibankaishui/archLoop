import { execFileSync } from "node:child_process";

import { resolveBdExecutable } from "./resolveBdExecutable.js";

const TASK_STORE_JSON_KEYS = [
  "tasks",
  "issues",
  "items",
  "results",
  "data",
  "beads",
] as const;

export interface ProposalFlowRepoSnapshot {
  readonly head: string;
  readonly statusLines: readonly string[];
}

export interface ProposalFlowTaskStoreSnapshot {
  readonly tasks: readonly Record<string, unknown>[];
}

export interface ProposalFlowStateSnapshot {
  readonly repo: ProposalFlowRepoSnapshot;
  readonly taskStore: ProposalFlowTaskStoreSnapshot;
}

export type ProposalFlowRepoMutation =
  | {
      readonly kind: "head_changed";
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "working_tree_changed";
      readonly addedPaths: readonly string[];
      readonly removedPaths: readonly string[];
      readonly changedPaths: readonly string[];
    };

export interface ProposalFlowTaskStoreMutation {
  readonly kind: "tasks_changed";
  readonly addedTaskIds: readonly string[];
  readonly removedTaskIds: readonly string[];
  readonly changedTaskIds: readonly string[];
}

export interface ProposalFlowMutationReport {
  readonly hasMutations: boolean;
  readonly repoMutations: readonly ProposalFlowRepoMutation[];
  readonly taskStoreMutations: readonly ProposalFlowTaskStoreMutation[];
}

const runGitText = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }).trim();

const tryGitText = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  try {
    return runGitText(cwd, args, env);
  } catch {
    return undefined;
  }
};

const parseBdJsonOutput = (output: string): unknown[] => {
  const parsed = JSON.parse(output) as unknown;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of TASK_STORE_JSON_KEYS) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
    return [parsed];
  }
  return [];
};

const tryRunBdJson = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): unknown[] => {
  try {
    const stdout = execFileSync(resolveBdExecutable(env), ["list", "--json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return parseBdJsonOutput(stdout);
  } catch {
    return [];
  }
};

const readTaskId = (task: Record<string, unknown>): string | undefined => {
  const id = task.id;
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  return undefined;
};

const normalizeTaskRecord = (
  task: unknown,
): Record<string, unknown> | undefined => {
  if (!task || typeof task !== "object") {
    return undefined;
  }
  return task as Record<string, unknown>;
};

const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      );
    }
    return current;
  });

const sortTasks = (
  tasks: readonly Record<string, unknown>[],
): Record<string, unknown>[] =>
  [...tasks].sort((left, right) => {
    const leftId = readTaskId(left) ?? "";
    const rightId = readTaskId(right) ?? "";
    return leftId.localeCompare(rightId);
  });

const parseGitStatusLine = (
  line: string,
): { readonly path: string; readonly code: string } | undefined => {
  const trimmed = line.trimEnd();
  const match = trimmed.match(/^.. (.+)$/);
  if (!match) {
    return undefined;
  }

  const code = trimmed.slice(0, 2);
  const rawPath = match[1]?.trim();
  if (!rawPath) {
    return undefined;
  }

  const path =
    rawPath.startsWith('"') && rawPath.endsWith('"')
      ? rawPath.slice(1, -1)
      : rawPath;
  return { path, code };
};

const statusLinesToPathMap = (
  lines: readonly string[],
): Map<string, string> => {
  const byPath = new Map<string, string>();
  for (const line of lines) {
    const entry = parseGitStatusLine(line);
    if (entry) {
      byPath.set(entry.path, entry.code);
    }
  }
  return byPath;
};

const diffStringKeyedMaps = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
} => {
  const added: string[] = [];
  const changed: string[] = [];

  for (const [key, afterValue] of after) {
    const beforeValue = before.get(key);
    if (beforeValue === undefined) {
      added.push(key);
      continue;
    }
    if (beforeValue !== afterValue) {
      changed.push(key);
    }
  }

  const removed: string[] = [];
  for (const key of before.keys()) {
    if (!after.has(key)) {
      removed.push(key);
    }
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
};

const diffStatusLines = (
  beforeLines: readonly string[],
  afterLines: readonly string[],
): ReturnType<typeof diffStringKeyedMaps> =>
  diffStringKeyedMaps(
    statusLinesToPathMap(beforeLines),
    statusLinesToPathMap(afterLines),
  );

const buildTaskIdSnapshotMap = (
  tasks: readonly Record<string, unknown>[],
): Map<string, string> =>
  new Map(
    tasks.flatMap((task) => {
      const id = readTaskId(task);
      return id ? [[id, stableStringify(task)] as const] : [];
    }),
  );

const hasKeyedDiff = (diff: {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}): boolean =>
  diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

export const captureProposalFlowStateSnapshot = (input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): ProposalFlowStateSnapshot => {
  const env = input.env ?? process.env;
  const statusOutput = runGitText(
    input.cwd,
    ["status", "--porcelain=v1", "-uall"],
    env,
  );
  const statusLines = statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .sort();

  const tasks = sortTasks(
    tryRunBdJson(input.cwd, env)
      .map(normalizeTaskRecord)
      .filter((task): task is Record<string, unknown> => task !== undefined),
  );

  return {
    repo: {
      head: tryGitText(input.cwd, ["rev-parse", "HEAD"], env) ?? "",
      statusLines,
    },
    taskStore: { tasks },
  };
};

export const detectProposalFlowMutations = (
  before: ProposalFlowStateSnapshot,
  after: ProposalFlowStateSnapshot,
): ProposalFlowMutationReport => {
  const repoMutations: ProposalFlowRepoMutation[] = [];

  if (before.repo.head !== after.repo.head) {
    repoMutations.push({
      kind: "head_changed",
      before: before.repo.head,
      after: after.repo.head,
    });
  }

  const workingTreeDiff = diffStatusLines(
    before.repo.statusLines,
    after.repo.statusLines,
  );
  if (hasKeyedDiff(workingTreeDiff)) {
    repoMutations.push({
      kind: "working_tree_changed",
      addedPaths: workingTreeDiff.added,
      removedPaths: workingTreeDiff.removed,
      changedPaths: workingTreeDiff.changed,
    });
  }

  const taskDiff = diffStringKeyedMaps(
    buildTaskIdSnapshotMap(before.taskStore.tasks),
    buildTaskIdSnapshotMap(after.taskStore.tasks),
  );

  const taskStoreMutations: ProposalFlowTaskStoreMutation[] = [];
  if (hasKeyedDiff(taskDiff)) {
    taskStoreMutations.push({
      kind: "tasks_changed",
      addedTaskIds: taskDiff.added,
      removedTaskIds: taskDiff.removed,
      changedTaskIds: taskDiff.changed,
    });
  }

  return {
    hasMutations: repoMutations.length > 0 || taskStoreMutations.length > 0,
    repoMutations,
    taskStoreMutations,
  };
};

const formatLabeledItemList = (
  label: string,
  items: readonly string[],
): string[] => (items.length > 0 ? [`  ${label}: ${items.join(", ")}`] : []);

export const formatProposalFlowMutationLines = (
  report: ProposalFlowMutationReport,
): readonly string[] => {
  if (!report.hasMutations) {
    return [];
  }

  const lines = [
    "Proposal flow detected forbidden mutations. The proposal was not applied and Sandcastle did not revert the changes.",
  ];

  for (const mutation of report.repoMutations) {
    if (mutation.kind === "head_changed") {
      lines.push(
        `Repository commit changed (${mutation.before.slice(0, 7)} -> ${mutation.after.slice(0, 7)}).`,
      );
      continue;
    }

    lines.push("Repository working tree changed:");
    lines.push(
      ...formatLabeledItemList("added", mutation.addedPaths),
      ...formatLabeledItemList("removed", mutation.removedPaths),
      ...formatLabeledItemList("modified", mutation.changedPaths),
    );
  }

  for (const mutation of report.taskStoreMutations) {
    lines.push("Local task store changed:");
    lines.push(
      ...formatLabeledItemList("added tasks", mutation.addedTaskIds),
      ...formatLabeledItemList("removed tasks", mutation.removedTaskIds),
      ...formatLabeledItemList("changed tasks", mutation.changedTaskIds),
    );
  }

  return lines;
};

export const formatProposalFlowMutationReason = (
  report: ProposalFlowMutationReport,
): string => formatProposalFlowMutationLines(report).join("\n");
