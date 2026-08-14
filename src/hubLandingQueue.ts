import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  bindHubLandingVerification,
  commitHubLandingTarget,
  computeHubVerifierFingerprint,
  createHubLandingCandidate,
  invalidateHubLandingCandidate,
  type HubLandingCandidate,
  type HubLandingCommitResult,
  type HubLandingFaultInjection,
} from "./hubLanding.js";
import type {
  HubLandingPolicy,
  HubLandingPublishPolicy,
} from "./hubLandingPolicy.js";
import { readHubLandingPolicy } from "./hubLandingPolicy.js";
import { isGitOid } from "./hubLandingTransaction.js";

const execFileAsync = promisify(execFile);

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
});

export const HUB_LANDING_TARGET_DRIFT_REBUILD_LIMIT = 3 as const;
export const HUB_LANDING_SPECULATIVE_CHAIN_LIMIT = 8 as const;
export const HUB_TARGET_QUIET_WAIT = "target_quiet_wait";
export const HUB_HOST_CONTRIBUTION_TASK_ID = "hub-host-contribution";

const NO_RECOVER_SUFFIX =
  "This is not a task failure and does not require a recovery command.";

const gitText = async (
  cwd: string,
  args: readonly string[],
): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
  });
  return String(stdout).trim();
};

const gitOk = async (
  cwd: string,
  args: readonly string[],
): Promise<boolean> => {
  try {
    await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
    });
    return true;
  } catch {
    return false;
  }
};

const fsyncPath = (path: string): void => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const writeAtomicJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsyncPath(tempPath);
  renameSync(tempPath, path);
};

const parseJsonRecord = (raw: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const numberField = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const stringArrayField = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return items.length > 0 ? items : undefined;
};

export type HubHostTargetRelation =
  | "equal"
  | "behind"
  | "descendant"
  | "diverged";

export type HubLandingTicketStatus =
  | "queued"
  | "speculating"
  | "verified"
  | "landed"
  | "publishing"
  | "invalidated"
  | "blocked_unshipped_prerequisite"
  | "failed"
  | "target_quiet_wait";

export interface HubLandingQueueTicket {
  readonly ticketId: string;
  readonly sequence: number;
  readonly taskId: string;
  readonly assignedAt: string;
  readonly status: HubLandingTicketStatus;
  readonly blockerTaskIds: readonly string[];
  readonly sourceOid?: string;
  readonly predecessorOid?: string;
  readonly candidateOid?: string;
  readonly transactionId?: string;
  readonly activationId?: string;
  readonly activationDriftRebuilds: number;
  readonly lastObservedTargetOid?: string;
  readonly quietWaitEnteredAt?: string;
  readonly suffixInvalidatedAt?: string;
  readonly suffixInvalidationReason?: string;
}

export interface HubLandingQueueState {
  readonly version: 1;
  readonly publishTargetRef: string;
  readonly nextSequence: number;
  readonly tickets: readonly HubLandingQueueTicket[];
}

