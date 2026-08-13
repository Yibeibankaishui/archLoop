import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { runBdTextForHubTaskStore } from "./hubTaskStore.js";
import { resolveHubTaskStoreRedirectPath } from "./hubTaskStoreResolver.js";
import {
  appendHubTaskComment,
  loadHubTask,
  type BeadsTaskComment,
  type HubTaskProjection,
} from "./taskBoard.js";

export const HUB_TASK_NOTES_TAG = "task-notes";
export const HUB_TASK_NOTES_SCHEMA_VERSION = 1;
export const HUB_APPLIED_NOTE_FINGERPRINTS_KEY = "hubAppliedNoteFingerprints";

const SNAPSHOT_FILE_NAME = "snapshot.json";
const MAX_NOTES_BYTES = 32_768;
const MAX_NOTE_COMMENTS = 8;
const MAX_COMMENT_BYTES = 8_192;
const CREDENTIAL_KEY_PATTERN =
  /secret|token|password|credential|api[_-]?key|authorization|private[_-]?key/i;

export class HubTaskSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubTaskSnapshotError";
  }
}

export interface HubTaskSnapshotRecord {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly notes?: string;
  readonly comments: readonly BeadsTaskComment[];
  readonly remoteRefs: readonly string[];
  readonly labels: readonly string[];
  readonly hubStatus?: string;
  readonly acceptanceCriteria?: string;
}

export interface HubTaskSnapshotDocument {
  readonly schemaVersion: 1;
  readonly task: HubTaskSnapshotRecord;
  readonly parentPrd?: HubTaskSnapshotRecord;
  readonly dependencies: readonly HubTaskSnapshotRecord[];
}

export interface HubTaskSnapshot {
  readonly snapshotDir: string;
  readonly taskId: string;
  readonly promptContent: string;
  readonly sandboxEnv: Readonly<Record<string, string>>;
  readonly document: HubTaskSnapshotDocument;
  readonly restoreRedirect?: () => void;
}

export interface CreateHubTaskSnapshotInput {
  readonly cwd: string;
  readonly taskId: string;
  readonly runDir: string;
  readonly role: "implement" | "review";
  readonly attemptId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly hubProjectDir?: string;
}

export interface HubTaskNotes {
  readonly schemaVersion: typeof HUB_TASK_NOTES_SCHEMA_VERSION;
  readonly taskId: string;
  readonly comments: readonly string[];
}

export type ParseHubTaskNotesResult =
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly diagnostic: string }
  | { readonly status: "valid"; readonly notes: HubTaskNotes };

export type ApplyHubTaskNotesResult =
  | { readonly status: "absent" }
  | { readonly status: "rejected"; readonly diagnostic: string }
  | {
      readonly status: "applied";
      readonly fingerprint: string;
      readonly commentCount: number;
    }
  | { readonly status: "replayed"; readonly fingerprint: string };

const uniqueStrings = (values: readonly string[]): string[] => [
  ...new Set(values.filter((value) => value.trim().length > 0)),
];

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

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const assertNoSymlinkReplacement = (path: string): void => {
  if (isSymlink(path)) {
    throw new HubTaskSnapshotError(
      `Hub task snapshot path is a symlink and cannot be replaced: ${path}`,
    );
  }

  let current = path;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    if (isSymlink(parent)) {
      throw new HubTaskSnapshotError(
        `Hub task snapshot parent path is a symlink and cannot be used: ${parent}`,
      );
    }
    current = parent;
  }
};

const mkdirExclusive = (dir: string, mode: number): void => {
  assertNoSymlinkReplacement(dir);
  try {
    mkdirSync(dir, { recursive: false, mode });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    if (code === "EEXIST") {
      assertNoSymlinkReplacement(dir);
      throw new HubTaskSnapshotError(
        `Hub task snapshot directory already exists: ${dir}`,
      );
    }
    throw error;
  }
  chmodSync(dir, mode);
};

