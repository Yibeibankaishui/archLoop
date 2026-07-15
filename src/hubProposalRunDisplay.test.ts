import { describe, expect, it } from "vitest";

import { createHubProposalPresentationEvent } from "./hubProposalSession.js";
import {
  acceptsHubProposalPresentationEvent,
  createHubProposalRunDisplayState,
  createHubProposalRunJsonRenderer,
  formatPlainHubProposalEvent,
  formatPlainHubProposalOutcome,
  projectHubProposalRunCancellation,
  projectHubProposalRunOutcome,
  reduceHubProposalRunDisplayState,
} from "./hubProposalRunDisplay.js";

const event = (
  sequence: number,
  phase:
    | "input_preparation"
    | "draft"
    | "refinement"
    | "finalization"
    | "approval"
    | "validation"
    | "mutation_detection"
    | "apply",
  status: "started" | "completed" | "cancelled" | "failed" | "no_change",
) =>
  createHubProposalPresentationEvent({
    runId: "proposal-1",
    runDir: "/tmp/proposal-1",
    flowId: "prd-decomposition",
    sequence,
    phase,
    status,
  });

describe("proposal run presentation", () => {
  it("projects canonical events into proposal phase state for live output", () => {
    const initial = createHubProposalRunDisplayState({
      hubProjectName: "Demo",
      flowId: "prd-decomposition",
    });
    const state = [
      event(1, "input_preparation", "completed"),
      event(2, "draft", "started"),
      event(3, "draft", "completed"),
      event(4, "finalization", "started"),
    ].reduce(reduceHubProposalRunDisplayState, initial);

    expect(state.runId).toBe("proposal-1");
    expect(state.phases).toMatchObject({
      input_preparation: { status: "completed" },
      draft: { status: "completed" },
      finalization: { status: "started" },
    });
    expect(state.activePhase).toBe("finalization");
  });

  it("converges distinct out-of-order phases while rejecting duplicates and stale phase events", () => {
    const initial = createHubProposalRunDisplayState({
      hubProjectName: "Demo",
      flowId: "triage",
    });
    const apply = event(2, "apply", "completed");
    const draft = event(1, "draft", "started");
    const afterApply = reduceHubProposalRunDisplayState(initial, apply);

    expect(acceptsHubProposalPresentationEvent(afterApply, draft)).toBe(true);
    const converged = reduceHubProposalRunDisplayState(afterApply, draft);
    expect(converged.phases).toMatchObject({
      draft: { status: "started" },
      apply: { status: "completed" },
    });
    expect(converged.sequence).toBe(2);
    expect(converged.activePhase).toBeUndefined();
    expect(acceptsHubProposalPresentationEvent(converged, draft)).toBe(false);
    expect(
      acceptsHubProposalPresentationEvent(
        converged,
        event(0, "draft", "completed"),
      ),
    ).toBe(false);
  });

  it("formats deterministic append-only proposal phase lines", () => {
    const source = createHubProposalPresentationEvent({
      runId: "proposal-1",
      runDir: "/tmp/proposal-1",
      flowId: "triage",
      sequence: 12,
      phase: "apply",
      status: "completed",
      data: { applied: 2, skipped: 1, dependencies: 0 },
    });

    expect(formatPlainHubProposalEvent(source, "Demo")).toBe(
      'event=proposal_phase hub_project="Demo" flow="triage" phase="apply" status="completed" run_id="proposal-1" applied=2 skipped=1 dependencies=0 logs="/tmp/proposal-1"',
    );
    expect(formatPlainHubProposalEvent(source, "Demo")).not.toContain(
      "assistantMessage",
    );
  });

  it("serializes proposal phases as stdout-pure JSONL records", () => {
    const renderer = createHubProposalRunJsonRenderer({
      hubProjectName: "Demo",
      flowId: "prd-decomposition",
    });
    const source = createHubProposalPresentationEvent({
      runId: "proposal-1",
      runDir: "/tmp/proposal-1",
      flowId: "prd-decomposition",
      sequence: 3,
      phase: "draft",
      status: "completed",
    });

    const record = JSON.parse(renderer.event(source)) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      schemaVersion: 1,
      type: "proposal_phase",
      sourceEventId: source.eventId,
      runId: "proposal-1",
      flowId: "prd-decomposition",
      hubProject: "Demo",
      phase: "draft",
      status: "completed",
      logs: "/tmp/proposal-1",
    });
    expect(JSON.stringify(record)).not.toContain("assistantMessage");
  });

  it("projects an applied proposal into a successful final summary", () => {
    const initial = createHubProposalRunDisplayState({
      hubProjectName: "Demo",
      flowId: "prd-decomposition",
    });
    const state = reduceHubProposalRunDisplayState(
      initial,
      createHubProposalPresentationEvent({
        runId: "proposal-1",
        runDir: "/tmp/proposal-1",
        flowId: "prd-decomposition",
        sequence: 12,
        phase: "apply",
        status: "completed",
        data: { applied: 3, dependencies: 2 },
      }),
    );

    const outcome = projectHubProposalRunOutcome(state);
    expect(outcome).toEqual({
      outcome: "applied",
      summary: "Proposal approved and applied",
      counts: { applied: 3, skipped: 0, dependencies: 2 },
      exitCode: 0,
      logs: "/tmp/proposal-1",
    });
    expect(formatPlainHubProposalOutcome(state, outcome)).toBe(
      'event=run_completed outcome="applied" summary="Proposal approved and applied" applied=3 skipped=0 dependencies=2 run_id="proposal-1" logs="/tmp/proposal-1" exit_code=0',
    );
  });

  it("projects mutation detection as a blocking outcome with recovery", () => {
    const initial = createHubProposalRunDisplayState({
      hubProjectName: "Demo",
      flowId: "triage",
    });
    const state = reduceHubProposalRunDisplayState(
      initial,
      createHubProposalPresentationEvent({
        runId: "proposal-2",
        runDir: "/tmp/proposal-2",
        flowId: "triage",
        sequence: 8,
        phase: "mutation_detection",
        status: "failed",
        diagnostic: "Unexpected host repo changes: src/changed.ts\nmore detail",
      }),
    );

    expect(projectHubProposalRunOutcome(state)).toEqual({
      outcome: "mutation_failed",
      summary: "Unexpected mutation blocked proposal apply",
      counts: { applied: 0, skipped: 0, dependencies: 0 },
      diagnostic: "Unexpected host repo changes: src/changed.ts",
      recoveryCommand: "archloop run --flow triage",
      exitCode: 1,
      logs: "/tmp/proposal-2",
    });
  });

  it("projects validation failure with a concise actionable diagnostic", () => {
    const initial = createHubProposalRunDisplayState({
      hubProjectName: "Demo",
      flowId: "prd-decomposition",
    });
    const state = reduceHubProposalRunDisplayState(
      initial,
      createHubProposalPresentationEvent({
        runId: "proposal-3",
        runDir: "/tmp/proposal-3",
        flowId: "prd-decomposition",
        sequence: 10,
        phase: "validation",
        status: "failed",
        diagnostic: "Unknown slice id slice-9\nvalidation stack",
      }),
    );

    expect(projectHubProposalRunOutcome(state)).toMatchObject({
      outcome: "validation_failed",
      summary: "Proposal validation failed",
      diagnostic: "Unknown slice id slice-9",
      recoveryCommand: "archloop run --flow prd-decomposition",
      exitCode: 1,
      logs: "/tmp/proposal-3",
    });
  });

  it("projects cancellation from an apply gate as exit code 130", () => {
    const initial = createHubProposalRunDisplayState({
      hubProjectName: "Demo",
      flowId: "triage",
    });
    const state = reduceHubProposalRunDisplayState(
      initial,
      createHubProposalPresentationEvent({
        runId: "proposal-cancelled",
        runDir: "/tmp/proposal-cancelled",
        flowId: "triage",
        sequence: 10,
        phase: "apply",
        status: "cancelled",
      }),
    );

    expect(projectHubProposalRunOutcome(state)).toMatchObject({
      outcome: "cancelled",
      summary: "Proposal cancelled",
      exitCode: 130,
    });
  });

  it("projects process-signal cancellation before a phase can emit", () => {
    const state = createHubProposalRunDisplayState({
      hubProjectName: "Demo",
      flowId: "triage",
    });

    expect(projectHubProposalRunCancellation(state, 143)).toMatchObject({
      outcome: "cancelled",
      summary: "Proposal cancelled",
      exitCode: 143,
      logs: "",
    });
  });
});
