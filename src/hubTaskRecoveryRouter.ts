import type { HubTaskEvent } from "./hubExecution.js";
import type { HubTaskStatus } from "./taskBoard.js";

/**
 * The event-aware recovery router is the single source of truth for
 * "given an interrupted task, where does it go?". It is a pure decision
 * table — no filesystem, board, or event-log access — so it can be tested
 * exhaustively in isolation. Both the per-task recovery path
 * (`recoverStaleExecutionStatus`) and the `tasks recover --stale` batch
 * path call this router.
 *
 * Inputs are exactly the three the recovery decision needs:
 * - `hubStatus` — the interrupted task's current hub status
 *   (`implementing` / `reviewing` / `merging`).
 * - `latestEvent` — the task's latest phase-completion signal from the run
 *   event log, already resolved by the caller (reusing the doctor's
 *   `latestMergeReadyEventsByTask` helper). `undefined` when no success
 *   event has fired.
 * - `branchHasUnmergedWork` — whether the task's branch still carries
 *   commits ahead of HEAD, used only to flavor the no-event retry route.
 *
 * The router does not consult failure reasons: a human-failure-reason
 * override to `ready_for_human` is applied by the recovery wiring
 * (`resolveFailedRecoveryTarget`) after this router resolves the base
 * destination, so this module stays a pure phase-completion decision table.
 */

export interface RouteInterruptedTaskRecoveryInput {
  readonly hubStatus: HubTaskStatus;
  readonly latestEvent: HubTaskEvent | undefined;
  readonly branchHasUnmergedWork: boolean;
}

export interface InterruptedTaskRecoveryRoute {
  readonly targetStatus: HubTaskStatus;
  readonly preserveClaim: boolean;
  readonly reason: string;
}

/**
 * A phase-completion signal is a success event whose `status` carries the
 * next phase the task was advancing to. `task_review_succeeded` always
 * advances to `waiting_for_merge`; `task_implementation_succeeded` advances
 * to `reviewing` (reviewer flow) or `waiting_for_merge` (review-less flow).
 * Other event types — merges, conflict resolution, verifications — are not
 * phase-completion signals and are ignored so the task retries from
 * `ready_for_agent`.
 */
const resolvePhaseCompletionStatus = (
  event: HubTaskEvent | undefined,
): HubTaskStatus | undefined => {
  if (!event) {
    return undefined;
  }

  if (event.type === "task_review_succeeded") {
    return "waiting_for_merge";
  }

  if (event.type === "task_implementation_succeeded") {
    if (event.status === "reviewing") {
      return "reviewing";
    }
    if (event.status === "waiting_for_merge") {
      return "waiting_for_merge";
    }
  }

  return undefined;
};

/**
 * Whether an event is a phase-completion signal the recovery router acts on.
 *
 * This mirrors the doctor's `isMergeReadyEvent` (the helper the PRD names for
 * event-log reading) but widens it to also recognize the reviewer-flow
 * implementation-succeeded event (`status: "reviewing"`): a task whose
 * implementation completed but whose review was interrupted must resume at
 * review, not be re-implemented. The doctor's own helper intentionally treats
 * only the review-less `waiting_for_merge` implementation-succeeded event as
 * merge-ready, so it is left untouched; the router owns this wider selection.
 */
export const isPhaseCompletionEvent = (event: HubTaskEvent): boolean =>
  resolvePhaseCompletionStatus(event) !== undefined;

/**
 * Selects each task's latest phase-completion event from a run event log.
 *
 * Pure over the supplied events — no filesystem access. The recovery wiring
 * reads the event log and calls this, then passes the per-task result to
 * {@link routeInterruptedTaskRecovery}. Later events overwrite earlier ones,
 * matching the doctor's `latestMergeReadyEventsByTask` convention (the event
 * log is append-only and chronological).
 */
export const latestPhaseCompletionEventByTask = (
  events: readonly HubTaskEvent[],
): ReadonlyMap<string, HubTaskEvent> => {
  const byTask = new Map<string, HubTaskEvent>();
  for (const event of events) {
    if (!isPhaseCompletionEvent(event)) {
      continue;
    }
    byTask.set(event.taskId, event);
  }
  return byTask;
};

export const routeInterruptedTaskRecovery = (
  input: RouteInterruptedTaskRecoveryInput,
): InterruptedTaskRecoveryRoute => {
  const { hubStatus, latestEvent, branchHasUnmergedWork } = input;

  const completedPhase = resolvePhaseCompletionStatus(latestEvent);
  if (completedPhase) {
    // A finished phase is preserved: the task resumes at the phase the
    // success event was advancing it to, and its claim metadata is kept so
    // the resumed-batch merge path (which keys off claim.runId /
    // claim.batchId) can find it. reviewing and waiting_for_merge are
    // claim-required statuses, so the claim must be preserved here.
    // completedPhase is only defined when latestEvent is present.
    return {
      targetStatus: completedPhase,
      preserveClaim: true,
      reason: `Recovered interrupted ${hubStatus} task to ${completedPhase} because the ${latestEvent!.type} event shows that phase already completed; preserved claim metadata to resume the remaining phase.`,
    };
  }

  // No phase-completion signal: implementation was interrupted before any
  // phase finished, so the task retries from ready_for_agent. The claim is
  // dropped (ready_for_agent is not claim-preserving); the preserved
  // worktree is reused when the branch already carries commits.
  return {
    targetStatus: "ready_for_agent",
    preserveClaim: false,
    reason: branchHasUnmergedWork
      ? `Recovered interrupted ${hubStatus} task to ready_for_agent for a retry that reuses the preserved worktree (branch has existing unmerged commits); released claim metadata.`
      : `Recovered interrupted ${hubStatus} task to ready_for_agent for a fresh implement (no success event and no branch commits); released claim metadata.`,
  };
};
