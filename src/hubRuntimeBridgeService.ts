import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { readProposalSessionArtifacts } from "./hubProposalSession.js";
import { HUB_ENV_KNOWN_KEYS, readHubEnvFile, resolveHubEnvPath } from "./hubEnv.js";
import {
  listHubRunSummaries,
  resolveHubProjectStatus,
  type HubProjectStatus,
} from "./projectStatus.js";
import { loadHubTask, loadHubTaskBoard } from "./taskBoard.js";
import type {
  HubRuntimeAction,
  HubRuntimeActionPreview,
  HubRuntimeBridgeError,
  HubRuntimeBridgeResult,
  HubRuntimeRequest,
  HubRuntimeRequestMap,
  HubRuntimeResponseMap,
} from "./hubRuntimeBridge.js";
import { describeHubRuntimeAction } from "./hubRuntimeBridge.js";
import {
  createHubDesktopFixtureProjectStatus,
  createHubDesktopFixtureRunEvents,
  createHubDesktopFixtureRunSummaries,
  createHubDesktopFixtureTaskBoard,
  HUB_DESKTOP_FIXTURE_REPO_ROOT,
} from "./hubRuntimeBridgeFixtures.js";

export interface HubRuntimeBridgeServiceOptions {
  readonly cwd?: string;
  readonly useFixtures?: boolean;
}

const failure = <T>(
  error: HubRuntimeBridgeError,
): HubRuntimeBridgeResult<T> => ({
  ok: false,
  error,
});

const success = <T>(data: T): HubRuntimeBridgeResult<T> => ({
  ok: true,
  data,
});

const readJsonl = (filePath: string): readonly unknown[] => {
  if (!existsSync(filePath)) {
    return [];
  }

  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
};

const createConfirmToken = (
  action: HubRuntimeAction,
  params: Record<string, unknown>,
): string =>
  createHash("sha256")
    .update(JSON.stringify({ action, params }))
    .digest("hex");

const resolveCwd = (
  params: { readonly cwd?: string },
  options: HubRuntimeBridgeServiceOptions,
): string => params.cwd ?? options.cwd ?? process.cwd();

const cliFallbackForFailedAction = (
  action: HubRuntimeAction,
): string | undefined => {
  switch (action) {
    case "project.getStatus":
      return "archloop project status";
    case "taskBoard.load":
      return "archloop tasks list";
    default:
      return undefined;
  }
};

const buildRecoverPreview = (
  taskId: string,
  cwd: string,
  outcome = "ready_for_agent",
): HubRuntimeActionPreview => {
  const params = { taskId, cwd, outcome };
  return {
    action: "recover.execute",
    summary: `Recover task ${taskId} to ${outcome}`,
    confirmToken: createConfirmToken("recover.execute", params),
    cliFallback: `archloop tasks recover ${taskId}`,
  };
};

const buildSyncPreview = (
  action: "sync.pushExecute" | "sync.pullExecute",
  cwd: string,
): HubRuntimeActionPreview => {
  const params = { cwd };
  const verb = action === "sync.pushExecute" ? "push" : "pull";
  return {
    action,
    summary: `Sync tasks: ${verb} pending changes`,
    confirmToken: createConfirmToken(action, params),
    cliFallback: `archloop tasks ${verb}`,
  };
};

const buildTaskCreatePreview = (
  title: string,
  description: string | undefined,
  cwd: string,
): HubRuntimeActionPreview => {
  const params = { title, description, cwd };
  return {
    action: "task.createExecute",
    summary: `Create local Hub task "${title}"`,
    confirmToken: createConfirmToken("task.createExecute", params),
    cliFallback: `archloop tasks create --title "${title}"`,
  };
};

