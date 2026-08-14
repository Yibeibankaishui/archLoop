import { execFileSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { HubTaskEvent } from "./hubExecution.js";
import {
  bindHubLandingVerification,
  closeHubLandingTask,
  computeHubVerifierFingerprint,
  resolveHubLandingCandidateManifestPath,
  resolveHubLandingCandidateRef,
  type HubLandingFaultInjection,
  type HubLandingTaskCloseReader,
  type HubLandingTaskCloser,
} from "./hubLanding.js";
import {
  type HubLandingPolicy,
  readHubLandingPolicy,
} from "./hubLandingPolicy.js";
import {
  appendHubLandingCheckpoint,
  loadHubLandingTransaction,
  resolveHubLandingTransactionId,
} from "./hubLandingTransaction.js";
import { readTaskEvents } from "./hubRunEventLog.js";
import {
  isCompletedHubStatus,
  resolveHubTaskBranch,
  type HubTaskStatus,
} from "./taskBoard.js";

export const HUB_LEGACY_LANDING_INTEGRITY = "legacy_landing_integrity";

const NO_RECOVER_SUFFIX =
  "This is not a task failure and does not require a recovery command.";

const inspectAction =
  "Inspect the task branch, configured target, and historical events. Do not close or reimplement the task automatically.";

export type HubLegacyLandingDecision =
  | "grandfathered_closed"
  | "ancestry_contained"
  | "event_without_ancestry"
  | "missing_branch"
  | "diverged_target"
  | "insufficient_evidence";

export interface HubLegacyLandingTask {
  readonly id: string;
  readonly title: string;
  readonly hubStatus: HubTaskStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface HubLegacyLandingEvidence {
  readonly taskId: string;
  readonly decision: HubLegacyLandingDecision;
  readonly accepted: boolean;
  readonly hadMergeSucceededEvent: boolean;
  readonly message: string;
  readonly nextAction: string;
  readonly branch?: string;
  readonly sourceOid?: string;
  readonly targetOid?: string;
  readonly transactionId?: string;
  readonly integrityIncident?: string;
}

export interface ClassifyHubLegacyLandingHistoryInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly tasks: readonly HubLegacyLandingTask[];
  readonly events?: readonly HubTaskEvent[];
  readonly policy?: HubLandingPolicy;
  readonly existingTaskIds?: ReadonlySet<string>;
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});

const tryGitText = (
  cwd: string,
  args: readonly string[],
): string | undefined => {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    }).trim();
  } catch {
    return undefined;
  }
};

const gitOk = (cwd: string, args: readonly string[]): boolean =>
  tryGitText(cwd, args) !== undefined;

const isAncestor = (
  repoRoot: string,
  ancestorOid: string,
  descendantOid: string,
): boolean =>
  gitOk(repoRoot, ["merge-base", "--is-ancestor", ancestorOid, descendantOid]);

const LEGACY_MERGE_EVENT_TYPES = new Set(["merge_succeeded", "merge_started"]);
const ADOPTED_OPENING_CHECKPOINTS = [
  "opened",
  "base_pinned",
  "candidate_created",
] as const;

type HubLegacyLandingRejection = Exclude<
  HubLegacyLandingDecision,
  "grandfathered_closed" | "ancestry_contained"
>;

const collectLegacyMergeEvidence = (
  events: readonly HubTaskEvent[],
  taskId: string,
): {
  readonly latest: HubTaskEvent | undefined;
  readonly mergeSucceeded: boolean;
} => {
  let latest: HubTaskEvent | undefined;
  let mergeSucceeded = false;
  for (const event of events) {
    if (event.taskId !== taskId) {
      continue;
    }
    if (event.type === "merge_succeeded") {
      mergeSucceeded = true;
    }
    if (!LEGACY_MERGE_EVENT_TYPES.has(event.type)) {
      continue;
    }
    if (
      latest === undefined ||
      event.createdAt > latest.createdAt ||
      (event.createdAt === latest.createdAt && event.type === "merge_succeeded")
    ) {
      latest = event;
    }
  }
  return { latest, mergeSucceeded };
};

