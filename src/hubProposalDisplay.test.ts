import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PrdDecompositionProposal } from "./hubPrdDecomposition.js";
import {
  formatPrdProposalWarningsNote,
  formatProposalAgentPhaseDisplay,
  prdDecompositionCancelledMessage,
} from "./hubProposalDisplay.js";

const proposalWithWarnings = (): PrdDecompositionProposal => ({
  prdRef: "docs/prd/feature.md",
  prdTitle: "Feature",
  summary: "Two slices with warnings",
  slices: [
    {
      tempId: "slice-1",
      title: "Bootstrap",
      description: "Bootstrap CLI",
      sliceType: "AFK",
      acceptanceCriteria: ["CLI runs"],
      rationale: "Foundation",
    },
    {
      tempId: "slice-2",
      title: "Rollout",
      description: "Roll out feature",
      sliceType: "HITL",
      acceptanceCriteria: ["Users onboarded"],
      rationale: "Delivery",
    },
  ],
  dependencies: [],
  warnings: [
    {
      tempId: "slice-1",
      severity: "high",
      message: "Language unset.",
    },
    {
      tempId: "slice-2",
      severity: "medium",
      message: "Rollout checklist unclear.",
    },
  ],
});

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

  it("formats PRD proposal warnings note with high and medium sections", () => {
    const note = formatPrdProposalWarningsNote(proposalWithWarnings());

    expect(note).toContain("1 high");
    expect(note).toContain("1 medium");
    expect(note).toContain("HIGH");
    expect(note).toContain("MEDIUM");
    expect(note).toContain("slice-1");
    expect(note).toContain("Bootstrap");
    expect(note).toContain("Language unset.");
    expect(note).toContain("Rollout checklist unclear.");
  });
});
