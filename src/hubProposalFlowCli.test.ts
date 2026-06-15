import { describe, expect, it, vi } from "vitest";

import * as hubPrdDecomposition from "./hubPrdDecomposition.js";
import { runPrdDecompositionProposalFlowFromCli } from "./hubProposalFlowCli.js";

describe("runPrdDecompositionProposalFlowFromCli", () => {
  it("dispatches to the PRD decomposition proposal flow runner", async () => {
    const runPrd = vi
      .spyOn(hubPrdDecomposition, "runPrdDecompositionFlow")
      .mockResolvedValue({
        outcome: "cancelled",
        runId: "run-1",
        runDir: "/tmp/run-1",
        phase: "approval",
      });

    await runPrdDecompositionProposalFlowFromCli({
      cwd: "/tmp/repo",
      prdRef: "docs/prd/feature.md",
      yes: true,
    });

    expect(runPrd).toHaveBeenCalledOnce();
    expect(runPrd.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/repo",
      prdRef: "docs/prd/feature.md",
      yes: true,
    });
  });
});
