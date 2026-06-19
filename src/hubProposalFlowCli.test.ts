import { describe, expect, it, vi } from "vitest";

import * as hubPrdDecomposition from "./hubPrdDecomposition.js";
import * as hubTriageProposalCli from "./hubTriageProposalCli.js";
import { runHubProposalFlowFromCli } from "./hubProposalFlowCli.js";

describe("runHubProposalFlowFromCli", () => {
  it("dispatches prd-decomposition input to the shared proposal flow runner", async () => {
    const runPrd = vi
      .spyOn(hubPrdDecomposition, "runPrdDecompositionFlow")
      .mockResolvedValue({
        outcome: "cancelled",
        runId: "run-1",
        runDir: "/tmp/run-1",
        phase: "approval",
      });

    await runHubProposalFlowFromCli({
      cwd: "/tmp/repo",
      yes: true,
      validatedInput: {
        flowId: "prd-decomposition",
        kind: "prd-file",
        ref: "docs/prd/feature.md",
        path: "/tmp/repo/docs/prd/feature.md",
        content: "# PRD: Feature",
      },
    });

    expect(runPrd).toHaveBeenCalledOnce();
    expect(runPrd.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/repo",
      prdRef: "docs/prd/feature.md",
      yes: true,
    });
  });

  it("dispatches triage input to the shared proposal flow runner", async () => {
    const runTriage = vi
      .spyOn(hubTriageProposalCli, "runTriageProposalFlowFromCli")
      .mockResolvedValue({
        outcome: "cancelled",
        runId: "run-1",
        runDir: "/tmp/run-1",
        phase: "approval",
      });

    await runHubProposalFlowFromCli({
      cwd: "/tmp/repo",
      yes: false,
      validatedInput: {
        flowId: "triage",
        kind: "task-query",
        selection: { type: "statuses", statuses: ["inbox", "needs_info"] },
        query: "inbox,needs_info",
      },
    });

    expect(runTriage).toHaveBeenCalledOnce();
    expect(runTriage.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/repo",
      query: "inbox,needs_info",
      yes: false,
    });
  });
});
