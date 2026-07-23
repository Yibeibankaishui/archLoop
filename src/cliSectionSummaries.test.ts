import { describe, expect, it } from "vitest";

import {
  buildHubTaskCreateSummaryModel,
  hubTaskCreateSummaryModelToBlocks,
} from "./taskBoard.js";
import {
  buildHubTaskRecoverSummaryModel,
  hubTaskRecoverSummaryModelToBlocks,
} from "./hubTaskRecover.js";
import {
  buildHubProjectRegisterSummaryModel,
  buildHubProjectRelinkSummaryModel,
  buildHubProjectRenameSummaryModel,
  hubProjectRegisterSummaryModelToBlocks,
  hubProjectRelinkSummaryModelToBlocks,
  hubProjectRenameSummaryModelToBlocks,
} from "./hubProjectRegistry.js";
import {
  buildHubProjectListSummaryModel,
  hubProjectListSummaryModelToBlocks,
  type HubProjectListProjection,
} from "./hubProjectList.js";
import {
  buildHubProjectConfigureSummaryModel,
  hubProjectConfigureSummaryModelToBlocks,
  type ConfigureHubProjectDevelopmentContractResult,
} from "./hubProjectDevelopmentContract.js";
import {
  buildHubAgentConfigInitSummaryModel,
  buildHubAgentConfigSetRoleSummaryModel,
  hubAgentConfigInitSummaryModelToBlocks,
  hubAgentConfigSetRoleSummaryModelToBlocks,
} from "./hubAgentConfig.js";
import {
  buildHubEnvSetSummaryModel,
  hubEnvSetSummaryModelToBlocks,
} from "./hubEnv.js";
import {
  buildHubAuthLoginSummaryModel,
  hubAuthLoginSummaryModelToBlocks,
} from "./hubAuth.js";
import {
  buildHubProjectStatusSummaryModel,
  hubProjectStatusSummaryModelToBlocks,
  type HubProjectStatus,
} from "./projectStatus.js";

const baseStatus = (
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
  taskCounts: { ready: 4, total: 12 },
  statusCounts: { failed: 1 },
  failedTasks: [],
  syncCounts: {
    pushPending: 0,
    conflict: 0,
    localOnly: 0,
    synced: 0,
  },
  activeBatches: [],
  runDirectories: [],
  recentEvents: [],
  worktreeLeaseDiagnostics: [],
  ...overrides,
});

