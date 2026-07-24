import {
  detectInterruptedHubTaskExecutions,
  type InterruptedHubTaskExecution,
} from "./hubTaskInterruptedExecutionDetector.js";
import {
  recoverHubTask,
  type RecoverHubTaskInput,
  type RecoverHubTaskResult,
} from "./hubTaskRecover.js";
import {
  loadHubTaskBoard,
  type HubTaskProjection,
} from "./taskBoard.js";
import { listWorktreeLeases } from "./worktreeLeaseStore.js";

/**
 * The `archloop run` startup auto-recover step. When a Hub flow run is
 * re-launched after being terminated mid-execution, one or more tasks are left
 * stuck in an execution status (`implementing` / `reviewing` / `merging`) with
 * no live worktree lease. Re-running silently no-ops for them — the batch
 * planner selects only `ready_for_agent` tasks — so the user is stuck.
 *
 * This step makes an interrupted run recoverable: it scans the task board for
 * interrupted executions (the shared detector) and applies the event-aware
 * recovery router to each one (the already-tested {@link recoverHubTask}
 * wiring). It then returns a structured summary so the run can report how many
 * tasks were recovered and to which phase each was routed — the automatic state
 * mutation is auditable, not silent.
 *
 * After recovery the run's normal mechanics resume the tasks: `waiting_for_merge`
 * recoveries are picked up by the resumed-batch merge path, and `ready_for_agent`
 * recoveries are selected by the batch planner and re-implemented reusing the
 * preserved worktree. A recovery to `reviewing` preserves the finished
 * implementation (the router keeps the claim) so it is never re-implemented.
 *
 * This module is orchestration glue over already-tested modules — the detector
 * (arch-c75), the recovery router (arch-ewx), and the per-task recovery wiring
 * (arch-2q6) — so it is covered at the run-integration level rather than
 * unit-tested in depth.
 */
export interface AutoRecoverInterruptedHubTasksInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Resolves the task's latest phase-completion event from the run event log,
   * feeding the recovery router's `latestEvent` input. Forwarded to
   * {@link recoverHubTask}; defaults to scanning the Hub project dir.
   */
  readonly resolveLatestPhaseCompletionEvent?: RecoverHubTaskInput["resolveLatestPhaseCompletionEvent"];
  /** Forwarded to {@link recoverHubTask}; defaults to a git rev-list check. */
  readonly branchHasUnmergedWork?: RecoverHubTaskInput["branchHasUnmergedWork"];
  /**
   * The per-task recovery function. Injectable so the orchestration can be
   * exercised without `bd`; defaults to {@link recoverHubTask}, which already
   * wires the router and persists the recovery + comment.
   */
  readonly recoverTask?: (
    input: RecoverHubTaskInput,
  ) => Promise<RecoverHubTaskResult>;
}

export interface HubRunAutoRecoveryEntry {
  readonly taskId: string;
  readonly priorStatus: RecoverHubTaskResult["priorStatus"];
  readonly hubStatus: RecoverHubTaskResult["hubStatus"];
  readonly outcome: RecoverHubTaskResult["outcome"];
  /** The phase the interrupted execution was stuck in before recovery. */
  readonly interruptedPhase: InterruptedHubTaskExecution["phase"];
  readonly summary: string;
}

export interface HubRunAutoRecoveryFailure {
  readonly taskId: string;
  readonly interruptedPhase: InterruptedHubTaskExecution["phase"];
  readonly message: string;
}

export interface HubRunAutoRecoverSummary {
  /** How many interrupted tasks were successfully recovered. */
  readonly recoveredCount: number;
  /** How many interrupted tasks could not be recovered (best-effort recovery). */
  readonly failedCount: number;
  readonly recoveries: readonly HubRunAutoRecoveryEntry[];
  readonly failures: readonly HubRunAutoRecoveryFailure[];
}