export interface HubLandingQueueClock {
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface HubLandingQueueTaskInput {
  readonly taskId: string;
  readonly blockerTaskIds?: readonly string[];
  readonly sourceOid?: string;
}

export interface HubLandingQueueInspection {
  readonly tickets: readonly HubLandingQueueTicket[];
  readonly pendingQuietWaitCount: number;
  readonly fifoHeadTaskId?: string;
  readonly fifoHeadPosition?: number;
  readonly message: string;
  readonly nextAction: string;
}

export interface HubHostDirtySnapshot {
  readonly porcelain: string;
  readonly contents: Readonly<Record<string, string | null>>;
}

export interface HubHostTargetClassification {
  readonly relation: HubHostTargetRelation;
  readonly hostOid: string;
  readonly targetOid: string;
}

export interface HubHostContributionResult {
  readonly relation: HubHostTargetRelation;
  readonly hostOid: string;
  readonly targetOid: string;
  readonly imported: boolean;
  readonly hostDirtyUnchanged: boolean;
  readonly beforeDirty: HubHostDirtySnapshot;
  readonly afterDirty: HubHostDirtySnapshot;
  readonly candidate?: HubLandingCandidate;
  readonly commit?: HubLandingCommitResult;
  readonly message: string;
  readonly pending?: boolean;
}

const HUB_LANDING_TICKET_STATUSES = [
  "queued",
  "speculating",
  "verified",
  "landed",
  "publishing",
  "invalidated",
  "blocked_unshipped_prerequisite",
  "failed",
  "target_quiet_wait",
] as const satisfies readonly HubLandingTicketStatus[];

const ELIGIBLE_STATUSES = new Set<HubLandingTicketStatus>([
  "queued",
  "speculating",
  "verified",
  "invalidated",
  "target_quiet_wait",
]);

const TERMINAL_STATUSES = new Set<HubLandingTicketStatus>([
  "landed",
  "failed",
]);

const isHubLandingTicketStatus = (
  value: string,
): value is HubLandingTicketStatus =>
  (HUB_LANDING_TICKET_STATUSES as readonly string[]).includes(value);

export const resolveHubLandingQueuePath = (hubProjectDir: string): string =>
  join(hubProjectDir, "landing", "queue.json");

const nowIso = (clock?: HubLandingQueueClock): string =>
  (clock?.now ?? (() => new Date()))().toISOString();

const safeTaskId = (taskId: string): string =>
  taskId.replace(/[^A-Za-z0-9._-]+/g, "-");

const parseTicket = (value: unknown): HubLandingQueueTicket | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ticketId = stringField(record.ticketId);
  const sequence = numberField(record.sequence);
  const taskId = stringField(record.taskId);
  const assignedAt = stringField(record.assignedAt);
  const statusField = stringField(record.status);
  if (
    !ticketId ||
    sequence === undefined ||
    !taskId ||
    !assignedAt ||
    !statusField ||
    !isHubLandingTicketStatus(statusField)
  ) {
    return undefined;
  }
  return {
    ticketId,
    sequence,
    taskId,
    assignedAt,
    status: statusField,
    blockerTaskIds: stringArrayField(record.blockerTaskIds) ?? [],
    sourceOid: stringField(record.sourceOid),
    predecessorOid: stringField(record.predecessorOid),
    candidateOid: stringField(record.candidateOid),
    transactionId: stringField(record.transactionId),
    activationId: stringField(record.activationId),
    activationDriftRebuilds: numberField(record.activationDriftRebuilds) ?? 0,
    lastObservedTargetOid: stringField(record.lastObservedTargetOid),
    quietWaitEnteredAt: stringField(record.quietWaitEnteredAt),
    suffixInvalidatedAt: stringField(record.suffixInvalidatedAt),
    suffixInvalidationReason: stringField(record.suffixInvalidationReason),
  };
};

const parseQueue = (value: unknown): HubLandingQueueState | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return undefined;
  }
  const publishTargetRef = stringField(record.publishTargetRef);
  const nextSequence = numberField(record.nextSequence);
  if (!publishTargetRef || nextSequence === undefined) {
    return undefined;
  }
  const tickets = Array.isArray(record.tickets)
    ? record.tickets.flatMap((entry) => {
        const ticket = parseTicket(entry);
        return ticket ? [ticket] : [];
      })
    : [];
  return { version: 1, publishTargetRef, nextSequence, tickets };
};

export const readHubLandingQueue = (
  hubProjectDir: string,
): HubLandingQueueState | undefined => {
  const path = resolveHubLandingQueuePath(hubProjectDir);
  if (!existsSync(path)) {
    return undefined;
  }
  return parseQueue(parseJsonRecord(readFileSync(path, "utf8")));
};

export const findHubLandingQueueTicket = (
  hubProjectDir: string,
  taskId: string,
): HubLandingQueueTicket | undefined =>
  readHubLandingQueue(hubProjectDir)?.tickets.find(
    (ticket) => ticket.taskId === taskId,
  );

