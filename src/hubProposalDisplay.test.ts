import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatProposalAgentPhaseDisplay,
  prdDecompositionCancelledMessage,
} from "./hubProposalDisplay.js";

describe("hubProposalDisplay", () => {
  it("formats agent output with log and transcript paths", () => {
    const display = formatProposalAgentPhaseDisplay({
      phase: "draft",
      flowId: "prd-decomposition",
      message: "Slice 1: bootstrap CLI",
      runDir: "/tmp/run-1",
    });

    expect(display).toContain("Slice 1: bootstrap CLI");
    expect(display).toContain(
      join("/tmp/run-1", "logs", "prd-decomposition-draft.log"),
    );
    expect(display).toContain(
      join("/tmp/run-1", "artifacts", "transcript.json"),
    );
  });

  it("uses phase-specific cancellation messages", () => {
    expect(prdDecompositionCancelledMessage("approval")).toContain(
      "before creating Beads tasks",
    );
    expect(prdDecompositionCancelledMessage("refinement")).toContain(
      "during refinement",
    );
  });
});
