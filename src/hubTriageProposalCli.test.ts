import { describe, expect, it, vi } from "vitest";

import * as hubTriageProposal from "./hubTriageProposal.js";
import { runTriageProposalFlowFromCli } from "./hubTriageProposalCli.js";

describe("runTriageProposalFlowFromCli", () => {
  it("does not prompt for guarded apply or agent config in explicit machine output", async () => {
    const runTriage = vi
      .spyOn(hubTriageProposal, "runTriageProposalFlow")
      .mockResolvedValue({
        outcome: "cancelled",
        runId: "run-machine",
        runDir: "/tmp/run-machine",
        phase: "approval",
      });

    await runTriageProposalFlowFromCli({
      cwd: "/tmp/repo",
      query: "inbox",
      yes: true,
      interactive: false,
      showDecoratedOutput: false,
      isTTY: true,
    });

    expect(runTriage.mock.calls[0]?.[0]).toMatchObject({
      interaction: undefined,
      applyConfirmation: undefined,
      configureHubAgentRole: undefined,
      isTTY: false,
    });
  });

  it("keeps guarded apply and agent config prompts in auto TTY mode", async () => {
    const runTriage = vi
      .spyOn(hubTriageProposal, "runTriageProposalFlow")
      .mockResolvedValue({
        outcome: "cancelled",
        runId: "run-live",
        runDir: "/tmp/run-live",
        phase: "approval",
      });

    await runTriageProposalFlowFromCli({
      cwd: "/tmp/repo",
      query: "inbox",
      yes: true,
      interactive: true,
      showDecoratedOutput: false,
      isTTY: true,
    });

    expect(runTriage.mock.calls[0]?.[0].applyConfirmation).toBeTypeOf(
      "function",
    );
    expect(runTriage.mock.calls[0]?.[0].configureHubAgentRole).toBeTypeOf(
      "function",
    );
    expect(runTriage.mock.calls[0]?.[0].isTTY).toBe(true);
  });
});