const writeExclusiveFile = (filePath: string, content: string): void => {
  assertNoSymlinkReplacement(filePath);
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;
  try {
    fd = openSync(filePath, flags, 0o600);
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
    fchmodSync(fd, 0o400);
  } catch (error) {
    if (isSymlink(filePath)) {
      throw new HubTaskSnapshotError(
        `Hub task snapshot path is a symlink and cannot be replaced: ${filePath}`,
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
};

const sanitizeMetadata = (
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      continue;
    }
    if (typeof value === "string" && CREDENTIAL_KEY_PATTERN.test(value)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
};

const toSnapshotRecord = (task: HubTaskProjection): HubTaskSnapshotRecord => {
  const description = task.description?.trim();
  return {
    id: task.id,
    title: task.title,
    ...(description ? { description, acceptanceCriteria: description } : {}),
    ...(task.notes?.trim() ? { notes: task.notes.trim() } : {}),
    comments: task.comments,
    remoteRefs: task.remoteRefs,
    labels: task.labels,
    hubStatus: task.hubStatus,
  };
};

const parseBdJsonOutput = (stdout: string): unknown[] => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
};

const tryLoadDependencyIds = (
  cwd: string,
  taskId: string,
  env: NodeJS.ProcessEnv | undefined,
): readonly string[] => {
  try {
    const stdout = runBdTextForHubTaskStore(
      cwd,
      ["dep", "list", taskId, "--json", "--type", "blocks"],
      "task snapshot dependencies",
      env,
    );
    const ids: string[] = [];
    for (const record of parseBdJsonOutput(stdout)) {
      if (!record || typeof record !== "object") {
        continue;
      }
      const row = record as Record<string, unknown>;
      const blockerId = readFirstString(row, [
        "depends_on_id",
        "dependsOnId",
        "blocker_id",
        "blockerId",
        "blocks",
        "id",
      ]);
      if (blockerId && blockerId !== taskId) {
        ids.push(blockerId);
      }
    }
    return uniqueStrings(ids);
  } catch {
    return [];
  }
};

const tryLoadTask = (
  cwd: string,
  taskId: string,
  env: NodeJS.ProcessEnv | undefined,
): HubTaskProjection | undefined => {
  try {
    return loadHubTask(cwd, taskId, env);
  } catch {
    return undefined;
  }
};

const resolveParentPrdId = (
  task: HubTaskProjection,
): string | undefined => {
  const record = sanitizeMetadata(task.metadata);
  return readFirstString(record, [
    "prd_ref",
    "prdRef",
    "parent_prd",
    "parentPrd",
    "parent",
  ]);
};

const buildSnapshotDocument = (input: {
  readonly cwd: string;
  readonly taskId: string;
  readonly env?: NodeJS.ProcessEnv;
}): HubTaskSnapshotDocument => {
  const task = loadHubTask(input.cwd, input.taskId, input.env);
  const parentPrdId = resolveParentPrdId(task);
  const parentPrd =
    parentPrdId && parentPrdId !== task.id
      ? tryLoadTask(input.cwd, parentPrdId, input.env)
      : undefined;
  const dependencyIds = tryLoadDependencyIds(
    input.cwd,
    task.id,
    input.env,
  ).filter((id) => id !== task.id && id !== parentPrd?.id);
  const dependencies = dependencyIds.flatMap((id) => {
    const dependency = tryLoadTask(input.cwd, id, input.env);
    return dependency ? [toSnapshotRecord(dependency)] : [];
  });

  return {
    schemaVersion: 1,
    task: toSnapshotRecord(task),
    ...(parentPrd ? { parentPrd: toSnapshotRecord(parentPrd) } : {}),
    dependencies,
  };
};

const formatComments = (comments: readonly BeadsTaskComment[]): string => {
  if (comments.length === 0) {
    return "(none)";
  }
  return comments
    .map((comment) => {
      const author = comment.author ? `${comment.author}: ` : "";
      return `- ${author}${comment.body ?? ""}`;
    })
    .join("\n");
};

const formatSnapshotRecord = (
  heading: string,
  record: HubTaskSnapshotRecord,
): string => {
  const lines = [
    `## ${heading}`,
    `- id: ${record.id}`,
    `- title: ${record.title}`,
  ];
  if (record.hubStatus) {
    lines.push(`- hub status: ${record.hubStatus}`);
  }
  if (record.remoteRefs.length > 0) {
    lines.push(`- remote refs: ${record.remoteRefs.join(", ")}`);
  }
  if (record.labels.length > 0) {
    lines.push(`- labels: ${record.labels.join(", ")}`);
  }
  if (record.description) {
    lines.push("", record.description);
  }
  lines.push("", "### Comments", formatComments(record.comments));
  return lines.join("\n");
};

export const formatHubTaskSnapshotPrompt = (
  document: HubTaskSnapshotDocument,
): string => {
  const sections = [
    "# IMMUTABLE TASK SNAPSHOT",
    "This is the only Beads context for this attempt. Do not query or write the live task store.",
    formatSnapshotRecord("Selected task", document.task),
  ];
  if (document.parentPrd) {
    sections.push(formatSnapshotRecord("Parent PRD", document.parentPrd));
  }
  if (document.dependencies.length > 0) {
    sections.push(
      ...document.dependencies.map((dependency, index) =>
        formatSnapshotRecord(`Required dependency ${index + 1}`, dependency),
      ),
    );
  }
  return sections.join("\n\n");
};

const resolveSnapshotDir = (input: CreateHubTaskSnapshotInput): string => {
  const attemptId = input.attemptId?.trim() || randomUUID();
  return join(
    input.runDir,
    "task-snapshots",
    input.role,
    input.taskId,
    attemptId,
  );
};

const restoreRedirectState = (
  redirectPath: string | undefined,
  previous: string | undefined,
): void => {
  if (!redirectPath) {
    return;
  }
  if (previous === undefined) {
    if (existsSync(redirectPath) && !isSymlink(redirectPath)) {
      rmSync(redirectPath, { force: true });
    }
    return;
  }
  writeFileSync(redirectPath, previous, { encoding: "utf8", mode: 0o600 });
};

const fenceTaskStoreRedirect = (
  cwd: string,
  snapshotDir: string,
): (() => void) => {
  const redirectPath = resolveHubTaskStoreRedirectPath(cwd);
  let previous: string | undefined;
  if (existsSync(redirectPath) && !isSymlink(redirectPath)) {
    previous = readFileSync(redirectPath, "utf8");
  }

  mkdirSync(dirname(redirectPath), { recursive: true, mode: 0o700 });
  writeFileSync(redirectPath, `${snapshotDir}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return () => restoreRedirectState(redirectPath, previous);
};

export const createHubAgentSandboxEnv = (
  snapshotDir: string,
): Readonly<Record<string, string>> => ({
  BEADS_DIR: snapshotDir,
});

export const createHubTaskSnapshot = (
  input: CreateHubTaskSnapshotInput,
): HubTaskSnapshot => {
  const snapshotDir = resolveSnapshotDir(input);
  mkdirSync(dirname(snapshotDir), { recursive: true, mode: 0o700 });
  mkdirExclusive(snapshotDir, 0o700);

  try {
    const document = buildSnapshotDocument({
      cwd: input.cwd,
      taskId: input.taskId,
      env: input.env,
    });
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    writeExclusiveFile(join(snapshotDir, SNAPSHOT_FILE_NAME), serialized);
    chmodSync(snapshotDir, 0o500);

    const restoreRedirect = fenceTaskStoreRedirect(input.cwd, snapshotDir);
    return {
      snapshotDir,
      taskId: input.taskId,
      promptContent: formatHubTaskSnapshotPrompt(document),
      sandboxEnv: createHubAgentSandboxEnv(snapshotDir),
      document,
      restoreRedirect,
    };
  } catch (error) {
    try {
      chmodSync(snapshotDir, 0o700);
    } catch {
      // Best-effort so a failed create cannot leave a 0500 directory behind.
    }
    rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
};

export const cleanupHubTaskSnapshot = (snapshot: HubTaskSnapshot): void => {
  try {
    snapshot.restoreRedirect?.();
  } catch {
    // Restore is best-effort so crash cleanup remains idempotent.
  }

  if (!existsSync(snapshot.snapshotDir)) {
    return;
  }

  try {
    chmodSync(snapshot.snapshotDir, 0o700);
  } catch {
    // Directory may already be gone.
  }

  rmSync(snapshot.snapshotDir, { recursive: true, force: true });
};

const unwrapFences = (value: string): string => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
};

const findLastTagContent = (text: string, tag: string): string | undefined => {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let lastContent: string | undefined;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf(openTag, searchFrom);
    if (start === -1) {
      break;
    }
    const contentStart = start + openTag.length;
    const end = text.indexOf(closeTag, contentStart);
    if (end === -1) {
      break;
    }
    lastContent = text.slice(contentStart, end);
    searchFrom = end + closeTag.length;
  }
  return lastContent;
};

const parseNotesObject = (value: unknown): HubTaskNotes => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HubTaskSnapshotError("task notes must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== HUB_TASK_NOTES_SCHEMA_VERSION) {
    throw new HubTaskSnapshotError(
      `task notes schemaVersion must be ${HUB_TASK_NOTES_SCHEMA_VERSION}`,
    );
  }
  const taskId = record.taskId;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new HubTaskSnapshotError("task notes taskId must be a non-empty string");
  }
  const commentsValue = record.comments ?? [];
  if (!Array.isArray(commentsValue)) {
    throw new HubTaskSnapshotError("task notes comments must be an array");
  }
  if (commentsValue.length > MAX_NOTE_COMMENTS) {
    throw new HubTaskSnapshotError(
      `task notes include ${commentsValue.length} comments; at most ${MAX_NOTE_COMMENTS} are allowed`,
    );
  }
  const comments = commentsValue.map((comment, index) => {
    if (typeof comment !== "string" || comment.trim().length === 0) {
      throw new HubTaskSnapshotError(
        `task notes comments[${index}] must be a non-empty string`,
      );
    }
    const trimmed = comment.trim();
    if (Buffer.byteLength(trimmed, "utf8") > MAX_COMMENT_BYTES) {
      throw new HubTaskSnapshotError(
        `task notes comments[${index}] exceeds ${MAX_COMMENT_BYTES} bytes`,
      );
    }
    return trimmed;
  });

  return {
    schemaVersion: HUB_TASK_NOTES_SCHEMA_VERSION,
    taskId: taskId.trim(),
    comments,
  };
};

export const parseHubTaskNotesFromText = (
  text: string,
): ParseHubTaskNotesResult => {
  const raw = findLastTagContent(text, HUB_TASK_NOTES_TAG);
  if (raw === undefined) {
    return { status: "absent" };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_NOTES_BYTES) {
    return {
      status: "invalid",
      diagnostic: `task notes exceed ${MAX_NOTES_BYTES} bytes`,
    };
  }
  try {
    const parsed = JSON.parse(unwrapFences(raw)) as unknown;
    return { status: "valid", notes: parseNotesObject(parsed) };
  } catch (error) {
    return {
      status: "invalid",
      diagnostic:
        error instanceof Error
          ? error.message
          : "task notes contain invalid JSON",
    };
  }
};

const fingerprintNotes = (notes: HubTaskNotes): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: notes.schemaVersion,
        taskId: notes.taskId,
        comments: notes.comments,
      }),
    )
    .digest("hex");

const readAppliedFingerprints = (
  metadata: Readonly<Record<string, unknown>>,
): string[] => {
  const value = metadata[HUB_APPLIED_NOTE_FINGERPRINTS_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

export const applyHubTaskNotes = (input: {
  readonly cwd: string;
  readonly taskId: string;
  readonly text: string;
  readonly env?: NodeJS.ProcessEnv;
}): ApplyHubTaskNotesResult => {
  const parsed = parseHubTaskNotesFromText(input.text);
  if (parsed.status === "absent") {
    return { status: "absent" };
  }
  if (parsed.status === "invalid") {
    return { status: "rejected", diagnostic: parsed.diagnostic };
  }
  if (parsed.notes.taskId !== input.taskId) {
    return {
      status: "rejected",
      diagnostic: `task notes taskId "${parsed.notes.taskId}" does not match selected task "${input.taskId}"`,
    };
  }

  const fingerprint = fingerprintNotes(parsed.notes);
  const task = loadHubTask(input.cwd, input.taskId, input.env);
  const applied = readAppliedFingerprints(task.metadata);
  if (applied.includes(fingerprint)) {
    return { status: "replayed", fingerprint };
  }

  for (const comment of parsed.notes.comments) {
    appendHubTaskComment(input.cwd, input.taskId, comment, input.env);
  }

  runBdTextForHubTaskStore(
    input.cwd,
    [
      "update",
      input.taskId,
      "--metadata",
      JSON.stringify({
        [HUB_APPLIED_NOTE_FINGERPRINTS_KEY]: [...applied, fingerprint],
      }),
    ],
    `task snapshot notes ${input.taskId}`,
    input.env,
  );

  return {
    status: "applied",
    fingerprint,
    commentCount: parsed.notes.comments.length,
  };
};

export const mergeHubAgentSandboxEnv = (
  sandboxEnv: Readonly<Record<string, string>> | undefined,
  snapshotEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
  ...(sandboxEnv ?? {}),
  ...snapshotEnv,
});