describe("cli section summary models", () => {
  describe("hubTaskCreateSummaryModel", () => {
    it("emits header + kv + footer with an optional kind row", () => {
      const withKind = buildHubTaskCreateSummaryModel({
        id: "bd-42",
        title: "Track the flake",
        origin: "manual",
        kind: "slice",
      });

      expect(withKind.header).toEqual({
        kind: "header",
        title: "archLoop",
        subtitle: "tasks · create",
        right: "bd-42",
      });
      expect(withKind.identity.rows).toEqual([
        { key: "id", value: "bd-42" },
        { key: "title", value: "Track the flake" },
        { key: "origin", value: "manual" },
        { key: "kind", value: "slice" },
      ]);
      expect(withKind.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop tasks show bd-42",
      });

      const withoutKind = buildHubTaskCreateSummaryModel({
        id: "bd-7",
        title: "Add tests",
        origin: "manual",
      });
      expect(withoutKind.identity.rows.map((row) => row.key)).toEqual([
        "id",
        "title",
        "origin",
      ]);
    });

    it("converts to a stable block sequence with a 12-wide kv gutter", () => {
      const model = buildHubTaskCreateSummaryModel({
        id: "bd-99",
        title: "T",
        origin: "manual",
      });
      const blocks = hubTaskCreateSummaryModelToBlocks(model);
      expect(blocks.map((block) => block.kind)).toEqual([
        "header",
        "kv",
        "footer",
      ]);
      expect(model.identity.gutter).toBe(12);
    });
  });

  describe("hubTaskRecoverSummaryModel", () => {
    it("returns header + kv + summary + footer", () => {
      const model = buildHubTaskRecoverSummaryModel({
        taskId: "bd-42",
        result: {
          outcome: "released_claim",
          priorStatus: "implementing",
          hubStatus: "ready_for_agent",
          summary: "Released stale claim held for 4h.",
          task: {} as never,
        },
      });

      expect(model.header.right).toBe("released_claim");
      expect(model.header.subtitle).toBe("tasks · recover · bd-42");
      expect(model.identity.rows).toEqual([
        { key: "outcome", value: "released_claim" },
        { key: "prior status", value: "implementing" },
        { key: "hub status", value: "ready_for_agent" },
      ]);
      expect(model.summary).toEqual({
        kind: "prose",
        title: "summary",
        body: "Released stale claim held for 4h.",
      });
      expect(model.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop tasks show bd-42",
      });

      const blocks = hubTaskRecoverSummaryModelToBlocks(model);
      expect(blocks.map((block) => block.kind)).toEqual([
        "header",
        "kv",
        "prose",
        "footer",
      ]);
    });
  });

  describe("hubProjectStatusSummaryModel", () => {
    it("includes identity + detail + tip footer", () => {
      const model = buildHubProjectStatusSummaryModel({
        status: baseStatus(),
        cleanupDiagnosticsLines: [],
      });
      expect(model.header.subtitle).toBe("project · status");
      expect(model.header.right).toBe("ready 4 / total 12");
      const rowKeys = model.identity.rows.map((row) => row.key);
      expect(rowKeys).toContain("Repository root");
      expect(rowKeys).toContain("Hub project profile");
      expect(rowKeys).toContain("Hub project development contract");
      expect(rowKeys).toContain("Beads available");
      expect(rowKeys).toContain("Task store initialized");
      expect(rowKeys).toContain("Task board ready");
      expect(rowKeys).toContain("Task board total");
      expect(model.footer).toEqual({
        kind: "footer",
        label: "tip",
        commands: ["archloop tasks list", "archloop check"],
      });

      const blocks = hubProjectStatusSummaryModelToBlocks(model);
      // header, kv, optional detail, footer
      expect(blocks[0]?.kind).toBe("header");
      expect(blocks[1]?.kind).toBe("kv");
      expect(blocks[blocks.length - 1]?.kind).toBe("footer");
    });
  });

  describe("hubProjectRegisterSummaryModel", () => {
    it("uses next=tasks list when task store initialized", () => {
      const model = buildHubProjectRegisterSummaryModel({
        result: {
          project: {
            id: "prj-abc",
            name: "alpha",
            repoRoot: "/tmp/repo-alpha",
            hubProjectDir: "/tmp/data/archloop/hub/projects/prj-abc",
            projectProfile: "generic",
            createdAt: "2026-07-04T15:00:00.000Z",
            updatedAt: "2026-07-04T15:00:00.000Z",
          },
          selectedProjectId: "prj-abc",
          projectDevelopmentContractPath:
            "/tmp/data/archloop/hub/projects/prj-abc/development-contract.json",
          taskStoreInitialized: true,
        },
        taskStoreInitialized: true,
      });
      expect(model.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop tasks list",
      });
      const rowMap = new Map(
        model.identity.rows.map((row) => [row.key, row.value]),
      );
      expect(rowMap.get("Name")).toBe("alpha");
      expect(rowMap.get("Task store initialized")).toBe("yes");
      expect(
        hubProjectRegisterSummaryModelToBlocks(model).map((b) => b.kind),
      ).toEqual(["header", "kv", "footer"]);
    });

    it("uses next=tasks init when task store not initialized", () => {
      const model = buildHubProjectRegisterSummaryModel({
        result: {
          project: {
            id: "prj-abc",
            name: "alpha",
            repoRoot: "/tmp/repo-alpha",
            hubProjectDir: "/tmp/data/archloop/hub/projects/prj-abc",
            projectProfile: "generic",
            createdAt: "2026-07-04T15:00:00.000Z",
            updatedAt: "2026-07-04T15:00:00.000Z",
          },
          selectedProjectId: "prj-abc",
          projectDevelopmentContractPath:
            "/tmp/data/archloop/hub/projects/prj-abc/development-contract.json",
          taskStoreInitialized: false,
        },
        taskStoreInitialized: false,
      });
      expect(model.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop tasks init",
      });
    });
  });

  describe("hubProjectRenameSummaryModel", () => {
    it("captures previous + new names and points to project list", () => {
      const model = buildHubProjectRenameSummaryModel({
        project: {
          id: "prj-abc",
          name: "omega",
          repoRoot: "/tmp/repo",
          hubProjectDir: "/tmp/data/archloop/hub/projects/prj-abc",
          projectProfile: "generic",
          createdAt: "2026-07-04T15:00:00.000Z",
          updatedAt: "2026-07-04T16:00:00.000Z",
        },
        previousProjectName: "alpha",
      });
      const rows = new Map(
        model.identity.rows.map((row) => [row.key, row.value]),
      );
      expect(rows.get("Previous name")).toBe("alpha");
      expect(rows.get("New name")).toBe("omega");
      expect(model.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop project list",
      });
      expect(
        hubProjectRenameSummaryModelToBlocks(model).map((b) => b.kind),
      ).toEqual(["header", "kv", "footer"]);
    });
  });

  describe("hubProjectRelinkSummaryModel", () => {
    it("captures previous + new repo roots and points to project status", () => {
      const model = buildHubProjectRelinkSummaryModel({
        project: {
          id: "prj-abc",
          name: "omega",
          repoRoot: "/tmp/repo-b",
          hubProjectDir: "/tmp/data/archloop/hub/projects/prj-abc",
          projectProfile: "generic",
          createdAt: "2026-07-04T15:00:00.000Z",
          updatedAt: "2026-07-04T17:00:00.000Z",
        },
        previousRepoRoot: "/tmp/repo-a",
      });
      const rows = new Map(
        model.identity.rows.map((row) => [row.key, row.value]),
      );
      expect(rows.get("Previous repo root")).toBe("/tmp/repo-a");
      expect(rows.get("New repo root")).toBe("/tmp/repo-b");
      expect(model.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop project status",
      });
      expect(
        hubProjectRelinkSummaryModelToBlocks(model).map((b) => b.kind),
      ).toEqual(["header", "kv", "footer"]);
    });
  });

  describe("hubProjectListSummaryModel", () => {
    it("renders count + selected + detail lines", () => {
      const projections: HubProjectListProjection[] = [
        {
          id: "prj-a",
          name: "alpha",
          repoRoot: "/tmp/alpha",
          hubProjectDir: "/tmp/data/archloop/hub/projects/prj-a",
          projectProfile: "generic",
          createdAt: "2026-07-04T15:00:00.000Z",
          updatedAt: "2026-07-04T15:00:00.000Z",
          selected: true,
          pathStatus: "valid",
          taskStatus: { state: "missing_task_store" },
          activeRunCount: 0,
        },
      ];
      const model = buildHubProjectListSummaryModel(projections);
      expect(model.header.subtitle).toBe("project · list");
      expect(model.header.right).toBe("1 project");
      const rows = new Map(
        model.identity.rows.map((row) => [row.key, row.value]),
      );
      expect(rows.get("Projects")).toBe("1");
      expect(rows.get("Selected")).toBe("alpha");
      expect(model.detail.body).toContain("alpha");
      expect(model.footer).toEqual({
        kind: "footer",
        label: "tip",
        commands: ["archloop project select <name>", "archloop project status"],
      });
      expect(
        hubProjectListSummaryModelToBlocks(model).map((b) => b.kind),
      ).toEqual(["header", "kv", "prose", "footer"]);
    });

    it("uses plural project label for zero/many", () => {
      const empty = buildHubProjectListSummaryModel([]);
      expect(empty.header.right).toBe("0 projects");
    });
  });

  describe("hubProjectConfigureSummaryModel", () => {
    it("captures repo root + project profile + backup", () => {
      const contract: ConfigureHubProjectDevelopmentContractResult = {
        contractPath:
          "/tmp/data/archloop/hub/projects/prj-abc/development-contract.json",
        contract: {
          version: 1,
          projectProfile: "node",
          projectFacts: {
            observedFiles: ["package.json"],
            configuredScripts: ["test", "typecheck"],
          },
          setup: [],
          verify: ["npm run typecheck"],
          context: [],
        } as never,
        persisted: true,
        backupPath:
          "/tmp/data/archloop/hub/projects/prj-abc/development-contract.backup.json",
        projectProfileChanged: true,
        preservedUserEdits: false,
        refreshedProjectFacts: true,
      };
      const model = buildHubProjectConfigureSummaryModel({
        repoRoot: "/tmp/repo",
        hubProjectDir: "/tmp/data/archloop/hub/projects/prj-abc",
        contract,
        editOutcome: "replaced for the new project profile",
      });
      const rows = new Map(
        model.identity.rows.map((row) => [row.key, row.value]),
      );
      expect(rows.get("Hub project profile")).toBe("node");
      expect(rows.get("Repository root")).toBe("/tmp/repo");
      expect(rows.get("Hub project development contract")).toBe(
        contract.contractPath,
      );
      expect(rows.get("Project facts refreshed")).toContain("package.json");
      expect(rows.get("User-edited setup/verify/context")).toBe(
        "replaced for the new project profile",
      );
      expect(rows.get("Previous contract backup")).toBe(contract.backupPath);
      expect(rows.get("Outcome")).toBe("replaced (backup created)");
      expect(model.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop project status",
      });
      expect(
        hubProjectConfigureSummaryModelToBlocks(model).map((b) => b.kind),
      ).toEqual(["header", "kv", "footer"]);
    });
  });

  describe("hubAgentConfigSetRoleSummaryModel", () => {
    it("captures provider + model + optional options", () => {
      const model = buildHubAgentConfigSetRoleSummaryModel({
        role: "planning",
        entry: {
          provider: "codex",
          model: "gpt-5.4-mini",
          options: { effort: "medium" },
        },
      });
      expect(model.header.subtitle).toBe("agent-config · set-role · planning");
      expect(model.header.right).toBe("codex");
      const rows = new Map(
        model.identity.rows.map((row) => [row.key, row.value]),
      );
      expect(rows.get("Role")).toBe("planning");
      expect(rows.get("Provider")).toBe("codex");
      expect(rows.get("Model")).toBe("gpt-5.4-mini");
      expect(rows.get("Options")).toBe("effort=medium");
      expect(model.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop agent-config show",
      });
      expect(
        hubAgentConfigSetRoleSummaryModelToBlocks(model).map((b) => b.kind),
      ).toEqual(["header", "kv", "footer"]);
    });

    it("shows (none) when the role has no options", () => {
      const model = buildHubAgentConfigSetRoleSummaryModel({
        role: "planning",
        entry: { provider: "codex", model: "gpt-5.4" },
      });
      const rows = new Map(
        model.identity.rows.map((row) => [row.key, row.value]),
      );
      expect(rows.get("Options")).toBe("(none)");
    });
  });

  describe("hubAgentConfigInitSummaryModel", () => {
    it("reports configured role count + config path", () => {
      const model = buildHubAgentConfigInitSummaryModel({
        config: {
          roles: {
            planning: { provider: "codex", model: "gpt-5" },
            triage: { provider: "codex", model: "gpt-5" },
          },
        },
        configPath: "/tmp/data/archloop/hub/agent-roles.json",
      });
      expect(model.header.subtitle).toBe("agent-config · init");
      expect(model.header.right).toBe("2/6 roles");
      const rows = new Map(
        model.identity.rows.map((row) => [row.key, row.value]),
      );
      expect(rows.get("Roles configured")).toBe("2 of 6");
      expect(rows.get("Config")).toBe(
        "/tmp/data/archloop/hub/agent-roles.json",
      );
      expect(model.footer.label).toBe("next");
      expect(
        hubAgentConfigInitSummaryModelToBlocks(model).map((b) => b.kind),
      ).toEqual(["header", "kv", "footer"]);
    });
  });

  describe("hubEnvSetSummaryModel", () => {
    it("captures key + path with next=env show", () => {
      const model = buildHubEnvSetSummaryModel({
        key: "CURSOR_API_KEY",
        path: "/tmp/data/archloop/.env",
      });
      expect(model.header.subtitle).toBe("env · set");
      expect(model.header.right).toBe("CURSOR_API_KEY");
      expect(model.identity.rows).toEqual([
        { key: "Key", value: "CURSOR_API_KEY" },
        { key: "Path", value: "/tmp/data/archloop/.env" },
      ]);
      expect(model.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop env show",
      });
      expect(hubEnvSetSummaryModelToBlocks(model).map((b) => b.kind)).toEqual([
        "header",
        "kv",
        "footer",
      ]);
    });
  });

  describe("hubAuthLoginSummaryModel", () => {
    it("captures provider display name + auth dir env var", () => {
      const codex = buildHubAuthLoginSummaryModel({
        provider: "codex",
        envVar: "CODEX_HOME",
        authDir: "/tmp/data/archloop/hub/auth/codex",
      });
      expect(codex.header.right).toBe("Codex auth saved");
      expect(codex.identity.rows).toEqual([
        { key: "Provider", value: "Codex" },
        { key: "CODEX_HOME", value: "/tmp/data/archloop/hub/auth/codex" },
      ]);
      expect(codex.footer).toEqual({
        kind: "footer",
        label: "next",
        command: "archloop auth show",
      });

      const github = buildHubAuthLoginSummaryModel({
        provider: "github",
        envVar: "GH_CONFIG_DIR",
        authDir: "/tmp/data/archloop/hub/auth/github",
      });
      expect(github.header.right).toBe("GitHub auth saved");
      expect(
        hubAuthLoginSummaryModelToBlocks(github).map((b) => b.kind),
      ).toEqual(["header", "kv", "footer"]);
    });
  });
});