const resolveCommitOid = (
  repoRoot: string,
  rev: string,
): string | undefined =>
  tryGitText(repoRoot, ["rev-parse", `${rev}^{commit}`]);

const resolveTargetOids = (
  repoRoot: string,
  policy: HubLandingPolicy | undefined,
): readonly string[] => {
  const oids: string[] = [];
  if (policy) {
    const hostOid = resolveCommitOid(repoRoot, policy.hostTargetBranch);
    const publishOid = resolveCommitOid(repoRoot, policy.publishTargetRef);
    if (hostOid) {
      oids.push(hostOid);
    }
    if (publishOid && publishOid !== hostOid) {
      oids.push(publishOid);
    }
  }
  if (oids.length === 0) {
    const headOid = tryGitText(repoRoot, ["rev-parse", "HEAD"]);
    if (headOid) {
      oids.push(headOid);
    }
  }
  return oids;
};

type HubLegacyLandingEvidenceDraft = Omit<
  HubLegacyLandingEvidence,
  "nextAction"
> & {
  readonly nextAction?: string;
};

const evidence = (
  partial: HubLegacyLandingEvidenceDraft,
): HubLegacyLandingEvidence => ({
  ...partial,
  nextAction: partial.nextAction ?? inspectAction,
  message: `${partial.message} ${NO_RECOVER_SUFFIX}`,
});

const acceptLegacy = (
  input: Omit<HubLegacyLandingEvidenceDraft, "accepted" | "integrityIncident">,
): HubLegacyLandingEvidence =>
  evidence({
    ...input,
    accepted: true,
  });

const rejectLegacy = (
  input: Omit<HubLegacyLandingEvidenceDraft, "accepted" | "integrityIncident"> & {
    readonly decision: HubLegacyLandingRejection;
  },
): HubLegacyLandingEvidence =>
  evidence({
    ...input,
    accepted: false,
    integrityIncident: `${HUB_LEGACY_LANDING_INTEGRITY}: ${input.decision}`,
  });

const classifyTask = (input: {
  readonly repoRoot: string;
  readonly task: HubLegacyLandingTask;
  readonly events: readonly HubTaskEvent[];
  readonly targetOids: readonly string[];
}): HubLegacyLandingEvidence | undefined => {
  const { repoRoot, task, events, targetOids } = input;
  const { latest: mergeEvent, mergeSucceeded } = collectLegacyMergeEvidence(
    events,
    task.id,
  );
  const closed =
    isCompletedHubStatus(task.hubStatus) || task.metadata.done === true;

  if (closed) {
    if (!mergeSucceeded) {
      return undefined;
    }
    return acceptLegacy({
      taskId: task.id,
      decision: "grandfathered_closed",
      hadMergeSucceededEvent: mergeSucceeded,
      message: `Accepted historical evidence for ${task.id}: already closed Beads status. Grandfathered as completed; no landing receipt required.`,
    });
  }

  if (mergeEvent === undefined) {
    return undefined;
  }

  const branch =
    mergeEvent.branch || resolveHubTaskBranch(task.id, task.title);
  const sourceOid = resolveCommitOid(repoRoot, branch);
  const targetOid = targetOids[0];

  if (sourceOid === undefined) {
    return rejectLegacy({
      taskId: task.id,
      decision: "missing_branch",
      hadMergeSucceededEvent: mergeSucceeded,
      branch,
      targetOid,
      message: `Rejected historical evidence for ${task.id}: task branch ${branch} is missing. Ambiguous in-flight work is not closed or reimplemented.`,
    });
  }

  if (targetOid === undefined) {
    return rejectLegacy({
      taskId: task.id,
      decision: "insufficient_evidence",
      hadMergeSucceededEvent: mergeSucceeded,
      branch,
      sourceOid,
      message: `Rejected historical evidence for ${task.id}: configured target is unavailable. Ambiguous in-flight work is not closed or reimplemented.`,
    });
  }

  const containedIn = targetOids.find((oid) =>
    isAncestor(repoRoot, sourceOid, oid),
  );
  if (containedIn) {
    return acceptLegacy({
      taskId: task.id,
      decision: "ancestry_contained",
      hadMergeSucceededEvent: mergeSucceeded,
      branch,
      sourceOid,
      targetOid: containedIn,
      message: `Accepted historical evidence for ${task.id}: source ${sourceOid} is contained in the configured target. A mutating run will adopt this into a landing transaction without redoing preserved work.`,
    });
  }

  if (!isAncestor(repoRoot, targetOid, sourceOid)) {
    return rejectLegacy({
      taskId: task.id,
      decision: "diverged_target",
      hadMergeSucceededEvent: mergeSucceeded,
      branch,
      sourceOid,
      targetOid,
      message: `Rejected historical evidence for ${task.id}: task branch and configured target have diverged. Ambiguous in-flight work is not closed or reimplemented.`,
    });
  }

  return rejectLegacy({
    taskId: task.id,
    decision: "event_without_ancestry",
    hadMergeSucceededEvent: mergeSucceeded,
    branch,
    sourceOid,
    targetOid,
    message: `Rejected historical evidence for ${task.id}: a historical merge_succeeded event is not landing proof. The task is not landed, closed, or shipped.`,
  });
};

