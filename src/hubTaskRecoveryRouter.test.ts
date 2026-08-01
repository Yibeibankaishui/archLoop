import { describe, expect, it } from "vitest";

import type { HubTaskEvent } from "./hubExecution.js";
import {
  isPhaseCompletionEvent,
  latestPhaseCompletionEventByTask,
  routeInterruptedTaskRecovery,
  type RouteInterruptedTaskRecoveryInput,
  type InterruptedTaskRecoveryRoute,
} from "./hubTaskRecoveryRouter.js";
import type { HubTaskStatus } from "./taskBoard.js";

const baseEvent = (overrides: Partial<HubTaskEvent>): HubTaskEvent => ({
  type: "task_review_succeeded",
  runId: "run-1",
  batchId: "batch-1",
  taskId: "bd-1",
  branch: "archloop/bd-1-task",
  createdAt: "2026-07-23T00:00:00.000Z",
  status: "waiting_for_merge",
  ...overrides,
});

const route = (
  hubStatus: HubTaskStatus,
  latestEvent: HubTaskEvent | undefined,
  branchHasUnmergedWork: boolean,
): InterruptedTaskRecoveryRoute =>
  routeInterruptedTaskRecovery({
    hubStatus,
    latestEvent,
    branchHasUnmergedWork,
  });

