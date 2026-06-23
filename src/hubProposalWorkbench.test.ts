import { describe, expect, it } from "vitest";

import {
  buildHubProposalWorkbenchModel,
  filterProposalRunSummaries,
  resolveHubProposalWorkbenchGridClass,
  selectDefaultProposalRunDir,
} from "./hubProposalWorkbench.js";
import {
  createHubDesktopFixtureProposalRunSummaries,
  createHubDesktopFixtureProposalSessionArtifacts,
  createHubDesktopFixtureProposalSessionEvents,
} from "./hubRuntimeBridgeFixtures.js";
import { createHubDesktopFixtureProjectStatus } from "./hubRuntimeBridgeFixtures.js";
import type { PrdDecompositionProposal } from "./hubPrdDecomposition.js";

const invalidPrdProposal = (): PrdDecompositionProposal => ({
  prdRef: "docs/prd/broken.md",
  prdTitle: "Broken PRD",
  summary: "Missing acceptance criteria on one slice.",
  slices: [
    {
      tempId: "slice-1",
      title: "Slice without criteria",
      description: "Incomplete slice.",
      sliceType: "AFK",
      acceptanceCriteria: [],
      rationale: "Should fail validation.",
    },
  ],
  dependencies: [
    { dependentTempId: "slice-1", blockerTempId: "missing-slice" },
  ],
  warnings: [
    {
      tempId: "slice-1",
      severity: "high",
      message: "Guarded rollout decision required.",
    },
  ],
});

