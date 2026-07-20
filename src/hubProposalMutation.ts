import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

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
  readonly trackedContentFingerprints?: readonly ProposalFlowTrackedContentFingerprint[];
}

export interface ProposalFlowTrackedContentFingerprint {
  readonly path: string;
  readonly indexEntries: readonly ProposalFlowIndexEntryFingerprint[];
  readonly worktree: ProposalFlowWorktreeFingerprint;
}

export interface ProposalFlowIndexEntryFingerprint {
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
}

export type ProposalFlowWorktreeFingerprint =
  | {
      readonly kind: "file";
      readonly executable: boolean;
      readonly hash: string;
    }
  | { readonly kind: "symlink"; readonly hash: string }
  | { readonly kind: "directory" | "missing" | "other" | "unreadable" };

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

const GIT_EXEC_MAX_BUFFER = 10 * 1024 * 1024;

const runGitText = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_EXEC_MAX_BUFFER,
    env,
  }).trimEnd();

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

const parseTrackedPathsFromNullStatus = (output: string): string[] => {
  const records = output.split("\0");
  const paths = new Set<string>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) {
      continue;
    }

    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code !== "??" && code !== "!!" && path.length > 0) {
      paths.add(path);
    }

    if (code.includes("R") || code.includes("C")) {
      index += 1;
    }
  }

  return [...paths].sort();
};

const readIndexEntriesByPath = (
  cwd: string,
  paths: readonly string[],
  env: NodeJS.ProcessEnv,
): Map<string, ProposalFlowIndexEntryFingerprint[]> => {
  if (paths.length === 0) {
    return new Map();
  }

  const output = runGitText(
    cwd,
    ["ls-files", "--stage", "-z", "--", ...paths],
    env,
  );
  const entriesByPath = new Map<string, ProposalFlowIndexEntryFingerprint[]>();

  for (const record of output.split("\0")) {
    const separatorIndex = record.indexOf("\t");
    if (separatorIndex < 0) {
      continue;
    }

    const [mode, objectId, rawStage] = record
      .slice(0, separatorIndex)
      .split(" ");
    const path = record.slice(separatorIndex + 1);
    const stage = Number(rawStage);
    if (!mode || !objectId || !path || !Number.isInteger(stage)) {
      continue;
    }

    const entries = entriesByPath.get(path) ?? [];
    entries.push({ mode, objectId, stage });
    entriesByPath.set(path, entries);
  }

  for (const entries of entriesByPath.values()) {
    entries.sort((left, right) => left.stage - right.stage);
  }
  return entriesByPath;
};

const hashContent = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const captureWorktreeFingerprint = (
  cwd: string,
  path: string,
): ProposalFlowWorktreeFingerprint => {
  const absolutePath = resolve(cwd, path);

  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      return { kind: "symlink", hash: hashContent(readlinkSync(absolutePath)) };
    }
    if (stats.isFile()) {
      return {
        kind: "file",
        executable: (stats.mode & 0o111) !== 0,
        hash: hashContent(readFileSync(absolutePath)),
      };
    }
    if (stats.isDirectory()) {
      return { kind: "directory" };
    }
    return { kind: "other" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable" };
  }
};

const captureTrackedContentFingerprints = (
  cwd: string,
  env: NodeJS.ProcessEnv,
): ProposalFlowTrackedContentFingerprint[] => {
  const nullStatus = runGitText(cwd, ["status", "--porcelain=v1", "-z"], env);
  const paths = parseTrackedPathsFromNullStatus(nullStatus);
  const indexEntriesByPath = readIndexEntriesByPath(cwd, paths, env);

  return paths.map((path) => ({
    path,
    indexEntries: indexEntriesByPath.get(path) ?? [],
    worktree: captureWorktreeFingerprint(cwd, path),
  }));
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

const buildTrackedContentFingerprintMap = (
  fingerprints: readonly ProposalFlowTrackedContentFingerprint[] | undefined,
): Map<string, string> =>
  new Map(
    (fingerprints ?? []).map(({ path, indexEntries, worktree }) => [
      path,
      stableStringify({ indexEntries, worktree }),
    ]),
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
  // Avoid `-uall`: it expands every nested untracked file (e.g. node_modules) and
  // can exceed spawnSync buffers. Top-level porcelain entries are enough for mutation detection.
  const statusOutput = runGitText(input.cwd, ["status", "--porcelain=v1"], env);
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
      trackedContentFingerprints: captureTrackedContentFingerprints(
        input.cwd,
        env,
      ),
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
  const trackedContentDiff = diffStringKeyedMaps(
    buildTrackedContentFingerprintMap(before.repo.trackedContentFingerprints),
    buildTrackedContentFingerprintMap(after.repo.trackedContentFingerprints),
  );
  const changedPaths = [
    ...new Set([...workingTreeDiff.changed, ...trackedContentDiff.changed]),
  ].sort();
  if (
    workingTreeDiff.added.length > 0 ||
    workingTreeDiff.removed.length > 0 ||
    changedPaths.length > 0
  ) {
    repoMutations.push({
      kind: "working_tree_changed",
      addedPaths: workingTreeDiff.added,
      removedPaths: workingTreeDiff.removed,
      changedPaths,
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
    "Proposal flow detected forbidden mutations. The proposal was not applied and archLoop did not revert the changes.",
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