describe("routeInterruptedTaskRecovery", () => {
  describe("event-aware routing (finished phases preserved)", () => {
    it("routes a review-succeeded task to waiting_for_merge and keeps the claim (merge interrupted)", () => {
      const result = route(
        "merging",
        baseEvent({
          type: "task_review_succeeded",
          status: "waiting_for_merge",
        }),
        true,
      );
      expect(result.targetStatus).toBe("waiting_for_merge");
      expect(result.preserveClaim).toBe(true);
    });

    it("preserves the waiting_for_merge route regardless of whether the branch still has commits", () => {
      const event = baseEvent({
        type: "task_review_succeeded",
        status: "waiting_for_merge",
      });
      expect(route("reviewing", event, true).targetStatus).toBe(
        "waiting_for_merge",
      );
      expect(route("reviewing", event, false).targetStatus).toBe(
        "waiting_for_merge",
      );
    });

    it("routes an implementation-succeeded (reviewer flow) task to reviewing and keeps the claim (review interrupted)", () => {
      const result = route(
        "reviewing",
        baseEvent({
          type: "task_implementation_succeeded",
          status: "reviewing",
        }),
        true,
      );
      expect(result.targetStatus).toBe("reviewing");
      expect(result.preserveClaim).toBe(true);
    });

    it("routes a review-less implementation-succeeded task to waiting_for_merge and keeps the claim (merge interrupted)", () => {
      const result = route(
        "merging",
        baseEvent({
          type: "task_implementation_succeeded",
          status: "waiting_for_merge",
        }),
        true,
      );
      expect(result.targetStatus).toBe("waiting_for_merge");
      expect(result.preserveClaim).toBe(true);
    });

    it.each<HubTaskStatus>(["implementing", "reviewing", "merging"])(
      "honors the review-succeeded event regardless of the interrupted hub status (%s)",
      (hubStatus) => {
        const result = route(
          hubStatus,
          baseEvent({
            type: "task_review_succeeded",
            status: "waiting_for_merge",
          }),
          true,
        );
        expect(result.targetStatus).toBe("waiting_for_merge");
        expect(result.preserveClaim).toBe(true);
      },
    );
  });

  describe("no success event (retry implementation)", () => {
    it("routes to ready_for_agent and drops the claim when the branch has no commits (fresh implement)", () => {
      const result = route("implementing", undefined, false);
      expect(result.targetStatus).toBe("ready_for_agent");
      expect(result.preserveClaim).toBe(false);
    });

    it("routes to ready_for_agent and drops the claim when the branch has existing commits (retry reuses preserved worktree)", () => {
      const result = route("implementing", undefined, true);
      expect(result.targetStatus).toBe("ready_for_agent");
      expect(result.preserveClaim).toBe(false);
    });

    it.each<HubTaskStatus>(["implementing", "reviewing", "merging"])(
      "retries from ready_for_agent for any interrupted status with no event (%s)",
      (hubStatus) => {
        const result = route(hubStatus, undefined, false);
        expect(result.targetStatus).toBe("ready_for_agent");
        expect(result.preserveClaim).toBe(false);
      },
    );
  });

  describe("event precedence over branch work", () => {
    it("prefers a finished-phase event over the no-event commit branch even when commits exist", () => {
      const result = route(
        "implementing",
        baseEvent({
          type: "task_implementation_succeeded",
          status: "reviewing",
        }),
        true,
      );
      expect(result.targetStatus).toBe("reviewing");
      expect(result.preserveClaim).toBe(true);
    });

    it("ignores a merge_conflict_resolution_succeeded event (not a phase-completion signal)", () => {
      const result = route(
        "merging",
        baseEvent({
          type: "merge_conflict_resolution_succeeded",
          status: "merging",
        }),
        true,
      );
      expect(result.targetStatus).toBe("ready_for_agent");
      expect(result.preserveClaim).toBe(false);
    });
  });

  describe("claim-preservation matches the transition claim policy", () => {
    it("never preserves a claim when routing to ready_for_agent", () => {
      expect(route("implementing", undefined, false).preserveClaim).toBe(false);
      expect(route("implementing", undefined, true).preserveClaim).toBe(false);
    });

    it("always preserves a claim when routing to a claim-required status", () => {
      expect(
        route(
          "reviewing",
          baseEvent({
            type: "task_implementation_succeeded",
            status: "reviewing",
          }),
          true,
        ).preserveClaim,
      ).toBe(true);
      expect(
        route(
          "merging",
          baseEvent({
            type: "task_review_succeeded",
            status: "waiting_for_merge",
          }),
          true,
        ).preserveClaim,
      ).toBe(true);
    });
  });

  describe("reason string", () => {
    it("describes the review-succeeded merge-interrupted route", () => {
      const result = route(
        "merging",
        baseEvent({
          type: "task_review_succeeded",
          status: "waiting_for_merge",
        }),
        true,
      );
      expect(result.reason).toMatch(/task_review_succeeded/);
      expect(result.reason).toMatch(/waiting_for_merge/);
    });

    it("describes the implementation-succeeded review-interrupted route", () => {
      const result = route(
        "reviewing",
        baseEvent({
          type: "task_implementation_succeeded",
          status: "reviewing",
        }),
        true,
      );
      expect(result.reason).toMatch(/task_implementation_succeeded/);
      expect(result.reason).toMatch(/reviewing/);
    });

    it("distinguishes the retry-with-existing-work route from the fresh route", () => {
      const withWork = route("implementing", undefined, true);
      const fresh = route("implementing", undefined, false);
      expect(withWork.reason).not.toBe(fresh.reason);
      expect(withWork.reason).toMatch(/ready_for_agent/);
      expect(fresh.reason).toMatch(/ready_for_agent/);
    });
  });

  describe("purity", () => {
    it("does not mutate the input event", () => {
      const event = baseEvent({
        type: "task_review_succeeded",
        status: "waiting_for_merge",
      });
      const snapshot = JSON.stringify(event);
      routeInterruptedTaskRecovery({
        hubStatus: "merging",
        latestEvent: event,
        branchHasUnmergedWork: true,
      });
      expect(JSON.stringify(event)).toBe(snapshot);
    });

    it("accepts a fully-typed input object", () => {
      const input: RouteInterruptedTaskRecoveryInput = {
        hubStatus: "implementing",
        latestEvent: undefined,
        branchHasUnmergedWork: false,
      };
      const result = routeInterruptedTaskRecovery(input);
      expect(result.targetStatus).toBe("ready_for_agent");
      expect(result.preserveClaim).toBe(false);
      expect(typeof result.reason).toBe("string");
    });
  });

  describe("isPhaseCompletionEvent", () => {
    it("treats task_review_succeeded as a phase-completion signal", () => {
      expect(
        isPhaseCompletionEvent(
          baseEvent({
            type: "task_review_succeeded",
            status: "waiting_for_merge",
          }),
        ),
      ).toBe(true);
    });

    it("treats the reviewer-flow implementation-succeeded event as a phase-completion signal", () => {
      expect(
        isPhaseCompletionEvent(
          baseEvent({
            type: "task_implementation_succeeded",
            status: "reviewing",
          }),
        ),
      ).toBe(true);
    });

    it("treats the review-less implementation-succeeded event as a phase-completion signal", () => {
      expect(
        isPhaseCompletionEvent(
          baseEvent({
            type: "task_implementation_succeeded",
            status: "waiting_for_merge",
          }),
        ),
      ).toBe(true);
    });

    it("ignores non-phase-completion events", () => {
      expect(
        isPhaseCompletionEvent(
          baseEvent({
            type: "merge_conflict_resolution_succeeded",
            status: "merging",
          }),
        ),
      ).toBe(false);
      expect(
        isPhaseCompletionEvent(
          baseEvent({
            type: "task_implementation_started",
            status: "implementing",
          }),
        ),
      ).toBe(false);
      expect(
        isPhaseCompletionEvent(
          baseEvent({ type: "task_closed", status: "done" }),
        ),
      ).toBe(false);
    });
  });

  describe("latestPhaseCompletionEventByTask", () => {
    it("maps each task to its latest phase-completion event", () => {
      const events: HubTaskEvent[] = [
        baseEvent({
          type: "task_implementation_succeeded",
          status: "reviewing",
          taskId: "bd-a",
          createdAt: "2026-07-23T01:00:00.000Z",
        }),
        baseEvent({
          type: "task_review_succeeded",
          status: "waiting_for_merge",
          taskId: "bd-a",
          createdAt: "2026-07-23T02:00:00.000Z",
        }),
        baseEvent({
          type: "task_implementation_succeeded",
          status: "reviewing",
          taskId: "bd-b",
          createdAt: "2026-07-23T01:30:00.000Z",
        }),
      ];
      const byTask = latestPhaseCompletionEventByTask(events);
      expect(byTask.get("bd-a")?.type).toBe("task_review_succeeded");
      expect(byTask.get("bd-b")?.type).toBe("task_implementation_succeeded");
    });

    it("skips tasks that have no phase-completion event", () => {
      const events: HubTaskEvent[] = [
        baseEvent({
          type: "task_implementation_started",
          status: "implementing",
          taskId: "bd-c",
        }),
      ];
      expect(latestPhaseCompletionEventByTask(events).has("bd-c")).toBe(false);
    });

    it("returns an empty map for an empty event log", () => {
      expect(latestPhaseCompletionEventByTask([]).size).toBe(0);
    });
  });
});