const writeQueue = (
  hubProjectDir: string,
  queue: HubLandingQueueState,
): HubLandingQueueState => {
  writeAtomicJson(resolveHubLandingQueuePath(hubProjectDir), queue);
  return queue;
};

const emptyQueue = (publishTargetRef: string): HubLandingQueueState => ({
  version: 1,
  publishTargetRef,
  nextSequence: 1,
  tickets: [],
});

const replaceTicket = (
  queue: HubLandingQueueState,
  ticket: HubLandingQueueTicket,
): HubLandingQueueState => ({
  ...queue,
  tickets: queue.tickets.map((entry) =>
    entry.ticketId === ticket.ticketId ? ticket : entry,
  ),
});

const refreshInvalidatedTicketStatus = (
  status: HubLandingTicketStatus,
): HubLandingTicketStatus =>
  status === "invalidated" ? "queued" : status;

export const assignHubLandingQueueTickets = (input: {
  readonly hubProjectDir: string;
  readonly publishTargetRef: string;
  readonly tasks: readonly HubLandingQueueTaskInput[];
  readonly clock?: HubLandingQueueClock;
}): HubLandingQueueState => {
  const existing =
    readHubLandingQueue(input.hubProjectDir) ??
    emptyQueue(input.publishTargetRef);
  const assignedAt = nowIso(input.clock);
  const byTaskId = new Map(
    existing.tickets.map((ticket) => [ticket.taskId, ticket]),
  );
  let nextSequence = existing.nextSequence;
  const tickets = [...existing.tickets];
  for (const task of input.tasks) {
    const current = byTaskId.get(task.taskId);
    if (current) {
      const updated: HubLandingQueueTicket = {
        ...current,
        blockerTaskIds: task.blockerTaskIds ?? current.blockerTaskIds,
        sourceOid: task.sourceOid ?? current.sourceOid,
        status: refreshInvalidatedTicketStatus(current.status),
      };
      const index = tickets.findIndex(
        (ticket) => ticket.ticketId === current.ticketId,
      );
      if (index >= 0) {
        tickets[index] = updated;
      }
      continue;
    }
    const sequence = nextSequence;
    nextSequence += 1;
    const ticket: HubLandingQueueTicket = {
      ticketId: `lqt-${safeTaskId(task.taskId)}-${sequence}`,
      sequence,
      taskId: task.taskId,
      assignedAt,
      status: "queued",
      blockerTaskIds: task.blockerTaskIds ?? [],
      sourceOid: task.sourceOid,
      activationDriftRebuilds: 0,
    };
    tickets.push(ticket);
    byTaskId.set(task.taskId, ticket);
  }
  return writeQueue(input.hubProjectDir, {
    version: 1,
    publishTargetRef: input.publishTargetRef,
    nextSequence,
    tickets,
  });
};

const blockersShipped = (
  ticket: HubLandingQueueTicket,
  shippedTaskIds: ReadonlySet<string>,
): boolean => ticket.blockerTaskIds.every((id) => shippedTaskIds.has(id));

export const resolveHubLandingQueueHead = (
  queue: HubLandingQueueState | undefined,
  shippedTaskIds: ReadonlySet<string> = new Set(),
): HubLandingQueueTicket | undefined =>
  queue?.tickets
    .filter(
      (ticket) =>
        ELIGIBLE_STATUSES.has(ticket.status) &&
        blockersShipped(ticket, shippedTaskIds),
    )
    .sort((left, right) => left.sequence - right.sequence)[0];

/** Earliest earlier ticket still holding ordered required delivery. */
const findEarlierRequiredDeliveryHold = (
  queue: HubLandingQueueState | undefined,
  taskId: string,
): HubLandingQueueTicket | undefined => {
  if (!queue) {
    return undefined;
  }
  const mine = queue.tickets.find((ticket) => ticket.taskId === taskId);
  if (!mine) {
    return undefined;
  }
  return queue.tickets
    .filter(
      (ticket) =>
        ticket.sequence < mine.sequence && ticket.status === "publishing",
    )
    .sort((left, right) => left.sequence - right.sequence)[0];
};

