import type { HubTaskProjection } from "./taskBoard.js";

export type HubFailureReason =
  | "agent_failed"
  | "sandbox_failed"
  | "merge_conflict"
  | "merge_failed"
  | "verification_failure"
  | "close_failed"
  | "unknown";

export const resolveFailedTaskNextAction = (
  task: Pick<HubTaskProjection, "id">,
  failureReason: HubFailureReason | undefined,
): string => {
  const recoverCmd = `archloop tasks recover ${task.id}`;
  switch (failureReason) {
    case "agent_failed":
    case "sandbox_failed":
      return `${recoverCmd} to reset and retry agent work`;
    case "merge_conflict":
      return `${recoverCmd} or resolve the merge conflict manually`;
    case "merge_failed":
      return `${recoverCmd} to inspect and retry the merge`;
    case "verification_failure":
      return `${recoverCmd} or fix verification and recover`;
    case "close_failed":
      return `${recoverCmd} to verify merge and retry local close`;
    default:
      return `${recoverCmd} to inspect and repair execution state`;
  }
};
