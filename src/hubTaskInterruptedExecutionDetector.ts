import { resolveHubTaskBranch, type HubTaskProjection, type HubTaskStatus } from "./taskBoard.js";
import { branchToWorktreeName, type WorktreeLeaseRecord } from "./worktreeLeaseStore.js";

/**
 * The interrupted-execution detector is the shared, read-only predicate that
 * decides what "interrupted" means for a Hub task. The `archloop run` startup
 * scan, `tasks doctor`, and the `tasks list` badge all call it so the three
 * surfaces agree.
 *
 * It is a pure predicate — no filesystem, board, or event-log access. The
 * caller resolves the worktree lease state (reusing `listWorktreeLeases`) and
 * the task's latest event, then passes the already-resolved values here so the
 * decision can be tested exhaustively in isolation.
 *
 * An interrupted execution is: hub status in {implementing, reviewing,
 * merging} AND (no worktree lease for the task's branch OR the lease state is
 * stale). The detector deliberately does NOT rely on `claimState` alone,
 * because `claimState` misclassifies `reviewing`/`merging` as stale even
 * mid-legitimate-execution (see the `isHubTaskClaimActive` fix): a live
 * worktree lease is the authoritative proof that an execution is still
 * running, so the lease state — not the claim projection — drives the result.
 */

/** The execution phase a task is stuck in when its run was interrupted. */
export type InterruptedExecutionPhase =
  | "implementing"
  | "reviewing"
  | "merging";

/** Hub statuses that represent an in-flight execution which can be interrupted. */
export const INTERRUPTED_EXECUTION_STATUSES: ReadonlySet<HubTaskStatus> =
  new Set<InterruptedExecutionPhase>(["implementing", "reviewing", "merging"]);

/** Whether a hub status represents an in-flight execution. */
export const isInterruptedExecutionStatus = (
  hubStatus: HubTaskStatus,
): hubStatus is InterruptedExecutionPhase =>
  INTERRUPTED_EXECUTION_STATUSES.has(hubStatus);

export interface InterruptedExecutionDetection {
  /** Whether the task is an interrupted execution. */
  readonly interrupted: boolean;
  /**
   * The execution phase the task is stuck in when interrupted, or `undefined`
   * when the task is not interrupted.
   */
  readonly phase: InterruptedExecutionPhase | undefined;
}

const NOT_INTERRUPTED: InterruptedExecutionDetection = {
  interrupted: false,
  phase: undefined,
};

/**
 * Decide whether a task is an interrupted execution given its already-resolved
 * worktree lease.
 *
 * @param task - The Hub task projection (its `hubStatus` is the only field the
 *   predicate reads; `claimState` is intentionally ignored).
 * @param lease - The worktree lease matched to the task's branch, or
 *   `undefined` when no lease exists. A lease whose `state` is not `"active"`
 *   (including malformed leases, which parse as `"stale"`) counts as stale.
 */
export const isInterruptedHubTaskExecution = (
  task: HubTaskProjection,
  lease: WorktreeLeaseRecord | undefined,
): InterruptedExecutionDetection => {
  if (!isInterruptedExecutionStatus(task.hubStatus)) {
    return NOT_INTERRUPTED;
  }

  // A live lease is the only thing that proves the execution is still
  // running. No lease, or a stale/malformed lease, means the run was
  // interrupted and the task is stuck in its current phase.
  if (lease !== undefined && lease.state === "active") {
    return NOT_INTERRUPTED;
  }

  return { interrupted: true, phase: task.hubStatus };
};

/**
 * Resolve the task's branch, preferring the recorded claim branch and falling
 * back to the canonical `archloop/<id>-<slug>` convention so a task with no
 * claim can still be matched to a lease by its worktree name. Reuses
 * `resolveHubTaskBranch` — the same helper `hubWorktreeLeaseDiagnostics`,
 * `hubBatchMerge`, `hubTaskRecover`, and `hubTaskStateDoctor` use — so every
 * surface agrees on the derived branch instead of drifting.
 */
const resolveTaskBranch = (task: HubTaskProjection): string =>
  task.claim?.branch ?? resolveHubTaskBranch(task.id, task.title);

/**
 * Find the worktree lease for a task, reusing the existing task-to-lease
 * matching so every caller agrees on which lease belongs to which task.
 *
 * A lease matches when its hub owner names the task, or its branch equals the
 * task's (claimed or derived) branch, or its worktree name equals the branch's
 * derived worktree name. The first matching lease wins; lease order is
 * whatever `listWorktreeLeases` produced (sorted by branch).
 */
export const findWorktreeLeaseForTask = (
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

export interface InterruptedHubTaskExecution {
  readonly taskId: string;
  readonly task: HubTaskProjection;
  readonly phase: InterruptedExecutionPhase;
}

/**
 * Scan a task board for interrupted executions, returning one entry per
 * interrupted task with the phase it is stuck in. Used by the `archloop run`
 * startup auto-recover step and the `tasks list` badge; `tasks doctor`
 * consumes the single-task predicate directly so it can dedupe against the
 * existing lease diagnostics.
 *
 * Pure over the supplied tasks and leases — no filesystem access. The caller
 * loads the board (`loadHubTaskBoard`) and the leases (`listWorktreeLeases`)
 * and passes both in.
 */
export const detectInterruptedHubTaskExecutions = (
  tasks: readonly HubTaskProjection[],
  leases: readonly WorktreeLeaseRecord[],
): readonly InterruptedHubTaskExecution[] => {
  const interrupted: InterruptedHubTaskExecution[] = [];
  for (const task of tasks) {
    const lease = findWorktreeLeaseForTask(task, leases);
    const detection = isInterruptedHubTaskExecution(task, lease);
    if (detection.interrupted && detection.phase !== undefined) {
      interrupted.push({
        taskId: task.id,
        task,
        phase: detection.phase,
      });
    }
  }
  return interrupted;
};