export const canLandHubLandingTicket = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly shippedTaskIds?: ReadonlySet<string>;
}): boolean => {
  const queue = readHubLandingQueue(input.hubProjectDir);
  if (findEarlierRequiredDeliveryHold(queue, input.taskId)) {
    return false;
  }
  const head = resolveHubLandingQueueHead(
    queue,
    input.shippedTaskIds ?? new Set(),
  );
  return head?.taskId === input.taskId;
};

export const resolveRequiredDeliveryPredecessor = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
}): HubLandingQueueTicket | undefined =>
  findEarlierRequiredDeliveryHold(
    readHubLandingQueue(input.hubProjectDir),
    input.taskId,
  );

export const fifoPositionForTicket = (
  ticket: HubLandingQueueTicket,
): number => ticket.sequence;

const updateTicket = (
  hubProjectDir: string,
  taskId: string,
  patch: Partial<HubLandingQueueTicket>,
): HubLandingQueueTicket | undefined => {
  const queue = readHubLandingQueue(hubProjectDir);
  if (!queue) {
    return undefined;
  }
  const current = queue.tickets.find((ticket) => ticket.taskId === taskId);
  if (!current) {
    return undefined;
  }
  const next = { ...current, ...patch };
  writeQueue(hubProjectDir, replaceTicket(queue, next));
  return next;
};

const quietWaitInspection = (
  tickets: readonly HubLandingQueueTicket[],
  head: HubLandingQueueTicket,
  pendingQuietWaitCount: number,
): HubLandingQueueInspection => ({
  tickets,
  pendingQuietWaitCount,
  fifoHeadTaskId: head.taskId,
  fifoHeadPosition: head.sequence,
  message: `Target quiet wait for ${head.taskId} at FIFO position ${head.sequence}. Later transactions cannot overtake this ticket. ${NO_RECOVER_SUFFIX}`,
  nextAction:
    "Wait for a stable Hub publish target window; Hub will start a new activation automatically without resetting semantic repair budgets.",
});