export const classifyHubLegacyLandingHistory = (
  input: ClassifyHubLegacyLandingHistoryInput,
): readonly HubLegacyLandingEvidence[] => {
  const events = input.events ?? readTaskEvents(input.hubProjectDir);
  const policy = input.policy ?? readHubLandingPolicy(input.hubProjectDir);
  const targetOids = resolveTargetOids(input.repoRoot, policy);
  const existingTaskIds = input.existingTaskIds ?? new Set<string>();
  return input.tasks.flatMap((task) => {
    if (existingTaskIds.has(task.id)) {
      return [];
    }
    const classified = classifyTask({
      repoRoot: input.repoRoot,
      task,
      events,
      targetOids,
    });
    return classified ? [classified] : [];
  });
};

export const hasHubLegacyLandingHistory = (
  history: readonly HubLegacyLandingEvidence[] | undefined,
): history is readonly HubLegacyLandingEvidence[] =>
  history !== undefined && history.length > 0;

export const formatHubLegacyLandingHistoryLines = (
  history: readonly HubLegacyLandingEvidence[] | undefined,
): readonly string[] =>
  (history ?? []).flatMap((entry) => {
    if (entry.integrityIncident) {
      return [entry.message, `Next action: ${entry.nextAction}`];
    }
    return [entry.message];
  });

export const isHubLegacyLandingIntegrity = (
  entry: HubLegacyLandingEvidence | undefined,
): entry is HubLegacyLandingEvidence & { readonly integrityIncident: string } =>
  entry?.integrityIncident !== undefined;

const writeAtomicJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const fd = openSync(tempPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, path);
};

const persistAdoptedCandidate = (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly transactionId: string;
  readonly taskId: string;
  readonly sourceOid: string;
  readonly baseOid: string;
  readonly createdAt: string;
}): void => {
  const candidateRef = resolveHubLandingCandidateRef(input.transactionId);
  writeAtomicJson(
    resolveHubLandingCandidateManifestPath(
      input.hubProjectDir,
      input.transactionId,
    ),
    {
      transactionId: input.transactionId,
      taskId: input.taskId,
      sourceOid: input.sourceOid,
      baseOid: input.baseOid,
      candidateOid: input.sourceOid,
      candidateRef,
      createdAt: input.createdAt,
    },
  );
  execFileSync("git", ["update-ref", candidateRef, input.sourceOid], {
    cwd: input.repoRoot,
    env: gitEnv(),
  });
};

const adoptedCheckpointFields = (input: {
  readonly transactionId: string;
  readonly taskId: string;
  readonly createdAt: string;
  readonly sourceOid: string;
  readonly targetOid: string;
}) => ({
  type: "checkpoint" as const,
  transactionId: input.transactionId,
  taskId: input.taskId,
  createdAt: input.createdAt,
  sourceOid: input.sourceOid,
  baseOid: input.targetOid,
  candidateOid: input.sourceOid,
  candidateRef: resolveHubLandingCandidateRef(input.transactionId),
});