describe("hubProposalWorkbench", () => {
  it("builds a loading model before runtime data is available", () => {
    const model = buildHubProposalWorkbenchModel({ loading: true });
    expect(model.phase).toBe("loading");
    expect(model.taskCards).toEqual([]);
    expect(model.actions).toEqual([]);
  });

  it("surfaces runtime unavailable state with CLI fallback", () => {
    const model = buildHubProposalWorkbenchModel({
      runtimeError: "Bridge offline",
    });
    expect(model.phase).toBe("runtime_unavailable");
    expect(model.runtimeError).toBe("Bridge offline");
    expect(model.cliFallback).toBe("archloop tasks from-prd <ref>");
  });

  it("shows empty state when no proposal runs exist", () => {
    const model = buildHubProposalWorkbenchModel({
      runSummaries: [],
    });
    expect(model.phase).toBe("empty");
    expect(model.sessionOptions).toEqual([]);
  });

  it("reads proposal session artifacts from the runtime bridge", () => {
    const runSummaries = createHubDesktopFixtureProposalRunSummaries();
    const sessionArtifacts = createHubDesktopFixtureProposalSessionArtifacts();
    const model = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts,
      proposalEvents: createHubDesktopFixtureProposalSessionEvents().events,
    });

    expect(model.phase).toBe("ready");
    expect(model.metadata).toEqual(
      expect.objectContaining({
        flowId: "prd-decomposition",
        proposalStatus: "awaiting_approval",
        runDir: runSummaries[0]?.runDir,
      }),
    );
    expect(model.sourceContext?.highlights).toEqual(
      expect.arrayContaining([
        expect.stringContaining("docs/prd/hub-gui.md"),
      ]),
    );
    expect(model.taskCards).toHaveLength(2);
    expect(model.taskCards[0]).toEqual(
      expect.objectContaining({
        id: "slice-1",
        title: "Build proposal session slice",
        classification: "AFK",
        intendedHubStatus: "ready_for_agent",
      }),
    );
  });

  it("collects validation errors for schema, dependency, and guarded decisions", () => {
    const runSummaries = createHubDesktopFixtureProposalRunSummaries();
    const model = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts: {
        ...createHubDesktopFixtureProposalSessionArtifacts(),
        finalProposal: invalidPrdProposal(),
      },
      proposalEvents: createHubDesktopFixtureProposalSessionEvents().events,
    });

    expect(model.validationErrors.map((error) => error.kind)).toEqual(
      expect.arrayContaining([
        "missing_acceptance_criteria",
        "invalid_dependencies",
        "guarded_decision",
      ]),
    );
    expect(model.taskCards[0]?.validationState).toBe("error");
  });

  it("represents mutation detection and apply failure states", () => {
    const runSummaries = createHubDesktopFixtureProposalRunSummaries();
    const blocked = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts: {
        ...createHubDesktopFixtureProposalSessionArtifacts(),
        applyResult: {
          status: "blocked_mutations",
          reason: "Beads task store changed during proposal session.",
        },
      },
      proposalEvents: createHubDesktopFixtureProposalSessionEvents({
        includeMutationDetected: true,
      }).events,
    });
    expect(blocked.applyState?.status).toBe("blocked_mutations");
    expect(blocked.validationErrors).toContainEqual(
      expect.objectContaining({
        kind: "mutation_detection_failure",
      }),
    );

    const failed = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts: {
        ...createHubDesktopFixtureProposalSessionArtifacts(),
        applyResult: {
          status: "validation_failed",
          reason: "Duplicate slice temp ids: slice-1.",
        },
      },
      proposalEvents: createHubDesktopFixtureProposalSessionEvents().events,
    });
    expect(failed.applyState?.status).toBe("validation_failed");
    expect(failed.applyState?.nextStep).toContain("Refine");
  });

  it("represents successful apply with local-only next-step copy", () => {
    const runSummaries = createHubDesktopFixtureProposalRunSummaries();
    const model = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts: {
        ...createHubDesktopFixtureProposalSessionArtifacts(),
        applyResult: {
          status: "applied",
          taskIds: ["arch-10", "arch-11"],
        },
      },
      proposalEvents: createHubDesktopFixtureProposalSessionEvents({
        includeSessionCompleted: true,
      }).events,
      projectStatus: createHubDesktopFixtureProjectStatus(),
    });

    expect(model.applyState?.status).toBe("applied");
    expect(model.localWriteCopy).toContain("local Beads");
    expect(model.remoteSyncCopy).toContain("GitHub");
    expect(model.applyState?.artifactReferences).toEqual(
      expect.arrayContaining([expect.stringContaining("arch-10")]),
    );
  });

  it("exposes approve, reject, revise, and apply actions with disabled reasons", () => {
    const runSummaries = createHubDesktopFixtureProposalRunSummaries();
    const awaiting = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts: createHubDesktopFixtureProposalSessionArtifacts(),
      proposalEvents: createHubDesktopFixtureProposalSessionEvents().events,
      projectStatus: createHubDesktopFixtureProjectStatus(),
    });

    expect(awaiting.actions).toContainEqual(
      expect.objectContaining({
        id: "approve",
        kind: "cli_only",
        cliFallback: expect.stringContaining("archloop tasks from-prd"),
      }),
    );
    expect(awaiting.actions).toContainEqual(
      expect.objectContaining({
        id: "apply",
        disabledReason: expect.stringContaining("Approve"),
      }),
    );
    expect(awaiting.actions).toContainEqual(
      expect.objectContaining({
        id: "revise",
        kind: "cli_only",
      }),
    );

    const applied = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts: {
        ...createHubDesktopFixtureProposalSessionArtifacts(),
        applyResult: { status: "applied", taskIds: ["arch-10"] },
      },
      proposalEvents: createHubDesktopFixtureProposalSessionEvents({
        includeSessionCompleted: true,
      }).events,
      projectStatus: createHubDesktopFixtureProjectStatus(),
    });
    expect(
      applied.actions.find((action) => action.id === "approve")?.disabledReason,
    ).toContain("already applied");
  });

  it("disables apply when the local task store is unavailable", () => {
    const runSummaries = createHubDesktopFixtureProposalRunSummaries();
    const model = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts: {
        ...createHubDesktopFixtureProposalSessionArtifacts(),
        applyResult: { status: "pending" },
      },
      proposalEvents: createHubDesktopFixtureProposalSessionEvents({
        includeSessionCompleted: true,
      }).events,
      projectStatus: {
        ...createHubDesktopFixtureProjectStatus(),
        taskStoreInitialized: false,
      },
    });

    expect(
      model.actions.find((action) => action.id === "apply")?.disabledReason,
    ).toContain("task store");
  });

  it("filters proposal runs and selects the latest by default", () => {
    const summaries = createHubDesktopFixtureProposalRunSummaries();
    const proposalRuns = filterProposalRunSummaries(summaries);
    expect(proposalRuns).toHaveLength(1);
    expect(selectDefaultProposalRunDir(summaries)).toBe(
      proposalRuns[0]?.runDir,
    );
  });

  it("uses stacked grid class on narrow viewports", () => {
    expect(resolveHubProposalWorkbenchGridClass(1440)).toBe("hub-proposal-grid");
    expect(resolveHubProposalWorkbenchGridClass(700)).toBe(
      "hub-proposal-grid hub-proposal-grid-narrow",
    );
  });

  it("exposes accessible action labels for keyboard focus targets", () => {
    const runSummaries = createHubDesktopFixtureProposalRunSummaries();
    const model = buildHubProposalWorkbenchModel({
      runSummaries,
      selectedRunDir: runSummaries[0]?.runDir,
      sessionArtifacts: createHubDesktopFixtureProposalSessionArtifacts(),
      proposalEvents: createHubDesktopFixtureProposalSessionEvents().events,
      projectStatus: createHubDesktopFixtureProjectStatus(),
    });

    for (const action of model.actions) {
      expect(action.label.trim().length).toBeGreaterThan(0);
      expect(action.description.trim().length).toBeGreaterThan(0);
    }
  });
});