const readRunEvents = (runDir: string) => {
  const eventsDir = join(runDir, "events");
  const files = existsSync(eventsDir)
    ? readdirSync(eventsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
    : [];

  const events = files.flatMap((fileName) => {
    const filePath = join(eventsDir, fileName);
    return readJsonl(filePath).map((event, index) => ({
      file: fileName,
      lineNumber: index + 1,
      event,
    }));
  });

  return { runDir, events };
};

export const createHubRuntimeBridgeService = (
  options: HubRuntimeBridgeServiceOptions = {},
) => {
  const invoke = async <A extends HubRuntimeAction>(
    request: HubRuntimeRequest<A>,
  ): Promise<HubRuntimeBridgeResult<HubRuntimeResponseMap[A]>> => {
    const actionMeta = describeHubRuntimeAction(request.action);
    const params = request.params as HubRuntimeRequestMap[typeof request.action];
    const cwd = resolveCwd(
      "cwd" in params ? { cwd: params.cwd } : {},
      options,
    );

    if (options.useFixtures) {
      return invokeFixture(request);
    }

    try {
      switch (request.action) {
        case "project.getStatus":
          return success(
            resolveHubProjectStatus({ cwd }) as unknown as HubRuntimeResponseMap[A],
          );
        case "taskBoard.load":
          return success(loadHubTaskBoard(cwd) as unknown as HubRuntimeResponseMap[A]);
        case "task.get": {
          const taskParams = params as HubRuntimeRequestMap["task.get"];
          return success(
            loadHubTask(cwd, taskParams.taskId) as unknown as HubRuntimeResponseMap[A],
          );
        }
        case "run.listSummaries": {
          const status = resolveHubProjectStatus({ cwd });
          return success(
            listHubRunSummaries(status.hubProjectDir) as unknown as HubRuntimeResponseMap[A],
          );
        }
        case "run.readEvents": {
          const runParams = params as HubRuntimeRequestMap["run.readEvents"];
          return success(
            readRunEvents(runParams.runDir) as unknown as HubRuntimeResponseMap[A],
          );
        }
        case "proposal.readSession": {
          const proposalParams =
            params as HubRuntimeRequestMap["proposal.readSession"];
          if (!existsSync(proposalParams.runDir)) {
            return failure({
              code: "not_found",
              message: `Proposal session not found at ${proposalParams.runDir}`,
            });
          }
          return success(
            readProposalSessionArtifacts(
              proposalParams.runDir,
            ) as unknown as HubRuntimeResponseMap[A],
          );
        }
        case "config.getSummary": {
          const envValues = readHubEnvFile({ env: process.env });
          const configuredKeys = HUB_ENV_KNOWN_KEYS.filter(
            (key) => (envValues[key] ?? "").trim().length > 0,
          );
          const missingKeys = HUB_ENV_KNOWN_KEYS.filter(
            (key) => !configuredKeys.includes(key),
          );
          return success({
            hubEnvPath: resolveHubEnvPath({ env: process.env }),
            configuredKeys,
            missingKeys,
          } as unknown as HubRuntimeResponseMap[A]);
        }
        case "sync.getState": {
          const status = resolveHubProjectStatus({ cwd });
          return success({
            pushPending: status.syncCounts.pushPending,
            pullPending: 0,
            conflict: status.syncCounts.conflict,
            localOnly: status.syncCounts.localOnly,
            synced: status.syncCounts.synced,
            cliFallback: "archloop tasks sync",
          } as unknown as HubRuntimeResponseMap[A]);
        }
        case "recover.preview": {
          const recoverParams = params as HubRuntimeRequestMap["recover.preview"];
          const board = loadHubTaskBoard(cwd);
          const task = board.tasks.find(
            (entry) => entry.id === recoverParams.taskId,
          );
          if (!task) {
            return failure({
              code: "not_found",
              message: `Task ${recoverParams.taskId} not found`,
              cliFallback: "archloop tasks list",
            });
          }
          if (task.hubStatus !== "failed") {
            return success({
              action: "recover.execute",
              summary: `Task ${recoverParams.taskId} is not failed`,
              confirmToken: "",
              disabledReason: "Only failed tasks can be recovered from the Hub GUI.",
              cliFallback: `archloop tasks show ${recoverParams.taskId}`,
            } as unknown as HubRuntimeResponseMap[A]);
          }
          return success(
            buildRecoverPreview(
              recoverParams.taskId,
              cwd,
              recoverParams.outcome,
            ) as unknown as HubRuntimeResponseMap[A],
          );
        }
        case "sync.pushPreview":
          return success(
            buildSyncPreview("sync.pushExecute", cwd) as HubRuntimeResponseMap[A],
          );
        case "sync.pullPreview":
          return success(
            buildSyncPreview("sync.pullExecute", cwd) as HubRuntimeResponseMap[A],
          );
        case "task.createPreview": {
          const createParams =
            params as HubRuntimeRequestMap["task.createPreview"];
          if (createParams.title.trim().length === 0) {
            return failure({
              code: "invalid_request",
              message: "Task title is required",
            });
          }
          return success(
            buildTaskCreatePreview(
              createParams.title.trim(),
              createParams.description,
              cwd,
            ) as unknown as HubRuntimeResponseMap[A],
          );
        }
        case "recover.execute":
        case "sync.pushExecute":
        case "sync.pullExecute":
        case "task.createExecute": {
          const preview = buildPreviewForMutatingAction(
            request.action,
            params as HubRuntimeRequestMap[typeof request.action],
            cwd,
          );
          if (!preview) {
            return failure({
              code: "invalid_request",
              message: "Unable to build preview for mutating action",
            });
          }
          if (preview.disabledReason) {
            return failure({
              code: "action_disabled",
              message: preview.disabledReason,
              cliFallback: preview.cliFallback,
            });
          }
          const confirmToken = (
            params as { readonly confirmToken?: string }
          ).confirmToken;
          if (!confirmToken || confirmToken !== preview.confirmToken) {
            return failure({
              code: "confirm_invalid",
              message: "Confirm token is missing or invalid. Preview the action first.",
              cliFallback: preview.cliFallback,
            });
          }

          return success({
            status: "queued_for_cli",
            taskId:
              request.action === "recover.execute"
                ? (params as HubRuntimeRequestMap["recover.execute"]).taskId
                : undefined,
          } as unknown as HubRuntimeResponseMap[A]);
        }
        default:
          return failure({
            code: "invalid_request",
            message: `Unsupported action ${String(request.action)}`,
          });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Hub runtime bridge failed";
      return failure({
        code: actionMeta.kind === "read" ? "runtime_unavailable" : "command_failed",
        message,
        cliFallback: cliFallbackForFailedAction(request.action),
      });
    }
  };

  const buildPreviewForMutatingAction = (
    action: HubRuntimeAction,
    params: HubRuntimeRequestMap[HubRuntimeAction],
    cwd: string,
  ): HubRuntimeActionPreview | undefined => {
    switch (action) {
      case "recover.execute": {
        const recoverParams = params as HubRuntimeRequestMap["recover.execute"];
        return buildRecoverPreview(
          recoverParams.taskId,
          cwd,
          recoverParams.outcome,
        );
      }
      case "sync.pushExecute":
        return buildSyncPreview("sync.pushExecute", cwd);
      case "sync.pullExecute":
        return buildSyncPreview("sync.pullExecute", cwd);
      case "task.createExecute": {
        const createParams = params as HubRuntimeRequestMap["task.createExecute"];
        return buildTaskCreatePreview(
          createParams.title,
          createParams.description,
          cwd,
        );
      }
      default:
        return undefined;
    }
  };

  const invokeFixture = async <A extends HubRuntimeAction>(
    request: HubRuntimeRequest<A>,
  ): Promise<HubRuntimeBridgeResult<HubRuntimeResponseMap[A]>> => {
    const fixtureStatus = createHubDesktopFixtureProjectStatus();
    const fixtureBoard = createHubDesktopFixtureTaskBoard();
    const params = request.params as HubRuntimeRequestMap[typeof request.action];
    switch (request.action) {
      case "project.getStatus":
        return success(fixtureStatus as unknown as HubRuntimeResponseMap[A]);
      case "taskBoard.load":
        return success(fixtureBoard as unknown as HubRuntimeResponseMap[A]);
      case "task.get": {
        const taskParams = params as HubRuntimeRequestMap["task.get"];
        const task = fixtureBoard.tasks.find(
          (entry) => entry.id === taskParams.taskId,
        );
        if (!task) {
          return failure({
            code: "not_found",
            message: `Task ${taskParams.taskId} not found`,
          });
        }
        return success(task as unknown as HubRuntimeResponseMap[A]);
      }
      case "run.listSummaries":
        return success(
          createHubDesktopFixtureRunSummaries() as unknown as HubRuntimeResponseMap[A],
        );
      case "run.readEvents": {
        const runParams = params as HubRuntimeRequestMap["run.readEvents"];
        return success(
          createHubDesktopFixtureRunEvents({
            runDir: runParams.runDir,
          }) as unknown as HubRuntimeResponseMap[A],
        );
      }
      case "proposal.readSession":
        return failure({
          code: "not_found",
          message: "Fixture proposal session is unavailable",
        });
      case "config.getSummary":
        return success({
          hubEnvPath: "/tmp/archloop-user-data/.env",
          configuredKeys: ["GH_TOKEN"],
          missingKeys: ["CURSOR_API_KEY"],
        } as unknown as HubRuntimeResponseMap[A]);
      case "sync.getState":
        return success({
          pushPending: fixtureStatus.syncCounts.pushPending,
          pullPending: 0,
          conflict: fixtureStatus.syncCounts.conflict,
          localOnly: fixtureStatus.syncCounts.localOnly,
          synced: fixtureStatus.syncCounts.synced,
          cliFallback: "archloop tasks sync",
        } as HubRuntimeResponseMap[A]);
      case "recover.preview": {
        const recoverParams = params as HubRuntimeRequestMap["recover.preview"];
        return success(
          buildRecoverPreview(
            recoverParams.taskId,
            HUB_DESKTOP_FIXTURE_REPO_ROOT,
            recoverParams.outcome,
          ) as HubRuntimeResponseMap[A],
        );
      }
      case "sync.pushPreview":
        return success(
          buildSyncPreview(
            "sync.pushExecute",
            HUB_DESKTOP_FIXTURE_REPO_ROOT,
          ) as HubRuntimeResponseMap[A],
        );
      case "sync.pullPreview":
        return success(
          buildSyncPreview(
            "sync.pullExecute",
            HUB_DESKTOP_FIXTURE_REPO_ROOT,
          ) as HubRuntimeResponseMap[A],
        );
      case "task.createPreview": {
        const createParams = params as HubRuntimeRequestMap["task.createPreview"];
        return success(
          buildTaskCreatePreview(
            createParams.title,
            createParams.description,
            HUB_DESKTOP_FIXTURE_REPO_ROOT,
          ) as HubRuntimeResponseMap[A],
        );
      }
      case "recover.execute":
      case "sync.pushExecute":
      case "sync.pullExecute":
      case "task.createExecute": {
        const preview = buildPreviewForMutatingAction(
          request.action,
          params as HubRuntimeRequestMap[typeof request.action],
          HUB_DESKTOP_FIXTURE_REPO_ROOT,
        );
        const confirmToken = (
          params as { readonly confirmToken?: string }
        ).confirmToken;
        if (!preview || !confirmToken || confirmToken !== preview.confirmToken) {
          return failure({
            code: "confirm_invalid",
            message: "Confirm token is missing or invalid",
          });
        }
        return success({ status: "queued_for_cli" } as unknown as HubRuntimeResponseMap[A]);
      }
      default:
        return failure({
          code: "invalid_request",
          message: `Unsupported action ${String(request.action)}`,
        });
    }
  };

  return {
    invoke,
    getProjectStatus: (): HubProjectStatus =>
      options.useFixtures
        ? createHubDesktopFixtureProjectStatus()
        : resolveHubProjectStatus({ cwd: options.cwd }),
  };
};

export type HubRuntimeBridgeService = ReturnType<
  typeof createHubRuntimeBridgeService
>;