const adoptContainedTask = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly task: HubLegacyLandingTask;
  readonly classified: HubLegacyLandingEvidence;
  readonly now: Date;
  readonly readTaskClose?: HubLandingTaskCloseReader;
  readonly closeTask?: HubLandingTaskCloser;
  readonly faultInjection?: HubLandingFaultInjection;
}): Promise<HubLegacyLandingEvidence> => {
  const sourceOid = input.classified.sourceOid;
  const targetOid = input.classified.targetOid;
  const branch = input.classified.branch;
  if (!sourceOid || !targetOid || !branch) {
    return input.classified;
  }
  const transactionId = resolveHubLandingTransactionId({
    taskId: input.task.id,
    sourceOid,
    baseOid: targetOid,
  });
  const createdAt = input.now.toISOString();
  const checkpointFields = adoptedCheckpointFields({
    transactionId,
    taskId: input.task.id,
    createdAt,
    sourceOid,
    targetOid,
  });
  const existing = loadHubLandingTransaction(
    input.hubProjectDir,
    transactionId,
  );
  if (!existing) {
    for (const checkpoint of ADOPTED_OPENING_CHECKPOINTS) {
      appendHubLandingCheckpoint(input.hubProjectDir, {
        ...checkpointFields,
        checkpoint,
      });
    }
    persistAdoptedCandidate({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      transactionId,
      taskId: input.task.id,
      sourceOid,
      baseOid: targetOid,
      createdAt,
    });
  }

  const verifierFingerprint = computeHubVerifierFingerprint(input.repoRoot);
  bindHubLandingVerification({
    hubProjectDir: input.hubProjectDir,
    transactionId,
    taskId: input.task.id,
    candidateOid: sourceOid,
    verifierFingerprint,
    repoRoot: input.repoRoot,
    now: input.now,
    faultInjection: input.faultInjection,
  });
  appendHubLandingCheckpoint(input.hubProjectDir, {
    ...checkpointFields,
    checkpoint: "target_landed",
    verifierFingerprint,
    publishTargetOid: targetOid,
  });
  await closeHubLandingTask({
    hubProjectDir: input.hubProjectDir,
    transactionId,
    taskId: input.task.id,
    candidateOid: sourceOid,
    repoRoot: input.repoRoot,
    readTaskClose: input.readTaskClose,
    closeTask: input.closeTask,
    now: input.now,
    faultInjection: input.faultInjection,
  });

  return acceptLegacy({
    taskId: input.task.id,
    decision: "ancestry_contained",
    hadMergeSucceededEvent: input.classified.hadMergeSucceededEvent,
    branch,
    sourceOid,
    targetOid,
    transactionId,
    message: `Accepted historical evidence for ${input.task.id}: source ${sourceOid} is contained in the configured target and was adopted into landing transaction ${transactionId}.`,
  });
};

export const adoptHubLegacyLandingHistory = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly tasks: readonly HubLegacyLandingTask[];
  readonly events?: readonly HubTaskEvent[];
  readonly policy?: HubLandingPolicy;
  readonly existingTaskIds?: ReadonlySet<string>;
  readonly now?: Date;
  readonly readTaskClose?: HubLandingTaskCloseReader;
  readonly closeTask?: HubLandingTaskCloser;
  readonly faultInjection?: HubLandingFaultInjection;
}): Promise<readonly HubLegacyLandingEvidence[]> => {
  const classified = classifyHubLegacyLandingHistory(input);
  const now = input.now ?? new Date();
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const adopted: HubLegacyLandingEvidence[] = [];
  for (const entry of classified) {
    if (entry.decision !== "ancestry_contained") {
      adopted.push(entry);
      continue;
    }
    const task = tasksById.get(entry.taskId);
    if (!task) {
      adopted.push(entry);
      continue;
    }
    adopted.push(
      await adoptContainedTask({
        repoRoot: input.repoRoot,
        hubProjectDir: input.hubProjectDir,
        task,
        classified: entry,
        now,
        readTaskClose: input.readTaskClose,
        closeTask: input.closeTask,
        faultInjection: input.faultInjection,
      }),
    );
  }
  return adopted;
};