const EMPTY_SUMMARY: HubRunAutoRecoverSummary = {
  recoveredCount: 0,
  failedCount: 0,
  recoveries: [],
  failures: [],
};

const summarizeRecoveryError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Scan the task board for interrupted executions and recover each one through
 * the event-aware recovery wiring. Returns a structured summary; never throws —
 * a failure recovering one task (e.g. a transient `bd` error) is recorded
 * against that task so the remaining tasks still recover and the run continues.
 *
 * If the task board cannot be loaded at all (the repo has no Hub task store, or
 * `bd` is unavailable), the step is a no-op: a non-Hub repo has no interrupted
 * Hub executions to recover, and an unreadable board cannot prove any task is
 * interrupted. This keeps `archloop run` working on repos that are not Hub
 * projects.
 */
export const autoRecoverInterruptedHubTasks = async (
  input: AutoRecoverInterruptedHubTasksInput,
): Promise<HubRunAutoRecoverSummary> => {
  let tasks: readonly HubTaskProjection[];
  try {
    tasks = loadHubTaskBoard(input.cwd, input.env).tasks;
  } catch {
    // No readable task board => no interrupted Hub executions to recover. This
    // is the common path for repos that are not Hub projects, so it must not
    // break `archloop run`.
    return EMPTY_SUMMARY;
  }

  const leases = listWorktreeLeases(input.cwd);
  const interrupted = detectInterruptedHubTaskExecutions(tasks, leases);
  if (interrupted.length === 0) {
    return EMPTY_SUMMARY;
  }

  const recoverTask = input.recoverTask ?? recoverHubTask;
  const recoveries: HubRunAutoRecoveryEntry[] = [];
  const failures: HubRunAutoRecoveryFailure[] = [];

  for (const interruptedTask of interrupted) {
    const { taskId, phase } = interruptedTask;
    try {
      const result = await recoverTask({
        cwd: input.cwd,
        taskId,
        env: input.env,
        resolveLatestPhaseCompletionEvent:
          input.resolveLatestPhaseCompletionEvent,
        branchHasUnmergedWork: input.branchHasUnmergedWork,
      });
      recoveries.push({
        taskId,
        priorStatus: result.priorStatus,
        hubStatus: result.hubStatus,
        outcome: result.outcome,
        interruptedPhase: phase,
        summary: result.summary,
      });
    } catch (error) {
      // Best-effort: record the failure and continue so one stuck task does not
      // block recovery of the rest or abort the run.
      failures.push({
        taskId,
        interruptedPhase: phase,
        message: summarizeRecoveryError(error),
      });
    }
  }

  return {
    recoveredCount: recoveries.length,
    failedCount: failures.length,
    recoveries,
    failures,
  };
};

/** Whether the summary reports any recovery activity worth surfacing. */
export const hasHubRunAutoRecoverActivity = (
  summary: HubRunAutoRecoverSummary | undefined,
): summary is HubRunAutoRecoverSummary =>
  summary !== undefined && summary.recoveredCount + summary.failedCount > 0;

/**
 * Render the auto-recover summary as human-readable lines for the run result.
 * Returns an empty array when there is nothing to report so callers can spread
 * the result unconditionally.
 */
export const formatHubRunAutoRecoverLines = (
  summary: HubRunAutoRecoverSummary | undefined,
): readonly string[] => {
  if (!hasHubRunAutoRecoverActivity(summary)) {
    return [];
  }

  const lines: string[] = [
    `Auto-recovered ${summary.recoveredCount} interrupted task(s) at run startup:`,
  ];
  for (const entry of summary.recoveries) {
    lines.push(
      `  ${entry.taskId}: ${entry.priorStatus} -> ${entry.hubStatus} (was ${entry.interruptedPhase})`,
    );
  }
  for (const failure of summary.failures) {
    lines.push(
      `  ${failure.taskId}: failed to recover from ${failure.interruptedPhase} — ${failure.message}`,
    );
  }
  return lines;
};
