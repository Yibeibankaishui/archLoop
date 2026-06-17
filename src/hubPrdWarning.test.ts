import { describe, expect, it } from "vitest";

import {
  formatHighSeverityValidationMessage,
  formatPrdWarningDescriptionSection,
  formatProposalWarningsDisplay,
  indexWarningsByTempId,
  prdWarningLabelForSeverity,
  readPrdWarningFromMetadata,
  summarizePrdWarnings,
} from "./hubPrdWarning.js";
import type { PrdProposalWarning } from "./hubPrdDecomposition.js";

const warnings = (): readonly PrdProposalWarning[] => [
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
];

describe("hubPrdWarning", () => {
  it("indexes warnings by slice temp id keeping the highest severity", () => {
    const indexed = indexWarningsByTempId([
      { tempId: "slice-1", severity: "low", message: "minor" },
      { tempId: "slice-1", severity: "high", message: "Language unset." },
    ]);

    expect(indexed.get("slice-1")).toEqual({
      severity: "high",
      message: "Language unset.",
    });
  });

  it("summarizes warning counts by severity", () => {
    expect(summarizePrdWarnings(warnings())).toEqual({
      high: 1,
      medium: 1,
      low: 0,
      total: 2,
    });
  });

  it("formats a description section for warned slices", () => {
    expect(
      formatPrdWarningDescriptionSection({
        severity: "high",
        message: "Language unset.",
      }),
    ).toBe("## PRD warning\n- **[high]** Language unset.");
  });

  it("reads persisted warning fields from task metadata", () => {
    expect(
      readPrdWarningFromMetadata({
        slice_temp_id: "slice-1",
        warning_severity: "high",
        warning_message: "Language unset.",
      }),
    ).toEqual({
      sliceTempId: "slice-1",
      severity: "high",
      message: "Language unset.",
    });
  });

  it("maps severity to Beads labels", () => {
    expect(prdWarningLabelForSeverity("high")).toBe("prd-warning-high");
  });

  it("formats grouped warning display lines", () => {
    const lines = formatProposalWarningsDisplay({
      warnings: warnings(),
      sliceTitleByTempId: new Map([
        ["slice-1", "Bootstrap"],
        ["slice-2", "Rollout"],
      ]),
    });

    expect(lines.join("\n")).toContain("1 high");
    expect(lines.join("\n")).toContain("[high] slice-1");
    expect(lines.join("\n")).toContain("Bootstrap");
  });

  it("formats classified_ready validation failures with each high warning", () => {
    const message = formatHighSeverityValidationMessage(warnings());

    expect(message).toContain("High-severity warnings block");
    expect(message).toContain("[high] slice-1: Language unset.");
    expect(message).not.toContain("medium");
  });
});