const activeHeadInspection = (
  tickets: readonly HubLandingQueueTicket[],
  head: HubLandingQueueTicket,
  pendingQuietWaitCount: number,
): HubLandingQueueInspection => {
  const oidParts = [
    head.predecessorOid ? `predecessor ${head.predecessorOid}` : undefined,
    head.candidateOid ? `candidate ${head.candidateOid}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const oidSuffix = oidParts.length > 0 ? `; ${oidParts.join("; ")}` : "";
  return {
    tickets,
    pendingQuietWaitCount,
    fifoHeadTaskId: head.taskId,
    fifoHeadPosition: head.sequence,
    message: `Landing queue head ${head.taskId} at FIFO position ${head.sequence}${oidSuffix}.`,
    nextAction: "Hub will land the queue head with fenced CAS when verified.",
  };
};

export const recordHubLandingQueueCandidate = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly sourceOid: string;
  readonly predecessorOid: string;
  readonly candidateOid: string;
  readonly transactionId: string;
}): HubLandingQueueTicket | undefined =>
  updateTicket(input.hubProjectDir, input.taskId, {
    status: "speculating",
    sourceOid: input.sourceOid,
    predecessorOid: input.predecessorOid,
    candidateOid: input.candidateOid,
    transactionId: input.transactionId,
  });

export const markHubLandingQueueVerified = (
  hubProjectDir: string,
  taskId: string,
): HubLandingQueueTicket | undefined =>
  updateTicket(hubProjectDir, taskId, { status: "verified" });

export const markHubLandingQueueLanded = (
  hubProjectDir: string,
  taskId: string,
): HubLandingQueueTicket | undefined =>
  updateTicket(hubProjectDir, taskId, {
    status: "landed",
    activationDriftRebuilds: 0,
    quietWaitEnteredAt: undefined,
  });

export const markHubLandingQueuePublishing = (
  hubProjectDir: string,
  taskId: string,
): HubLandingQueueTicket | undefined =>
  updateTicket(hubProjectDir, taskId, {
    status: "publishing",
    activationDriftRebuilds: 0,
    quietWaitEnteredAt: undefined,
  });

/** After local land: required stays `publishing`; otherwise advances to `landed`. */
export const markHubLandingQueueAfterLocalLand = (
  hubProjectDir: string,
  taskId: string,
  publishPolicy: HubLandingPublishPolicy,
): HubLandingQueueTicket | undefined =>
  publishPolicy === "required"
    ? markHubLandingQueuePublishing(hubProjectDir, taskId)
    : markHubLandingQueueLanded(hubProjectDir, taskId);

export const markHubLandingQueueFailed = (
  hubProjectDir: string,
  taskId: string,
): HubLandingQueueTicket | undefined =>
  updateTicket(hubProjectDir, taskId, { status: "failed" });

export const markHubLandingQueueBlockedPrerequisite = (
  hubProjectDir: string,
  taskId: string,
): HubLandingQueueTicket | undefined =>
  updateTicket(hubProjectDir, taskId, {
    status: "blocked_unshipped_prerequisite",
  });

export const invalidateHubLandingSpeculativeSuffix = (input: {
  readonly hubProjectDir: string;
  readonly fromTaskId: string;
  readonly reason: string;
  readonly clock?: HubLandingQueueClock;
}): readonly HubLandingQueueTicket[] => {
  const queue = readHubLandingQueue(input.hubProjectDir);
  if (!queue) {
    return [];
  }
  const origin = queue.tickets.find(
    (ticket) => ticket.taskId === input.fromTaskId,
  );
  if (!origin) {
    return [];
  }
  const invalidatedAt = nowIso(input.clock);
  const invalidated: HubLandingQueueTicket[] = [];
  const tickets = queue.tickets.map((ticket) => {
    if (
      ticket.sequence <= origin.sequence ||
      TERMINAL_STATUSES.has(ticket.status) ||
      ticket.status === "blocked_unshipped_prerequisite"
    ) {
      return ticket;
    }
    if (ticket.transactionId) {
      invalidateHubLandingCandidate({
        hubProjectDir: input.hubProjectDir,
        transactionId: ticket.transactionId,
      });
    }
    const next: HubLandingQueueTicket = {
      ...ticket,
      status: "invalidated",
      candidateOid: undefined,
      predecessorOid: undefined,
      transactionId: undefined,
      suffixInvalidatedAt: invalidatedAt,
      suffixInvalidationReason: input.reason,
    };
    invalidated.push(next);
    return next;
  });
  writeQueue(input.hubProjectDir, { ...queue, tickets });
  return invalidated;
};

export const inspectHubLandingQueue = (
  hubProjectDir: string,
  shippedTaskIds: ReadonlySet<string> = new Set(),
): HubLandingQueueInspection => {
  const queue = readHubLandingQueue(hubProjectDir);
  const tickets = queue?.tickets ?? [];
  const head = resolveHubLandingQueueHead(queue, shippedTaskIds);
  const pendingQuietWaitCount = tickets.filter(
    (ticket) => ticket.status === "target_quiet_wait",
  ).length;
  if (!head) {
    return {
      tickets,
      pendingQuietWaitCount,
      message: "",
      nextAction: "",
    };
  }
  if (head.status === "target_quiet_wait") {
    return quietWaitInspection(tickets, head, pendingQuietWaitCount);
  }
  return activeHeadInspection(tickets, head, pendingQuietWaitCount);
};

export const computeHubLandingDriftBackoffMs = (
  rebuildIndex: number,
  random: () => number = Math.random,
): number => {
  const base = 25 * 2 ** Math.min(Math.max(rebuildIndex, 0), 4);
  const jitter = 0.75 + random() * 0.5;
  return Math.round(base * jitter);
};

export const waitHubLandingDriftBackoff = async (
  clock: HubLandingQueueClock | undefined,
  rebuildIndex: number,
): Promise<number> => {
  const delay = computeHubLandingDriftBackoffMs(
    rebuildIndex,
    clock?.random ?? Math.random,
  );
  const sleep =
    clock?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  await sleep(delay);
  return delay;
};

export const recordHubLandingDriftRebuild = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly observedTargetOid: string;
  readonly clock?: HubLandingQueueClock;
}): HubLandingQueueTicket | undefined => {
  const current = findHubLandingQueueTicket(
    input.hubProjectDir,
    input.taskId,
  );
  const activationId =
    current?.activationId ?? `act-${input.taskId}-${nowIso(input.clock)}`;
  return updateTicket(input.hubProjectDir, input.taskId, {
    activationId,
    activationDriftRebuilds: (current?.activationDriftRebuilds ?? 0) + 1,
    lastObservedTargetOid: input.observedTargetOid,
    status: "queued",
  });
};

export const shouldEnterHubLandingQuietWait = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
}): boolean => {
  const ticket = findHubLandingQueueTicket(input.hubProjectDir, input.taskId);
  return (
    (ticket?.activationDriftRebuilds ?? 0) >=
    HUB_LANDING_TARGET_DRIFT_REBUILD_LIMIT
  );
};

export const enterHubLandingQuietWait = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly observedTargetOid: string;
  readonly clock?: HubLandingQueueClock;
}): HubLandingQueueTicket | undefined =>
  updateTicket(input.hubProjectDir, input.taskId, {
    status: "target_quiet_wait",
    lastObservedTargetOid: input.observedTargetOid,
    quietWaitEnteredAt: nowIso(input.clock),
  });

export const resumeHubLandingQuietWaitIfStable = (input: {
  readonly hubProjectDir: string;
  readonly taskId: string;
  readonly observedTargetOid: string;
  readonly clock?: HubLandingQueueClock;
}): "resumed" | "waiting" | "not_waiting" => {
  const ticket = findHubLandingQueueTicket(input.hubProjectDir, input.taskId);
  if (!ticket || ticket.status !== "target_quiet_wait") {
    return "not_waiting";
  }
  if (
    ticket.lastObservedTargetOid &&
    ticket.lastObservedTargetOid !== input.observedTargetOid
  ) {
    updateTicket(input.hubProjectDir, input.taskId, {
      lastObservedTargetOid: input.observedTargetOid,
    });
    return "waiting";
  }
  updateTicket(input.hubProjectDir, input.taskId, {
    status: "queued",
    activationId: `act-${input.taskId}-${nowIso(input.clock)}`,
    activationDriftRebuilds: 0,
    quietWaitEnteredAt: undefined,
    lastObservedTargetOid: input.observedTargetOid,
  });
  return "resumed";
};

export const readHubHostDirtySnapshot = async (
  repoRoot: string,
): Promise<HubHostDirtySnapshot> => {
  const porcelain = await gitText(repoRoot, ["status", "--porcelain"]);
  const contents: Record<string, string | null> = {};
  for (const line of porcelain.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const renamed = line.match(/ -> (.+)$/);
    const path = (renamed?.[1] ?? line.slice(3)).trim().replace(/\/$/, "");
    if (!path) {
      continue;
    }
    const absolute = join(repoRoot, path);
    if (!existsSync(absolute)) {
      contents[path] = null;
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      contents[path] = `mode:${stat.mode}`;
      continue;
    }
    contents[path] = readFileSync(absolute, "utf8");
  }
  return { porcelain, contents };
};

export const hubHostDirtySnapshotsEqual = (
  left: HubHostDirtySnapshot,
  right: HubHostDirtySnapshot,
): boolean =>
  left.porcelain === right.porcelain &&
  JSON.stringify(left.contents) === JSON.stringify(right.contents);

export const classifyHubHostTargetRelation = async (input: {
  readonly repoRoot: string;
  readonly policy: HubLandingPolicy;
}): Promise<HubHostTargetClassification> => {
  const hostOid = await gitText(input.repoRoot, [
    "rev-parse",
    `${input.policy.hostTargetBranch}^{commit}`,
  ]);
  const targetOid = await gitText(input.repoRoot, [
    "rev-parse",
    input.policy.publishTargetRef,
  ]);
  if (hostOid === targetOid) {
    return { relation: "equal", hostOid, targetOid };
  }
  const hostIsAncestor = await gitOk(input.repoRoot, [
    "merge-base",
    "--is-ancestor",
    hostOid,
    targetOid,
  ]);
  if (hostIsAncestor) {
    return { relation: "behind", hostOid, targetOid };
  }
  const targetIsAncestor = await gitOk(input.repoRoot, [
    "merge-base",
    "--is-ancestor",
    targetOid,
    hostOid,
  ]);
  if (targetIsAncestor) {
    return { relation: "descendant", hostOid, targetOid };
  }
  return { relation: "diverged", hostOid, targetOid };
};

export type HubHostContributionLand = (
  candidate: HubLandingCandidate,
) => Promise<
  | { readonly kind: "landed"; readonly commit: HubLandingCommitResult }
  | { readonly kind: string; readonly message?: string }
>;

const defaultHostContributionVerify =
  (hubProjectDir: string, repoRoot: string, fingerprint: string) =>
  (next: HubLandingCandidate): void => {
    bindHubLandingVerification({
      hubProjectDir,
      transactionId: next.transactionId,
      taskId: next.taskId,
      candidateOid: next.candidateOid,
      verifierFingerprint: fingerprint,
      repoRoot,
    });
  };

const defaultHostContributionLand =
  (
    repoRoot: string,
    hubProjectDir: string,
    fingerprint: string,
    now: Date | undefined,
    faultInjection: HubLandingFaultInjection | undefined,
  ): HubHostContributionLand =>
  async (next) => {
    const commit = await commitHubLandingTarget({
      repoRoot,
      hubProjectDir,
      candidate: next,
      verifierFingerprint: fingerprint,
      now,
      faultInjection,
    });
    return { kind: "landed" as const, commit };
  };

const isLandedHostContribution = (
  landed: Awaited<ReturnType<HubHostContributionLand>>,
): landed is {
  readonly kind: "landed";
  readonly commit: HubLandingCommitResult;
} => landed.kind === "landed" && "commit" in landed && Boolean(landed.commit);

export const reconcileHubHostTargetContribution = async (input: {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly policy?: HubLandingPolicy;
  readonly now?: Date;
  readonly clock?: HubLandingQueueClock;
  readonly faultInjection?: HubLandingFaultInjection;
  readonly verify?: (candidate: HubLandingCandidate) => Promise<void> | void;
  readonly land?: HubHostContributionLand;
}): Promise<HubHostContributionResult | undefined> => {
  const policy =
    input.policy ?? readHubLandingPolicy(input.hubProjectDir);
  if (!policy) {
    return undefined;
  }
  const beforeDirty = await readHubHostDirtySnapshot(input.repoRoot);
  const classified = await classifyHubHostTargetRelation({
    repoRoot: input.repoRoot,
    policy,
  });
  const finish = async (
    result: Omit<
      HubHostContributionResult,
      "beforeDirty" | "afterDirty" | "hostDirtyUnchanged" | "hostOid" | "targetOid"
    > &
      Partial<Pick<HubHostContributionResult, "hostOid" | "targetOid">>,
  ): Promise<HubHostContributionResult> => {
    const afterDirty = await readHubHostDirtySnapshot(input.repoRoot);
    return {
      hostOid: classified.hostOid,
      targetOid: classified.targetOid,
      beforeDirty,
      afterDirty,
      hostDirtyUnchanged: hubHostDirtySnapshotsEqual(beforeDirty, afterDirty),
      ...result,
    };
  };

  if (classified.relation === "equal" || classified.relation === "behind") {
    return finish({
      relation: classified.relation,
      imported: false,
      message: `Host target ${policy.hostTargetBranch} is ${classified.relation} the Hub publish target; no committed host contribution to import.`,
    });
  }

  try {
    const candidate = await createHubLandingCandidate({
      repoRoot: input.repoRoot,
      hubProjectDir: input.hubProjectDir,
      taskId: HUB_HOST_CONTRIBUTION_TASK_ID,
      branch: policy.hostTargetBranch,
      baseOid: classified.targetOid,
      now: input.now,
      faultInjection: input.faultInjection,
    });
    const fingerprint = computeHubVerifierFingerprint(input.repoRoot);
    const verify =
      input.verify ??
      defaultHostContributionVerify(
        input.hubProjectDir,
        input.repoRoot,
        fingerprint,
      );
    await verify(candidate);
    const land =
      input.land ??
      defaultHostContributionLand(
        input.repoRoot,
        input.hubProjectDir,
        fingerprint,
        input.now,
        input.faultInjection,
      );
    const landed = await land(candidate);
    if (!isLandedHostContribution(landed)) {
      return finish({
        relation: classified.relation,
        imported: false,
        candidate,
        pending: true,
        message: `Host contribution for ${policy.hostTargetBranch} is pending (${landed.kind}). Task candidates wait until committed host work is in the canonical chain. ${NO_RECOVER_SUFFIX}`,
      });
    }
    return finish({
      relation: classified.relation,
      imported: true,
      candidate,
      commit: landed.commit,
      message: `Imported committed host-target ${classified.relation} tip ${classified.hostOid} into the Hub publish target as ${landed.commit.candidateOid}.`,
    });
  } catch (error) {
    return finish({
      relation: classified.relation,
      imported: false,
      pending: true,
      message: `Host contribution for ${policy.hostTargetBranch} could not be merged into the canonical chain: ${
        error instanceof Error ? error.message : String(error)
      }. Uncommitted host state was not imported. ${NO_RECOVER_SUFFIX}`,
    });
  }
};

export const ensureHubLandingQueueTicket = (input: {
  readonly hubProjectDir: string;
  readonly publishTargetRef: string;
  readonly taskId: string;
  readonly sourceOid?: string;
  readonly blockerTaskIds?: readonly string[];
  readonly clock?: HubLandingQueueClock;
}): HubLandingQueueTicket => {
  const queue = assignHubLandingQueueTickets({
    hubProjectDir: input.hubProjectDir,
    publishTargetRef: input.publishTargetRef,
    tasks: [
      {
        taskId: input.taskId,
        sourceOid: input.sourceOid,
        blockerTaskIds: input.blockerTaskIds,
      },
    ],
    clock: input.clock,
  });
  return queue.tickets.find((ticket) => ticket.taskId === input.taskId)!;
};

export const selectHubSpeculativeChain = (
  queue: HubLandingQueueState | undefined,
  shippedTaskIds: ReadonlySet<string>,
  limit: number = HUB_LANDING_SPECULATIVE_CHAIN_LIMIT,
): readonly HubLandingQueueTicket[] => {
  if (!queue) {
    return [];
  }
  return queue.tickets
    .filter(
      (ticket) =>
        !TERMINAL_STATUSES.has(ticket.status) &&
        ticket.status !== "blocked_unshipped_prerequisite" &&
        ticket.status !== "publishing" &&
        blockersShipped(ticket, shippedTaskIds),
    )
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, limit);
};

export const verifyHubSpeculativeCandidatesConcurrently = async <T>(
  candidates: readonly T[],
  verify: (candidate: T, index: number) => Promise<void> | void,
): Promise<{ readonly verificationConcurrency: number }> => {
  let current = 0;
  let max = 0;
  await Promise.all(
    candidates.map(async (candidate, index) => {
      current += 1;
      max = Math.max(max, current);
      try {
        await verify(candidate, index);
      } finally {
        current -= 1;
      }
    }),
  );
  return { verificationConcurrency: max };
};

export const isGitOidValue = isGitOid;
