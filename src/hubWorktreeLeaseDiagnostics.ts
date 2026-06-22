import {
  branchToWorktreeName,
  type WorktreeLeaseOwner,
  type WorktreeLeaseRecord,
} from "./worktreeLease.js";
import {
  resolveHubTaskBranch,
  type HubTaskProjection,
} from "./taskBoard.js";

export type HubWorktreeLeaseDiagnosticReason =
  | "worktree_lease_active_execution"
  | "worktree_lease_missing"
  | "worktree_lease_active_with_failed_claim"
  | "worktree_lease_stale_with_failed_claim"
  | "worktree_lease_active_without_claim";

export interface HubWorktreeLeaseDiagnostic {
  readonly taskId: string;
  readonly title: string;
  readonly reason: HubWorktreeLeaseDiagnosticReason;
  readonly message: string;
  readonly nextAction: string;
  readonly branch: string;
  readonly worktreeName: string;
  readonly leaseState: "active" | "stale" | "missing";
  readonly claimState: "active" | "stale" | "missing";
  readonly pid?: number;
  readonly owner?: WorktreeLeaseOwner;
}

const resolveTaskBranch = (task: HubTaskProjection): string =>
  task.claim?.branch ?? resolveHubTaskBranch(task.id, task.title);

const resolveClaimState = (
  task: HubTaskProjection,
): "active" | "stale" | "missing" => {
  if (!task.claim) {
    return "missing";
  }
  return task.claimState === "active" ? "active" : "stale";
};

const findLeaseForTask = (
  task: HubTaskProjection,
  leases: readonly WorktreeLeaseRecord[],
): WorktreeLeaseRecord | undefined => {
  const branch = resolveTaskBranch(task);
  const worktreeName = branchToWorktreeName(branch);

  return leases.find(
    (lease) =>
      lease.owner?.taskId === task.id ||
      lease.branch === branch ||
      lease.worktreeName === worktreeName,
  );
};

const formatOwnerSummary = (owner: WorktreeLeaseOwner | undefined): string => {
  if (!owner) {
    return "unknown owner";
  }
  if (owner.kind === "hub" && owner.taskId) {
    const parts = [
      `task ${owner.taskId}`,
      owner.flowId ? `flow ${owner.flowId}` : undefined,
      owner.batchId ? `batch ${owner.batchId}` : undefined,
    ].filter((part) => part !== undefined);
    return parts.join(", ");
  }
  return "direct execution";
};

export const buildHubWorktreeLeaseDiagnostic = (
  task: HubTaskProjection,
  lease: WorktreeLeaseRecord | undefined,
): HubWorktreeLeaseDiagnostic | undefined => {
  const branch = resolveTaskBranch(task);
  const worktreeName = branchToWorktreeName(branch);
  const claimState = resolveClaimState(task);
  const leaseState = lease?.state ?? "missing";

  if (claimState === "active" && leaseState === "active") {
    return {
      taskId: task.id,
      title: task.title,
      reason: "worktree_lease_active_execution",
      branch,
      worktreeName,
      leaseState,
      claimState,
      pid: lease?.pid,
      owner: lease?.owner,
      nextAction: "Wait for the active execution to finish before retrying.",
      message: `Task ${task.id} has an active Hub claim and an active worktree lease on ${branch} (${formatOwnerSummary(lease?.owner)}, pid ${lease?.pid}).`,
    };
  }

  if (claimState === "active" && leaseState === "missing") {
    return {
      taskId: task.id,
      title: task.title,
      reason: "worktree_lease_missing",
      branch,
      worktreeName,
      leaseState,
      claimState,
      nextAction:
        "Rerun the flow to recreate execution state, or recover the task if execution was abandoned.",
      message: `Task ${task.id} has an active Hub claim on ${branch}, but no worktree lease is present.`,
    };
  }

  if (task.hubStatus === "failed" && claimState === "stale" && leaseState === "active") {
    return {
      taskId: task.id,
      title: task.title,
      reason: "worktree_lease_active_with_failed_claim",
      branch,
      worktreeName,
      leaseState,
      claimState,
      pid: lease?.pid,
      owner: lease?.owner,
      nextAction:
        "Wait for the active worktree execution to finish, then run archloop tasks recover.",
      message: `Failed task ${task.id} still has stale claim metadata, but ${branch} remains locked by active execution (${formatOwnerSummary(lease?.owner)}, pid ${lease?.pid}).`,
    };
  }

  if (task.hubStatus === "failed" && claimState === "stale" && leaseState === "stale") {
    return {
      taskId: task.id,
      title: task.title,
      reason: "worktree_lease_stale_with_failed_claim",
      branch,
      worktreeName,
      leaseState,
      claimState,
      pid: lease?.pid,
      owner: lease?.owner,
      nextAction: `archloop tasks recover ${task.id} to retry from the preserved branch and worktree.`,
      message: `Failed task ${task.id} has stale claim metadata and a stale worktree lease on ${branch}. The worktree is preserved for retry.`,
    };
  }

  return undefined;
};

export const collectHubWorktreeLeaseDiagnosticsForTasks = (
  tasks: readonly HubTaskProjection[],
  leases: readonly WorktreeLeaseRecord[],
): readonly HubWorktreeLeaseDiagnostic[] => {
  const diagnostics: HubWorktreeLeaseDiagnostic[] = [];

  for (const task of tasks) {
    const lease = findLeaseForTask(task, leases);
    const diagnostic = buildHubWorktreeLeaseDiagnostic(task, lease);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }

  const claimedTaskIds = new Set(
    tasks
      .filter((task) => task.claimState === "active")
      .map((task) => task.id),
  );

  for (const lease of leases) {
    if (lease.state !== "active" || lease.owner?.kind !== "hub" || !lease.owner.taskId) {
      continue;
    }
    if (claimedTaskIds.has(lease.owner.taskId)) {
      continue;
    }

    const task = tasks.find((entry) => entry.id === lease.owner?.taskId);
    diagnostics.push({
      taskId: lease.owner.taskId,
      title: task?.title ?? lease.owner.taskId,
      reason: "worktree_lease_active_without_claim",
      branch: lease.branch,
      worktreeName: lease.worktreeName,
      leaseState: "active",
      claimState: task?.claim ? "stale" : "missing",
      pid: lease.pid,
      owner: lease.owner,
      nextAction: task
        ? `Wait for execution on ${lease.branch} to finish, or recover task ${lease.owner.taskId} if execution was abandoned.`
        : `Wait for execution on ${lease.branch} to finish before starting another run on that branch.`,
      message: `Worktree lease on ${lease.branch} is active (${formatOwnerSummary(lease.owner)}, pid ${lease.pid}), but Hub has no active claim for task ${lease.owner.taskId}.`,
    });
  }

  return diagnostics.sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
};

export const collectActiveHubWorktreeLeaseDiagnostics = (
  tasks: readonly HubTaskProjection[],
  leases: readonly WorktreeLeaseRecord[],
): readonly HubWorktreeLeaseDiagnostic[] =>
  collectHubWorktreeLeaseDiagnosticsForTasks(tasks, leases).filter(
    (diagnostic) =>
      diagnostic.reason === "worktree_lease_active_execution" ||
      diagnostic.reason === "worktree_lease_active_with_failed_claim" ||
      diagnostic.reason === "worktree_lease_active_without_claim" ||
      diagnostic.reason === "worktree_lease_missing" ||
      diagnostic.reason === "worktree_lease_stale_with_failed_claim",
  );
