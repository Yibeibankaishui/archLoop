import { describe, expect, it } from "vitest";

import type { HubProjectStatus } from "./projectStatus.js";
import {
  formatHubProjectListLines,
  formatHubProjectListProjectionLines,
  resolveHubProjectListProjections,
} from "./hubProjectList.js";
import type { HubProjectListEntry } from "./hubProjectRegistry.js";

const createProject = (
  overrides: Partial<HubProjectListEntry> & Pick<HubProjectListEntry, "id" | "name">,
): HubProjectListEntry => ({
  id: overrides.id,
  name: overrides.name,
  repoRoot: overrides.repoRoot ?? "/tmp/repo",
  hubProjectDir: overrides.hubProjectDir ?? "/tmp/data/archloop/hub/projects/demo",
  projectProfile: overrides.projectProfile ?? "generic",
  createdAt: overrides.createdAt ?? "2026-07-04T12:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-07-04T12:00:00.000Z",
  selected: overrides.selected ?? false,
});

const createStatus = (
  overrides: Partial<HubProjectStatus> = {},
): HubProjectStatus => ({
  repoRoot: "/tmp/repo",
  archloopUserDataDir: "/tmp/data/archloop",
  hubProjectDir: "/tmp/data/archloop/hub/projects/demo",
  projectProfile: "generic",
  projectDevelopmentContractPath:
    "/tmp/data/archloop/hub/projects/demo/development-contract.json",
  projectDevelopmentContractPersisted: true,
  projectRegistered: true,
  beadsAvailable: true,
  taskStoreInitialized: true,
  taskCounts: { ready: 2, total: 7 },
  statusCounts: { failed: 1 },
  failedTasks: [],
  syncCounts: {
    pushPending: 0,
    conflict: 0,
    localOnly: 0,
    synced: 0,
  },
  activeBatches: [
    {
      runId: "run-1",
      batchId: "batch-1",
      runDir: "/tmp/data/archloop/hub/projects/demo/runs/run-1",
      status: "planned",
      active: true,
    },
    {
      runId: "run-2",
      batchId: "batch-2",
      runDir: "/tmp/data/archloop/hub/projects/demo/runs/run-2",
      status: "started",
      active: true,
    },
  ],
  runDirectories: [],
  recentEvents: [],
  worktreeLeaseDiagnostics: [],
  ...overrides,
});

describe("hubProjectList", () => {
  it("projects registry entries into a reusable readiness view", () => {
    const projects = [
      {
        ...createProject({
          id: "project-alpha",
          name: "alpha",
          repoRoot: "/tmp/repo-alpha",
          projectProfile: "generic",
        }),
        selected: true,
      },
      {
        ...createProject({
          id: "project-beta",
          name: "beta",
          repoRoot: "/tmp/repo-beta",
          projectProfile: "python",
        }),
        selected: false,
      },
    ];

    const projections = resolveHubProjectListProjections(projects, {
      pathExists: (path) => path !== "/tmp/repo-beta",
      resolveProjectStatus: () => createStatus(),
    });

    expect(projections).toHaveLength(2);

    const alpha = projections[0]!;
    const beta = projections[1]!;
    expect(alpha).toMatchObject({
      name: "alpha",
      repoRoot: "/tmp/repo-alpha",
      projectProfile: "generic",
      selected: true,
      pathStatus: "valid",
      activeRunCount: 2,
    });
    expect(alpha.taskStatus).toMatchObject({
      state: "ready",
      counts: { ready: 2, failed: 1, total: 7 },
    });
    const alphaLines = formatHubProjectListProjectionLines(alpha).join("\n");
    expect(alphaLines).toContain("alpha [generic] (selected)");
    expect(alphaLines).toContain("path: valid");
    expect(alphaLines).toContain("tasks: ready 2 / failed 1 / total 7");
    expect(alphaLines).toContain("runs: active (2)");

    expect(beta).toMatchObject({
      name: "beta",
      repoRoot: "/tmp/repo-beta",
      projectProfile: "python",
      selected: false,
      pathStatus: "missing",
      activeRunCount: 0,
    });
    expect(beta.taskStatus).toMatchObject({
      state: "missing_repo_path",
    });
    const betaLines = formatHubProjectListProjectionLines(beta).join("\n");
    expect(betaLines).toContain("beta [python]");
    expect(betaLines).toContain("path: missing");
    expect(betaLines).toContain("tasks: repo path missing");
    expect(betaLines).toContain("runs: none");
  });

  it("labels missing task stores and unavailable runtimes separately", () => {
    const projections = resolveHubProjectListProjections(
      [
        {
          ...createProject({ id: "project-gamma", name: "gamma" }),
          selected: false,
        },
        {
          ...createProject({
            id: "project-delta",
            name: "delta",
            repoRoot: "/tmp/repo-delta",
            projectProfile: "node",
          }),
          selected: false,
        },
      ],
      {
        pathExists: () => true,
        resolveProjectStatus: (project) =>
          project.name === "gamma"
            ? createStatus({
                beadsAvailable: true,
                taskStoreInitialized: false,
                taskCounts: { ready: 0, total: 0 },
                statusCounts: {},
                activeBatches: [],
              })
            : createStatus({
                beadsAvailable: false,
                taskStoreInitialized: false,
                taskCounts: { ready: 0, total: 0 },
                statusCounts: {},
                activeBatches: [],
              }),
      },
    );

    const output = formatHubProjectListLines(projections).join("\n");
    expect(output).toContain("tasks: local task store missing");
    expect(output).toContain("tasks: archLoop task runtime unavailable");
  });

  it("returns a concise empty-registry summary", () => {
    expect(resolveHubProjectListProjections([])).toEqual([]);
    expect(formatHubProjectListLines([])).toEqual([
      "No Hub projects registered.",
    ]);
  });
});
