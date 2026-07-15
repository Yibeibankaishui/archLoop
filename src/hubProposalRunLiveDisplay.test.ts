import { describe, expect, it } from "vitest";

import { createHubProposalPresentationEvent } from "./hubProposalSession.js";
import {
  createHubProposalRunDisplayState,
  projectHubProposalRunOutcome,
  reduceHubProposalRunDisplayState,
} from "./hubProposalRunDisplay.js";
import { createHubProposalRunLiveDisplay } from "./hubProposalRunLiveDisplay.js";
import { isTerminalCursorHidden, SHOW_CURSOR } from "./terminalCleanup.js";

describe("proposal live run output", () => {
  it("suspends the live region for interactive prompts and resumes latest state", () => {
    const writes: string[] = [];
    const live = createHubProposalRunLiveDisplay({
      terminal: { write: (chunk) => writes.push(chunk) },
      clock: { now: () => 1_000 },
      startedAt: 0,
      columns: 100,
      rows: 24,
      color: false,
    });
    const state = reduceHubProposalRunDisplayState(
      createHubProposalRunDisplayState({
        hubProjectName: "Demo",
        flowId: "triage",
      }),
      createHubProposalPresentationEvent({
        runId: "proposal-prompt",
        runDir: "/tmp/proposal-prompt",
        flowId: "triage",
        sequence: 1,
        phase: "approval",
        status: "started",
      }),
    );

    live.update(state);
    expect(isTerminalCursorHidden()).toBe(true);
    live.suspend();
    expect(isTerminalCursorHidden()).toBe(false);
    const writesBeforeSuspendedUpdate = writes.length;
    live.update(state);
    expect(writes).toHaveLength(writesBeforeSuspendedUpdate);
    expect(writes.at(-1)).toContain(SHOW_CURSOR);
    expect(live.resume()).toBe(true);
    expect(writes.at(-1)).toContain("Approve proposal | In progress");
    expect(writes.at(-1)).toContain("\x1b[?25l");
    expect(isTerminalCursorHidden()).toBe(true);
    live.dispose();
    expect(isTerminalCursorHidden()).toBe(false);
  });

  it("uses the shared run frame around canonical proposal phases", () => {
    const writes: string[] = [];
    let now = 1_000;
    const live = createHubProposalRunLiveDisplay({
      terminal: { write: (chunk) => writes.push(chunk) },
      clock: { now: () => now },
      startedAt: 0,
      columns: 120,
      rows: 30,
      color: false,
    });
    const initial = createHubProposalRunDisplayState({
      hubProjectName: "Demo",
      flowId: "prd-decomposition",
    });
    const running = [
      createHubProposalPresentationEvent({
        runId: "proposal-1",
        runDir: "/tmp/proposal-1",
        flowId: "prd-decomposition",
        sequence: 1,
        phase: "input_preparation",
        status: "completed",
      }),
      createHubProposalPresentationEvent({
        runId: "proposal-1",
        runDir: "/tmp/proposal-1",
        flowId: "prd-decomposition",
        sequence: 2,
        phase: "draft",
        status: "started",
      }),
    ].reduce(reduceHubProposalRunDisplayState, initial);

    expect(live.update(running)).toBe(true);
    expect(writes.join("")).toContain(
      "archLoop run | Project Demo | Flow prd-decomposition | Run proposal-1",
    );
    expect(writes.join("")).toContain("Prepare input | Completed");
    expect(writes.join("")).toContain("Generate draft | In progress");
    expect(writes.join("")).not.toContain("Private agent prose");

    const applied = reduceHubProposalRunDisplayState(
      running,
      createHubProposalPresentationEvent({
        runId: "proposal-1",
        runDir: "/tmp/proposal-1",
        flowId: "prd-decomposition",
        sequence: 3,
        phase: "apply",
        status: "completed",
        data: { applied: 3, dependencies: 2 },
      }),
    );
    now = 5_000;
    live.finalize(applied, projectHubProposalRunOutcome(applied));

    expect(writes.at(-1)).toContain("Proposal approved and applied");
    expect(writes.at(-1)).toContain("Elapsed 00:05");
    expect(writes.at(-1)).toContain("Logs /tmp/proposal-1");
    expect(writes.at(-1)).toContain(SHOW_CURSOR);
  });

  it("clears every physical row after terminal resize reflows the live frame", () => {
    const writes: string[] = [];
    const live = createHubProposalRunLiveDisplay({
      terminal: { write: (chunk) => writes.push(chunk) },
      clock: { now: () => 1_000 },
      startedAt: 0,
      columns: 120,
      rows: 30,
      color: false,
    });
    const state = reduceHubProposalRunDisplayState(
      createHubProposalRunDisplayState({
        hubProjectName:
          "a-deliberately-long-project-name-that-reflows-after-terminal-resize",
        flowId: "prd-decomposition",
      }),
      createHubProposalPresentationEvent({
        runId: "proposal-resize",
        runDir: "/tmp/proposal-resize",
        flowId: "prd-decomposition",
        sequence: 1,
        phase: "draft",
        status: "started",
      }),
    );

    live.update(state);
    const originalLogicalRows = writes[0]!.split("\n").length;
    expect(live.resize(40)).toBe(true);

    expect(writes[1]!.match(/\x1b\[1A/g)!.length).toBeGreaterThan(
      originalLogicalRows - 1,
    );
    expect(writes[2]).toContain("archLoop run | Project a-deliberatel");
  });

  it("restores the cursor after the first terminal write partially succeeds", () => {
    let output = "";
    let writeCount = 0;
    const live = createHubProposalRunLiveDisplay({
      terminal: {
        write: (chunk) => {
          writeCount += 1;
          if (writeCount === 1) {
            output += chunk.slice(0, "\x1b[?25l".length);
            throw new Error("partial terminal write");
          }
          output += chunk;
        },
      },
      clock: { now: () => 1_000 },
      startedAt: 0,
      columns: 120,
      rows: 30,
      color: false,
    });
    const state = reduceHubProposalRunDisplayState(
      createHubProposalRunDisplayState({
        hubProjectName: "Demo",
        flowId: "triage",
      }),
      createHubProposalPresentationEvent({
        runId: "proposal-write-failure",
        runDir: "/tmp/proposal-write-failure",
        flowId: "triage",
        sequence: 1,
        phase: "draft",
        status: "started",
      }),
    );

    expect(() => live.update(state)).toThrow("partial terminal write");
    live.dispose();

    expect(writeCount).toBe(2);
    expect(output).toBe(`\x1b[?25l${SHOW_CURSOR}`);
  });
});
