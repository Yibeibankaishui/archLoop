import { execFileSync } from "node:child_process";

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
    const stdout = execFileSync("bd", ["list", "--json"], {
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

const parseStatusPath = (line: string): string | undefined => {
  const match = line.trimEnd().match(/^.. (.+)$/);
  if (!match) {
    return undefined;
  }
  const path = match[1]?.trim();
  if (!path) {
    return undefined;
  }
  if (path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1);
  }
  return path;
};

const parseStatusCode = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  return trimmed.slice(0, 2);
};

const diffStatusLines = (
  beforeLines: readonly string[],
  afterLines: readonly string[],
): {
  readonly addedPaths: string[];
  readonly removedPaths: string[];
  readonly changedPaths: string[];
} => {
  const beforeByPath = new Map<string, string>();
  for (const line of beforeLines) {
    const path = parseStatusPath(line);
    const code = parseStatusCode(line);
    if (path && code) {
      beforeByPath.set(path, code);
    }
  }

  const afterByPath = new Map<string, string>();
  for (const line of afterLines) {
    const path = parseStatusPath(line);
    const code = parseStatusCode(line);
    if (path && code) {
      afterByPath.set(path, code);
    }
  }

  const addedPaths: string[] = [];
  const removedPaths: string[] = [];
  const changedPaths: string[] = [];

  for (const [path, code] of afterByPath) {
    const beforeCode = beforeByPath.get(path);
    if (beforeCode === undefined) {
      addedPaths.push(path);
      continue;
    }
    if (beforeCode !== code) {
      changedPaths.push(path);
    }
  }

  for (const path of beforeByPath.keys()) {
    if (!afterByPath.has(path)) {
      removedPaths.push(path);
    }
  }

  return {
    addedPaths: addedPaths.sort(),
    removedPaths: removedPaths.sort(),
    changedPaths: changedPaths.sort(),
  };
};

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
  if (
    workingTreeDiff.addedPaths.length > 0 ||
    workingTreeDiff.removedPaths.length > 0 ||
    workingTreeDiff.changedPaths.length > 0
  ) {
    repoMutations.push({
      kind: "working_tree_changed",
      addedPaths: workingTreeDiff.addedPaths,
      removedPaths: workingTreeDiff.removedPaths,
      changedPaths: workingTreeDiff.changedPaths,
    });
  }

  const beforeTasks = new Map(
    before.taskStore.tasks.flatMap((task) => {
      const id = readTaskId(task);
      return id ? [[id, stableStringify(task)] as const] : [];
    }),
  );
  const afterTasks = new Map(
    after.taskStore.tasks.flatMap((task) => {
      const id = readTaskId(task);
      return id ? [[id, stableStringify(task)] as const] : [];
    }),
  );

  const addedTaskIds: string[] = [];
  const removedTaskIds: string[] = [];
  const changedTaskIds: string[] = [];

  for (const [taskId, serialized] of afterTasks) {
    const beforeSerialized = beforeTasks.get(taskId);
    if (beforeSerialized === undefined) {
      addedTaskIds.push(taskId);
      continue;
    }
    if (beforeSerialized !== serialized) {
      changedTaskIds.push(taskId);
    }
  }

  for (const taskId of beforeTasks.keys()) {
    if (!afterTasks.has(taskId)) {
      removedTaskIds.push(taskId);
    }
  }

  const taskStoreMutations: ProposalFlowTaskStoreMutation[] = [];
  if (
    addedTaskIds.length > 0 ||
    removedTaskIds.length > 0 ||
    changedTaskIds.length > 0
  ) {
    taskStoreMutations.push({
      kind: "tasks_changed",
      addedTaskIds: addedTaskIds.sort(),
      removedTaskIds: removedTaskIds.sort(),
      changedTaskIds: changedTaskIds.sort(),
    });
  }

  return {
    hasMutations: repoMutations.length > 0 || taskStoreMutations.length > 0,
    repoMutations,
    taskStoreMutations,
  };
};

const formatPathList = (label: string, paths: readonly string[]): string[] =>
  paths.length > 0 ? [`  ${label}: ${paths.join(", ")}`] : [];

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
      ...formatPathList("added", mutation.addedPaths),
      ...formatPathList("removed", mutation.removedPaths),
      ...formatPathList("modified", mutation.changedPaths),
    );
  }

  for (const mutation of report.taskStoreMutations) {
    lines.push("Local task store changed:");
    lines.push(
      ...formatPathList("added tasks", mutation.addedTaskIds),
      ...formatPathList("removed tasks", mutation.removedTaskIds),
      ...formatPathList("changed tasks", mutation.changedTaskIds),
    );
  }

  return lines;
};

export const formatProposalFlowMutationReason = (
  report: ProposalFlowMutationReport,
): string => formatProposalFlowMutationLines(report).join("\n");
