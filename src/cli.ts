import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import * as clack from "@clack/prompts";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { styleText } from "node:util";

import { Display, type DisplayService } from "./Display.js";
import {
  buildDockerRootHostNextStepLines,
  resolveDockerUidBuildArgs,
  ROOT_HOST_DOCKER_UID_GUIDANCE,
} from "./dockerUidBuildArgs.js";
import { inspectGitRemotes } from "./inspectGitRemotes.js";
import { githubIssuesGitRemoteNextStepLines } from "./initGitRemoteGuidance.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  listBacklogManagers,
  getBacklogManager,
  listInitSandboxProviders,
  getInitSandboxProvider,
  getNextStepsLines,
  listAgentRuntimes,
  getAgentRuntime,
  collectAuthRequirements,
  formatProjectProfileNames,
  getProjectProfile,
  listProjectProfiles,
  DEFAULT_PROJECT_PROFILE,
  DEFAULT_PROJECT_PROFILE_NAME,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import type {
  AgentEntry,
  AgentRuntimeEntry,
  BacklogManagerEntry,
  ProjectProfileEntry,
  SandboxProviderEntry,
} from "./InitService.js";
import {
  ConfigDirError,
  HubFlowError,
  HubAgentConfigError,
  HubAuthError,
  HubEnvError,
  HubProjectRegistryError,
  InitError,
  ProjectStatusError,
  TaskBoardError,
} from "./errors.js";
import {
  getCapabilityPackDefinition,
  listCapabilityAddonPromptOptions,
  listCapabilityPacksForInit,
  MINIPROGRAM_CAPABILITY_PACK_ID,
  DEFAULT_CAPABILITY_PACK_ID,
  resolveCapabilityInitOptions,
  validateCapabilityTemplateSelection,
  type CapabilityPackDefinition,
  type ResolvedCapabilityInit,
} from "./capabilityPacks.js";
import { detectMiniprogramInitSnapshot } from "./miniprogramScaffold.js";
import {
  getPresetAgentDefinition,
  listPresetAgentsForInit,
} from "./presetAgents.js";
import {
  resolveGitRepoRoot,
  buildHubProjectStatusSummaryModel,
  hubProjectStatusSummaryModelToBlocks,
  resolveHubProjectStatus,
} from "./projectStatus.js";
import {
  buildHubProjectListSummaryModel,
  hubProjectListSummaryModelToBlocks,
  resolveHubProjectListProjections,
} from "./hubProjectList.js";
import {
  collectHubReadinessChecks,
  formatHubReadinessCheckLines,
} from "./hubReadinessCheck.js";
import {
  collectHubProjectReadinessCheck,
  formatHubProjectReadinessCheckLines,
} from "./hubProjectReadinessCheck.js";
import {
  buildHubProjectRegisterSummaryModel,
  buildHubProjectRelinkSummaryModel,
  buildHubProjectRenameSummaryModel,
  hubProjectRegisterSummaryModelToBlocks,
  hubProjectRelinkSummaryModelToBlocks,
  hubProjectRenameSummaryModelToBlocks,
  listHubProjects,
  registerHubProject,
  relinkHubProject,
  renameHubProject,
  readSelectedHubProject,
  selectHubProject,
  type HubProjectRegistryEntry,
  type HubProjectListEntry,
} from "./hubProjectRegistry.js";
import { resolveHubProjectTarget } from "./hubProjectTargetResolver.js";
import {
  formatHubProjectProfileRecommendation,
  recommendHubProjectProfile,
  resolveHubProjectRegistrationRepoRoot,
  suggestHubProjectName,
} from "./hubProjectOnboarding.js";
import {
  buildHubProjectConfigureSummaryModel,
  configureHubProjectDevelopmentContract,
  hubProjectConfigureSummaryModelToBlocks,
} from "./hubProjectDevelopmentContract.js";
import {
  createHubFlowRunImplementer,
  createHubFlowRunReviewer,
  formatHubFlowResultLines,
  parseHubFlowIdleTimeoutSeconds,
  parseHubFlowMaxBatches,
  runHubFlow,
} from "./hubFlowExecution.js";
import type { HubRunEvent } from "./hubExecution.js";
import {
  createHubRunDisplayState,
  formatPlainHubRunCancellation,
  formatPlainHubRunEvent,
  formatPlainHubRunFailure,
  formatPlainHubRunOutcome,
  projectHubRunOutcome,
  projectHubRunStateOutcome,
  reduceHubRunDisplayState,
} from "./hubRunDisplay.js";
import { createHubRunJsonRenderer } from "./hubRunJsonDisplay.js";
import {
  createHubRunLiveDisplay,
  shouldUseAltScreenDashboard,
} from "./hubRunLiveDisplay.js";
import {
  acceptsHubProposalPresentationEvent,
  createHubProposalRunDisplayState,
  createHubProposalRunJsonRenderer,
  formatPlainHubProposalEvent,
  formatPlainHubProposalOutcome,
  projectHubProposalRunCancellation,
  projectHubProposalRunOutcome,
  projectHubProposalRunFailure,
  reduceHubProposalRunDisplayState,
} from "./hubProposalRunDisplay.js";
import { createHubProposalRunLiveDisplay } from "./hubProposalRunLiveDisplay.js";
import type { HubProposalPresentationEvent } from "./hubProposalSession.js";
import {
  createRunSignalController,
  getRunCancellationExitCode,
} from "./runSignal.js";
import {
  resolveHubRunOutputMode,
  supportsHubRunCursorControl,
} from "./hubRunOutputMode.js";
import { createHubBatchPlannerInvoker } from "./hubBatchPlannerAgent.js";
import { resolveHubBatchSelectionOptions } from "./hubBatchPlanner.js";
import {
  getHubFlowDefinition,
  listHubFlows,
  type HubFlowDefinition,
  type HubFlowInputSchema,
} from "./hubFlows.js";
import {
  formatValidatedHubFlowInputSummary,
  validateHubFlowInput,
  type ValidatedHubFlowInput,
} from "./hubFlowInput.js";
import {
  handlePrdDecompositionFlowDisplay,
  handleTriageProposalFlowDisplay,
  runHubProposalFlowFromCli,
  runPrdDecompositionProposalFlowFromCli,
  runTriageProposalFlowFromCli,
} from "./hubProposalFlowCli.js";
import { promptTriageTaskSelection } from "./hubTriageProposalCli.js";
import type {
  PrdHubStatusMode,
  PrdWarningSeverity,
} from "./hubPrdDecomposition.js";
import {
  buildHubTaskBoardModel,
  buildHubTaskCreateSummaryModel,
  buildHubTaskDetailModel,
  formatTaskBoardJson,
  hubTaskCreateSummaryModelToBlocks,
  taskBoardModelToBlocks,
  taskDetailModelToBlocks,
  appendHubTaskComment,
  cleanupHubManagedBranches,
  createHubTask,
  deleteHubTasks,
  formatHubManagedBranchCleanupDiagnosticsLines,
  formatHubManagedBranchCleanupLines,
  loadHubTask,
  loadHubTaskBoard,
  planHubManagedBranchCleanup,
  resolveHubTaskSelector,
  resolveHubTaskSelectors,
  selectHubFlowTasks,
} from "./taskBoard.js";
import { waitForKeypress } from "./keypress.js";
import {
  RUN_START_DEBOUNCE_MS,
  buildRunPlanModel,
  runPlanModelToBlocks,
} from "./runPlan.js";
import { evaluateHubManagedBranchCleanup } from "./hubManagedBranchCleanup.js";
import { HUB_TRIAGE_DEFAULT_TASK_QUERY } from "./hubTriage.js";
import { initHubTaskStore } from "./hubTaskStore.js";
import { isTriageTaskIdInput } from "./hubTriageProposal.js";
import {
  buildSyncResultModel,
  createDefaultGithubIssueClient,
  formatHubTaskSyncPreviewLines,
  formatSyncResultJson,
  syncHubTasksWithGithub,
  syncResultModelToBlocks,
} from "./hubTaskSync.js";
import {
  buildHubTaskRecoverSummaryModel,
  formatHubRecoveryComment,
  hubTaskRecoverSummaryModelToBlocks,
  recoverHubTask,
} from "./hubTaskRecover.js";
import {
  buildConflictFieldValues,
  buildHubTaskConflictResolveModel,
  formatConflictKeepOptionLabel,
  formatResolveHubTaskConflictJson,
  hasHubTaskSyncConflict,
  hubTaskConflictResolveModelToBlocks,
  loadRemoteConflictIssue,
  resolveHubTaskSyncConflict,
  type HubConflictKeep,
} from "./hubTaskResolve.js";
import {
  doctorHubTaskState,
  formatHubTaskStateDoctorLines,
  formatHubTaskStateRepairLines,
  repairHubTaskState,
} from "./hubTaskStateDoctor.js";
import {
  buildHubAgentConfigInitSummaryModel,
  buildHubAgentConfigSetRoleSummaryModel,
  formatHubAgentConfigShowLines,
  hubAgentConfigInitSummaryModelToBlocks,
  hubAgentConfigSetRoleSummaryModelToBlocks,
  HUB_AGENT_ROLES,
  listMissingHubAgentRoles,
  readHubAgentConfig,
  resolveHubAgentConfigPath,
  resolveHubAgentRoleEntry,
  setHubAgentRole,
  type HubAgentRole,
  type HubAgentRoleEntry,
} from "./hubAgentConfig.js";
import {
  promptHubAgentRoleSetup,
  promptInitHubAgentConfig,
  promptInitializeHubAgentConfig,
} from "./hubAgentConfigPrompt.js";
import {
  buildHubEnvSetSummaryModel,
  collectHubEnvKeysForSetup,
  formatHubEnvShowLines,
  hubEnvSetSummaryModelToBlocks,
  isHubEnvKnownKey,
  normalizeHubEnvValue,
  resolveHubEnv,
  resolveHubEnvPath,
  upsertHubEnvKey,
} from "./hubEnv.js";
import { promptInitHubEnv, promptInitializeHubEnv } from "./hubEnvPrompt.js";
import {
  buildHubAuthLoginSummaryModel,
  ensureHubAuthDir,
  formatHubAuthShowLines,
  getHubAuthEnvVar,
  getHubAuthLoginCommand,
  hubAuthLoginSummaryModelToBlocks,
  resolveProviderHubAuthDir,
} from "./hubAuth.js";
import { isBdAvailable } from "./resolveBdExecutable.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

type OptionalTextFlag = import("effect").Option.Option<string>;
type RuntimePromptOption = {
  readonly value: string;
  readonly label: string;
  readonly hint: string | undefined;
};

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (cliFlag: OptionalTextFlag, cwd: string): string =>
  cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd);

const optionalTextValue = (flag: OptionalTextFlag): string | undefined =>
  flag._tag === "Some" ? flag.value : undefined;

const trimOptionalText = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const hasInteractiveTerminal = (): boolean =>
  process.stdin.isTTY && process.stdout.isTTY;

const toProjectStatusError = (error: unknown): ProjectStatusError =>
  new ProjectStatusError({
    message: error instanceof Error ? error.message : String(error),
  });

const toTaskBoardError = (error: unknown): TaskBoardError =>
  new TaskBoardError({
    message: error instanceof Error ? error.message : String(error),
  });

// --- Config directory check ---

const CONFIG_DIR = ".archloop";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(join(cwd, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message: "No .archloop/ found. Run `archloop init` first.",
        }),
      );
    }
  });

// --- Init command ---

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)",
  ),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Default scaffold agent to use (e.g. claude-code)"),
  Options.optional,
);

const runtimesOption = Options.text("runtimes").pipe(
  Options.withAlias("installed-runtimes"),
  Options.withDescription(
    "Comma-separated agent runtimes to install in the sandbox image (e.g. claude-code,codex). Omit to install the selected --agent runtime in scripted init or choose interactively.",
  ),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6). Defaults to the agent's default model",
  ),
  Options.optional,
);

const initSandboxOption = Options.text("sandbox").pipe(
  Options.withDescription(
    "Sandbox provider (docker or no-sandbox). Omit to choose interactively.",
  ),
  Options.optional,
);

const initBacklogOption = Options.text("backlog").pipe(
  Options.withDescription(
    "Backlog manager (github-issues or beads). Omit to choose interactively.",
  ),
  Options.optional,
);

const initProjectProfileOption = Options.text("project-profile").pipe(
  Options.withDescription(
    "Project profile for bootstrap and sandbox image scaffolding (e.g. generic, node). Defaults to generic.",
  ),
  Options.optional,
);

const initPresetAgentsOption = Options.text("preset-agents").pipe(
  Options.withDescription(
    "Comma-separated preset agent ids, or 'none' to skip presets without prompting. Omit for interactive prompts.",
  ),
  Options.optional,
);

const initCapabilityOption = Options.text("capability").pipe(
  Options.withDescription(
    "Capability pack (generic, miniprogram). Omit for implicit generic without writing capability.json.",
  ),
  Options.optional,
);

const initCapabilityAddonsOption = Options.text("capability-addons").pipe(
  Options.withDescription(
    "Comma-separated capability add-on ids for the selected pack. Omit for none.",
  ),
  Options.optional,
);

const initCreatearchLoopLabelOption = Options.text(
  "create-archloop-label",
).pipe(
  Options.withDescription(
    "true or false when using github-issues (skips prompt when set). Omit to be prompted.",
  ),
  Options.optional,
);

const initBuildImageOption = Options.text("build-image").pipe(
  Options.withDescription(
    "true or false to build the sandbox image after scaffold (skips prompt when set). Omit to be prompted.",
  ),
  Options.optional,
);

const initInstallMiniprogramCiOption = Options.text(
  "install-miniprogram-ci",
).pipe(
  Options.withDescription(
    "true or false to install project-local miniprogram-ci during Mini Program init (skips prompt when set). Omit to be prompted when miniprogram-ci is missing.",
  ),
  Options.optional,
);

const parseStrictBoolean = (
  flagLabel: string,
  raw: string,
): Effect.Effect<boolean, InitError, never> => {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") {
    return Effect.succeed(true);
  }
  if (v === "false" || v === "0" || v === "no") {
    return Effect.succeed(false);
  }
  return Effect.fail(
    new InitError({
      message: `Invalid value for --${flagLabel}: "${raw}". Expected true or false.`,
    }),
  );
};

const parseCommaSeparatedList = (raw: string): string[] =>
  raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const parseCapabilityAddonsCliValue = (
  raw: string,
): Effect.Effect<readonly string[], InitError, never> => {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return Effect.succeed([]);
  }
  return Effect.succeed(parseCommaSeparatedList(trimmed));
};

const parsePresetAgentsCliValue = (
  raw: string,
): Effect.Effect<readonly string[] | undefined, InitError, never> => {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return Effect.succeed(undefined);
  }
  const ids = parseCommaSeparatedList(trimmed);
  for (const id of ids) {
    if (!getPresetAgentDefinition(id)) {
      return Effect.fail(
        new InitError({
          message: `Unknown preset agent id in --preset-agents: "${id}".`,
        }),
      );
    }
  }
  return Effect.succeed(ids);
};

const parseUniqueRuntimeNames = (raw: string): string[] => {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name.length === 0 || seen.has(name)) {
      continue;
    }

    seen.add(name);
    names.push(name);
  }

  return names;
};

const resolveAgentRuntimeNames = (
  names: readonly string[],
): Effect.Effect<readonly AgentRuntimeEntry[], InitError, never> =>
  Effect.gen(function* () {
    const runtimes: AgentRuntimeEntry[] = [];

    for (const name of names) {
      const runtime = getAgentRuntime(name);
      if (!runtime) {
        const availableNames = listAgentRuntimes()
          .map((entry) => entry.name)
          .join(", ");
        return yield* Effect.fail(
          new InitError({
            message: `Unknown agent runtime "${name}" in --runtimes. Available: ${availableNames}`,
          }),
        );
      }

      runtimes.push(runtime);
    }

    return runtimes;
  });

const resolveRuntimePromptSelection = (
  selection: readonly string[] | symbol,
): Effect.Effect<readonly string[], InitError, never> => {
  if (typeof selection === "symbol") {
    return Effect.fail(
      new InitError({
        message: "Agent runtime selection cancelled.",
      }),
    );
  }

  return Effect.succeed(selection);
};

const parseRuntimesCliValue = (
  raw: string,
): Effect.Effect<readonly AgentRuntimeEntry[], InitError, never> => {
  const names = parseUniqueRuntimeNames(raw);
  if (names.length === 0) {
    return Effect.fail(
      new InitError({
        message: "At least one runtime is required in --runtimes.",
      }),
    );
  }

  return resolveAgentRuntimeNames(names);
};

const resolveDefaultAgentRuntime = (
  agent: AgentEntry,
): Effect.Effect<readonly AgentRuntimeEntry[], InitError, never> => {
  const runtime = getAgentRuntime(agent.name);
  if (runtime) {
    return Effect.succeed([runtime]);
  }

  return Effect.fail(
    new InitError({
      message: `No agent runtime found for default scaffold agent "${agent.name}".`,
    }),
  );
};

const runtimePromptOption = (
  runtime: AgentRuntimeEntry,
  defaultAgentName: string,
): RuntimePromptOption => {
  const option: RuntimePromptOption = {
    value: runtime.name,
    label: runtime.label,
    hint: undefined,
  };

  if (runtime.name === defaultAgentName) {
    return { ...option, hint: "default selected agent" };
  }

  return option;
};

const promptForInstalledRuntimes = (
  selectedAgent: AgentEntry,
): Effect.Effect<readonly AgentRuntimeEntry[], InitError, never> =>
  Effect.gen(function* () {
    const agentRuntimes = listAgentRuntimes();
    const defaultInstalledRuntime = getAgentRuntime(selectedAgent.name);
    const defaultInstalledRuntimeName = defaultInstalledRuntime?.name;
    const selected = yield* Effect.promise(() =>
      clack.multiselect({
        message:
          "Select agent runtimes to install in the sandbox image (space to toggle, enter when done):",
        options: agentRuntimes.map((runtime) =>
          runtimePromptOption(runtime, selectedAgent.name),
        ),
        initialValues: defaultInstalledRuntimeName
          ? [defaultInstalledRuntimeName]
          : undefined,
        cursorAt: defaultInstalledRuntimeName,
        required: true,
      }),
    );
    const selectedRuntimeNames = yield* resolveRuntimePromptSelection(selected);
    return yield* resolveAgentRuntimeNames(selectedRuntimeNames);
  });

const resolveInstalledRuntimes = ({
  selectedAgent,
  agentFlag,
  runtimesFlag,
}: {
  selectedAgent: AgentEntry;
  agentFlag: OptionalTextFlag;
  runtimesFlag: OptionalTextFlag;
}): Effect.Effect<readonly AgentRuntimeEntry[], InitError, never> => {
  if (runtimesFlag._tag === "Some") {
    return parseRuntimesCliValue(runtimesFlag.value);
  }

  if (agentFlag._tag === "Some") {
    return resolveDefaultAgentRuntime(selectedAgent);
  }

  return promptForInstalledRuntimes(selectedAgent);
};

interface AuthSetupResult {
  readonly nextStepLines: readonly string[];
}

interface HostRequirementResult {
  readonly nextStepLines: readonly string[];
}

const buildAuthSetupNextStepLines = (options: {
  readonly githubChoice?: "env" | "login" | "skip" | "deferred";
  readonly codexChoice?: "env" | "login" | "skip" | "deferred";
  readonly cursorChoice?: "env" | "skip" | "deferred";
}): string[] => {
  const lines: string[] = [];

  if (options.githubChoice === "env") {
    lines.push(
      "Add GH_TOKEN to .archloop/.env before running GitHub Issues templates.",
    );
  } else if (options.githubChoice === "skip") {
    lines.push(
      "Set up GitHub auth later with GH_TOKEN in .archloop/.env or `archloop auth login github`.",
    );
  } else if (options.githubChoice === "deferred") {
    lines.push(
      "This scripted init skipped interactive GitHub auth setup. Use GH_TOKEN in .archloop/.env or `archloop auth login github` before running GitHub Issues templates.",
    );
  }

  if (options.codexChoice === "env") {
    lines.push(
      "Add OPENAI_KEY to .archloop/.env before running Codex in the sandbox.",
    );
  } else if (options.codexChoice === "skip") {
    lines.push(
      "Set up Codex auth later with OPENAI_KEY in .archloop/.env for OpenAI API billing or `archloop auth login codex` for a Codex/ChatGPT CLI login session.",
    );
  } else if (options.codexChoice === "deferred") {
    lines.push(
      "This scripted init skipped interactive Codex auth setup. Use OPENAI_KEY in .archloop/.env for OpenAI API billing or `archloop auth login codex` for a Codex/ChatGPT CLI login session before running Codex in the sandbox.",
    );
  }

  if (options.cursorChoice === "env") {
    lines.push(
      "Add CURSOR_API_KEY to .archloop/.env before the first Cursor sandbox run. Bootstrap and task runs will fail without it.",
    );
  } else if (options.cursorChoice === "skip") {
    lines.push(
      "Set CURSOR_API_KEY in .archloop/.env before the first Cursor sandbox run. Bootstrap and task runs will fail until it is set.",
    );
  } else if (options.cursorChoice === "deferred") {
    lines.push(
      "This scripted init skipped interactive Cursor auth setup. Set CURSOR_API_KEY in .archloop/.env before the first Cursor sandbox run, or bootstrap will fail.",
    );
  }

  return lines;
};

const validateHostRequirementsForInit = (options: {
  readonly sandboxProvider: SandboxProviderEntry;
  readonly backlogManager: BacklogManagerEntry;
}): Effect.Effect<void, InitError, never> => {
  if (
    options.sandboxProvider.name === "no-sandbox" &&
    options.backlogManager.name === "beads" &&
    !isBdAvailable()
  ) {
    return Effect.fail(
      new InitError({
        message:
          "Using --sandbox no-sandbox with backlog manager beads requires `bd` to be available from the bundled @beads/bd dependency, ARCHLOOP_BD_PATH, or the host PATH because backlog commands run on the host in this mode. Install dependencies, set ARCHLOOP_BD_PATH, install Beads locally, or choose docker.",
      }),
    );
  }

  return Effect.void;
};

const buildHostRequirementNextStepLines = (options: {
  readonly sandboxProvider: SandboxProviderEntry;
  readonly backlogManager: BacklogManagerEntry;
  readonly projectProfile: ProjectProfileEntry;
  readonly gitRemoteNextSteps?: readonly string[];
}): string[] => {
  const lines: string[] = [
    ...buildDockerRootHostNextStepLines(options.sandboxProvider.name),
  ];

  if (options.sandboxProvider.name === "no-sandbox") {
    if (options.backlogManager.name === "beads") {
      lines.push(
        "Keep `bd` available via the bundled @beads/bd install, `ARCHLOOP_BD_PATH`, or your host PATH when using no-sandbox + beads. Prompt shell expressions run on the host in this mode, not in a container.",
      );
    }

    if (options.projectProfile.name === "python") {
      lines.push(
        "Python bootstrap runs on the host in no-sandbox mode. Install `python3-venv` and/or `uv` locally (the Docker image installs these for container runs), or choose the docker sandbox provider.",
      );
    }
  }

  if (options.gitRemoteNextSteps && options.gitRemoteNextSteps.length > 0) {
    lines.push(...options.gitRemoteNextSteps);
  }

  return lines;
};

const githubIssuesGitRemoteNextStepLinesForCwd = (
  backlogManagerName: string,
): Effect.Effect<readonly string[], InitError> => {
  if (backlogManagerName !== "github-issues") {
    return Effect.succeed([]);
  }
  return Effect.tryPromise({
    try: () => inspectGitRemotes(process.cwd()),
    catch: (error) =>
      new InitError({
        message: error instanceof Error ? error.message : String(error),
      }),
  }).pipe(Effect.map(githubIssuesGitRemoteNextStepLines));
};

const statusDockerRootBuildGuidanceIfNeeded = (
  hostIsRoot: boolean,
): Effect.Effect<void, never, Display> =>
  Effect.gen(function* () {
    if (!hostIsRoot) {
      return;
    }
    const d = yield* Display;
    yield* d.status(ROOT_HOST_DOCKER_UID_GUIDANCE, "info");
  });

const promptForCapabilityAddons = (
  pack: CapabilityPackDefinition,
  sandboxProviderName: string,
): Effect.Effect<readonly string[], InitError, never> =>
  Effect.gen(function* () {
    const selected = yield* Effect.promise(() =>
      clack.multiselect({
        message: "Select capability add-ons (optional):",
        options: [
          ...listCapabilityAddonPromptOptions(pack, sandboxProviderName),
        ],
        required: false,
      }),
    );
    if (clack.isCancel(selected)) {
      yield* Effect.fail(
        new InitError({ message: "Capability add-on selection cancelled." }),
      );
    }
    if (!Array.isArray(selected) || selected.length === 0) {
      return [];
    }
    return selected;
  });

const resolveCapabilityAddonIds = (options: {
  readonly selectedCapabilityId: string | undefined;
  readonly sandboxProviderName: string;
  readonly capabilityAddonsCli: OptionalTextFlag;
  readonly scriptedInit: boolean;
}): Effect.Effect<readonly string[], InitError, never> =>
  Effect.gen(function* () {
    if (options.capabilityAddonsCli._tag === "Some") {
      return yield* parseCapabilityAddonsCliValue(
        options.capabilityAddonsCli.value,
      );
    }

    if (options.scriptedInit || options.selectedCapabilityId === undefined) {
      return [];
    }

    const pack = getCapabilityPackDefinition(options.selectedCapabilityId);
    if (pack === undefined || pack.addons.length === 0) {
      return [];
    }

    return yield* promptForCapabilityAddons(pack, options.sandboxProviderName);
  });

const resolveSelectedCapabilityId = (
  capabilityCli: OptionalTextFlag,
  scriptedInit: boolean,
): Effect.Effect<string | undefined, InitError, never> =>
  Effect.gen(function* () {
    if (capabilityCli._tag === "Some") {
      return capabilityCli.value;
    }
    if (scriptedInit) {
      return undefined;
    }

    const selected = yield* Effect.promise(() =>
      clack.select({
        message: "Select a capability pack:",
        initialValue: "generic",
        options: listCapabilityPacksForInit(),
      }),
    );
    if (clack.isCancel(selected)) {
      yield* Effect.fail(
        new InitError({ message: "Capability pack selection cancelled." }),
      );
    }

    const picked = selected as string;
    return picked === DEFAULT_CAPABILITY_PACK_ID ? undefined : picked;
  });

const resolveMiniprogramCiInstallApproval = (options: {
  readonly cwd: string;
  readonly capabilityInit: ResolvedCapabilityInit;
  readonly installMiniprogramCiCli: OptionalTextFlag;
  readonly scriptedInit: boolean;
}): Effect.Effect<boolean | undefined, InitError, never> =>
  Effect.gen(function* () {
    if (
      options.capabilityInit.capabilityId !== MINIPROGRAM_CAPABILITY_PACK_ID ||
      !options.capabilityInit.writeCapabilityManifest
    ) {
      return undefined;
    }

    const miniprogramSnapshot = detectMiniprogramInitSnapshot(options.cwd);
    if (miniprogramSnapshot.miniprogramCi.status === "available") {
      return undefined;
    }

    if (options.installMiniprogramCiCli._tag === "Some") {
      return yield* parseStrictBoolean(
        "install-miniprogram-ci",
        options.installMiniprogramCiCli.value,
      );
    }

    if (options.scriptedInit) {
      return undefined;
    }

    const approved = yield* Effect.promise(() =>
      clack.confirm({
        message:
          "Install project-local miniprogram-ci as a dev dependency? (Recommended for platform preview validation; global CLI and npx do not satisfy archLoop's managed loop.)",
        initialValue: false,
      }),
    );
    if (clack.isCancel(approved)) {
      yield* Effect.fail(
        new InitError({
          message: "miniprogram-ci installation choice cancelled.",
        }),
      );
    }
    return approved === true;
  });

const isFullyScriptedInit = (options: {
  agentFlag: OptionalTextFlag;
  runtimesFlag: OptionalTextFlag;
  sandboxCli: OptionalTextFlag;
  backlogCli: OptionalTextFlag;
  template: OptionalTextFlag;
  presetAgentsCli: OptionalTextFlag;
  buildImageCli: OptionalTextFlag;
  createarchLoopLabelCli: OptionalTextFlag;
  selectedBacklogManagerName: string;
}): boolean =>
  options.agentFlag._tag === "Some" &&
  options.sandboxCli._tag === "Some" &&
  options.backlogCli._tag === "Some" &&
  options.template._tag === "Some" &&
  options.presetAgentsCli._tag === "Some" &&
  options.buildImageCli._tag === "Some" &&
  (options.runtimesFlag._tag === "Some" || options.agentFlag._tag === "Some") &&
  (options.selectedBacklogManagerName !== "github-issues" ||
    options.createarchLoopLabelCli._tag === "Some");

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    runtimes: runtimesOption,
    model: initModelOption,
    sandbox: initSandboxOption,
    backlog: initBacklogOption,
    projectProfile: initProjectProfileOption,
    presetAgents: initPresetAgentsOption,
    capability: initCapabilityOption,
    capabilityAddons: initCapabilityAddonsOption,
    createarchLoopLabel: initCreatearchLoopLabelOption,
    buildImage: initBuildImageOption,
    installMiniprogramCi: initInstallMiniprogramCiOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    runtimes: runtimesFlag,
    model: modelFlag,
    sandbox: sandboxCli,
    backlog: backlogCli,
    projectProfile: projectProfileCli,
    presetAgents: presetAgentsCli,
    capability: capabilityCli,
    capabilityAddons: capabilityAddonsCli,
    createarchLoopLabel: createarchLoopLabelCli,
    buildImage: buildImageCli,
    installMiniprogramCi: installMiniprogramCiCli,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      const cliProjectProfile =
        projectProfileCli._tag === "Some"
          ? getProjectProfile(projectProfileCli.value)
          : undefined;
      if (projectProfileCli._tag === "Some" && !cliProjectProfile) {
        yield* Effect.fail(
          new InitError({
            message: `Unknown project profile "${projectProfileCli.value}". Available: ${formatProjectProfileNames()}`,
          }),
        );
      }

      if (template._tag === "Some") {
        const valid = templates.find((tmpl) => tmpl.name === template.value);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${template.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (
        capabilityCli._tag === "Some" &&
        !getCapabilityPackDefinition(capabilityCli.value)
      ) {
        yield* Effect.fail(
          new InitError({
            message: `Unknown capability pack "${capabilityCli.value}". Available: ${listCapabilityPacksForInit()
              .map((p) => p.value)
              .join(", ")}`,
          }),
        );
      }

      // Resolve agent: CLI flag > interactive select
      const agents = listAgents();
      let selectedAgent: AgentEntry;
      if (agentFlag._tag === "Some") {
        const entry = getAgent(agentFlag.value);
        if (!entry) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
        selectedAgent = entry!;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select the default scaffold agent:",
            initialValue: "claude-code",
            options: agents.map((a) => ({
              value: a.name,
              label: a.label,
              hint: `Default model: ${a.defaultModel}`,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      // Resolve model: CLI flag > agent default
      const selectedModel =
        modelFlag._tag === "Some"
          ? modelFlag.value
          : selectedAgent.defaultModel;

      // Resolve installed agent runtimes: CLI flag > selected --agent runtime > interactive multiselect
      const selectedInstalledRuntimes = yield* resolveInstalledRuntimes({
        selectedAgent,
        agentFlag,
        runtimesFlag,
      });

      // Resolve sandbox provider: CLI flag > interactive select
      const sandboxProviders = listInitSandboxProviders();
      let selectedSandboxProvider: SandboxProviderEntry;
      if (sandboxCli._tag === "Some") {
        const entry = getInitSandboxProvider(sandboxCli.value);
        if (!entry) {
          const names = sandboxProviders.map((p) => p.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown sandbox provider "${sandboxCli.value}". Available: ${names}`,
            }),
          );
        }
        selectedSandboxProvider = entry!;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a sandbox provider:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Sandbox provider selection cancelled.",
            }),
          );
        }
        selectedSandboxProvider = getInitSandboxProvider(selected as string)!;
      }

      // Resolve backlog manager: CLI flag > interactive select
      const backlogManagers = listBacklogManagers();
      let selectedBacklogManager: BacklogManagerEntry;
      if (backlogCli._tag === "Some") {
        const entry = getBacklogManager(backlogCli.value);
        if (!entry) {
          const names = backlogManagers.map((b) => b.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown backlog manager "${backlogCli.value}". Available: ${names}`,
            }),
          );
        }
        selectedBacklogManager = entry!;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a backlog manager:",
            initialValue: "github-issues",
            options: backlogManagers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Backlog manager selection cancelled.",
            }),
          );
        }
        selectedBacklogManager = getBacklogManager(selected as string)!;
      }

      yield* validateHostRequirementsForInit({
        sandboxProvider: selectedSandboxProvider,
        backlogManager: selectedBacklogManager,
      });

      const scriptedInit = isFullyScriptedInit({
        agentFlag,
        runtimesFlag,
        sandboxCli,
        backlogCli,
        template,
        presetAgentsCli,
        buildImageCli,
        createarchLoopLabelCli,
        selectedBacklogManagerName: selectedBacklogManager.name,
      });

      const selectedCapabilityId = yield* resolveSelectedCapabilityId(
        capabilityCli,
        scriptedInit,
      );

      const capabilityAddonIds = yield* resolveCapabilityAddonIds({
        selectedCapabilityId,
        sandboxProviderName: selectedSandboxProvider.name,
        capabilityAddonsCli,
        scriptedInit,
      });

      let explicitPresetAgentIds: readonly string[] | undefined;
      if (presetAgentsCli._tag === "Some") {
        explicitPresetAgentIds = yield* parsePresetAgentsCliValue(
          presetAgentsCli.value,
        );
      }

      const capabilityInit = yield* Effect.try({
        try: () =>
          resolveCapabilityInitOptions({
            capabilityId: selectedCapabilityId,
            explicitTemplate:
              template._tag === "Some" ? template.value : undefined,
            explicitProjectProfile:
              projectProfileCli._tag === "Some"
                ? projectProfileCli.value
                : undefined,
            explicitPresetAgentIds,
            addonIds: capabilityAddonIds,
            sandboxProviderName: selectedSandboxProvider.name,
          }),
        catch: (e) =>
          new InitError({
            message: e instanceof Error ? e.message : String(e),
          }),
      });

      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else if (scriptedInit) {
        selectedTemplate = capabilityInit.templateName;
      } else {
        const compatibleTemplateNames = getCapabilityPackDefinition(
          capabilityInit.capabilityId,
        )?.compatibleTemplates;
        const selectableTemplates = compatibleTemplateNames
          ? templates.filter((tmpl) =>
              compatibleTemplateNames.includes(tmpl.name),
            )
          : templates;
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: capabilityInit.templateName,
            options: selectableTemplates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
        }
        selectedTemplate = selected as string;
      }

      yield* Effect.try({
        try: () =>
          validateCapabilityTemplateSelection(
            capabilityInit.capabilityId,
            selectedTemplate,
          ),
        catch: (e) =>
          new InitError({
            message: e instanceof Error ? e.message : String(e),
          }),
      });

      let selectedProjectProfile: ProjectProfileEntry;
      if (cliProjectProfile) {
        selectedProjectProfile = cliProjectProfile;
      } else if (scriptedInit) {
        selectedProjectProfile =
          getProjectProfile(capabilityInit.projectProfileName) ??
          DEFAULT_PROJECT_PROFILE;
      } else {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a project profile:",
            initialValue: capabilityInit.projectProfileName,
            options: listProjectProfiles().map((profile) => ({
              value: profile.name,
              label: profile.label,
              hint: profile.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Project profile selection cancelled.",
            }),
          );
        }
        selectedProjectProfile = getProjectProfile(selected as string)!;
      }

      let presetAgentIds: readonly string[] | undefined;
      if (presetAgentsCli._tag === "Some") {
        presetAgentIds = explicitPresetAgentIds;
      } else if (scriptedInit && capabilityInit.presetAgentIds.length > 0) {
        presetAgentIds = capabilityInit.presetAgentIds;
      } else {
        const addPresets = yield* Effect.promise(() =>
          clack.confirm({
            message: "Add preset agent roles (reviewer, planner, …)?",
            initialValue: false,
          }),
        );
        if (clack.isCancel(addPresets)) {
          yield* Effect.fail(
            new InitError({ message: "Preset agent selection cancelled." }),
          );
        }
        if (addPresets === true) {
          const picked = yield* Effect.promise(() =>
            clack.multiselect({
              message:
                "Select preset roles (space to toggle, enter when done):",
              options: listPresetAgentsForInit(),
              required: false,
            }),
          );
          if (clack.isCancel(picked)) {
            yield* Effect.fail(
              new InitError({ message: "Preset agent selection cancelled." }),
            );
          }
          if (Array.isArray(picked) && picked.length > 0) {
            presetAgentIds = picked;
          }
        }
      }

      // Offer to create the "archLoop" label on the repo (skip for non-GitHub backlog managers)
      let shouldCreateLabel: boolean | symbol = false;
      if (selectedBacklogManager.name === "github-issues") {
        if (createarchLoopLabelCli._tag === "Some") {
          shouldCreateLabel = yield* parseStrictBoolean(
            "create-archloop-label",
            createarchLoopLabelCli.value,
          );
        } else {
          shouldCreateLabel = yield* Effect.promise(() =>
            clack.confirm({
              message:
                'Create a "archLoop" GitHub label? (Templates filter issues by this label)',
              initialValue: true,
            }),
          );
        }

        if (shouldCreateLabel === true) {
          yield* Effect.try({
            try: () =>
              execSync(
                'gh label create "archLoop" --description "Issues for archLoop to work on" --color "F9A825" 2>/dev/null',
                { cwd, stdio: "ignore" },
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
      }

      const miniprogramCiInstallApproved =
        yield* resolveMiniprogramCiInstallApproval({
          cwd,
          capabilityInit,
          installMiniprogramCiCli,
          scriptedInit,
        });

      const scaffoldResult = yield* d.spinner(
        "Scaffolding .archloop/ config directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel === true,
          backlogManager: selectedBacklogManager,
          sandboxProvider: selectedSandboxProvider,
          installedRuntimes: selectedInstalledRuntimes,
          projectProfile: selectedProjectProfile,
          archloopVersion: VERSION,
          ...(presetAgentIds !== undefined && presetAgentIds.length > 0
            ? { presetAgentIds }
            : {}),
          capabilityInit,
          ...(miniprogramCiInstallApproved !== undefined
            ? { miniprogramCiInstallApproved }
            : {}),
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        ),
      );

      if (scaffoldResult.dependencyInstallFailed) {
        yield* d.status(
          "package.json was updated but `npm install` failed. Run `npm install` in the project root before `npm run archloop`.",
          "warn",
        );
      }

      if (scaffoldResult.capabilityBlankTemplateWarning) {
        yield* d.status(scaffoldResult.capabilityBlankTemplateWarning, "warn");
      }

      const authRequirements = collectAuthRequirements({
        installedRuntimes: selectedInstalledRuntimes,
        backlogManager: selectedBacklogManager,
      });
      const hasCodexAuth = authRequirements.some(
        (requirement) => requirement.id === "codex",
      );
      const hasCursorAuth = authRequirements.some(
        (requirement) => requirement.id === "cursor",
      );
      const githubAuthRequirement = authRequirements.find(
        (requirement) =>
          requirement.id === "github-issues" &&
          requirement.githubLoginSupported,
      );
      let githubAuthChoice: "env" | "login" | "skip" | "deferred" | undefined;
      let codexAuthChoice: "env" | "login" | "skip" | "deferred" | undefined;
      let cursorAuthChoice: "env" | "skip" | "deferred" | undefined;

      if (githubAuthRequirement) {
        if (scriptedInit) {
          githubAuthChoice = "deferred";
        } else {
          const authChoice = yield* Effect.promise(() =>
            clack.select({
              message: "Set up GitHub authentication now?",
              initialValue: "env",
              options: [
                {
                  value: "env",
                  label: "Use GH_TOKEN in .archloop/.env",
                },
                {
                  value: "login",
                  label: "Run gh auth login into the Hub auth directory",
                },
                {
                  value: "skip",
                  label: "Skip for now",
                },
              ],
            }),
          );
          if (clack.isCancel(authChoice)) {
            yield* Effect.fail(
              new InitError({ message: "GitHub auth setup cancelled." }),
            );
          }

          if (authChoice === "env") {
            githubAuthChoice = "env";
            yield* d.status(
              "Add GH_TOKEN to .archloop/.env when you're ready. archLoop will not write secrets for you.",
              "info",
            );
          } else if (authChoice === "login") {
            githubAuthChoice = "login";
            yield* Effect.try({
              try: () =>
                execSync("gh auth login --insecure-storage", {
                  cwd,
                  stdio: "inherit",
                  env: {
                    ...process.env,
                    GH_CONFIG_DIR: ensureHubAuthDir("github"),
                  },
                }),
              catch: () =>
                new InitError({
                  message:
                    "GitHub login failed. You can retry with `archloop auth login github`.",
                }),
            });
          } else {
            githubAuthChoice = "skip";
            yield* d.status(
              "Skipped GitHub auth setup for now. Configure GH_TOKEN or gh auth login later.",
              "info",
            );
          }
        }
      }

      if (hasCodexAuth) {
        if (scriptedInit) {
          codexAuthChoice = "deferred";
        } else {
          const authChoice = yield* Effect.promise(() =>
            clack.select({
              message: "Set up Codex authentication now?",
              initialValue: "env",
              options: [
                {
                  value: "env",
                  label: "Use OPENAI_KEY in .archloop/.env",
                },
                {
                  value: "login",
                  label: "Run codex login into the Hub auth directory",
                },
                {
                  value: "skip",
                  label: "Skip for now",
                },
              ],
            }),
          );
          if (clack.isCancel(authChoice)) {
            yield* Effect.fail(
              new InitError({ message: "Codex auth setup cancelled." }),
            );
          }

          if (authChoice === "env") {
            codexAuthChoice = "env";
            yield* d.status(
              "Add OPENAI_KEY to .archloop/.env when you're ready. archLoop will not write secrets for you.",
              "info",
            );
          } else if (authChoice === "login") {
            codexAuthChoice = "login";
            yield* Effect.try({
              try: () =>
                execSync("codex login", {
                  cwd,
                  stdio: "inherit",
                  env: {
                    ...process.env,
                    CODEX_HOME: ensureHubAuthDir("codex"),
                  },
                }),
              catch: () =>
                new InitError({
                  message:
                    "Codex login failed. You can retry with `archloop auth login codex`.",
                }),
            });
          } else {
            codexAuthChoice = "skip";
            yield* d.status(
              "Skipped Codex auth setup for now. Configure OPENAI_KEY or codex login later.",
              "info",
            );
          }
        }
      }

      if (hasCursorAuth) {
        if (scriptedInit) {
          cursorAuthChoice = "deferred";
        } else {
          const authChoice = yield* Effect.promise(() =>
            clack.select({
              message: "Set up Cursor authentication now?",
              initialValue: "env",
              options: [
                {
                  value: "env",
                  label: "Use CURSOR_API_KEY in .archloop/.env",
                },
                {
                  value: "skip",
                  label: "Skip for now",
                },
              ],
            }),
          );
          if (clack.isCancel(authChoice)) {
            yield* Effect.fail(
              new InitError({ message: "Cursor auth setup cancelled." }),
            );
          }

          if (authChoice === "env") {
            cursorAuthChoice = "env";
            yield* d.status(
              "Set CURSOR_API_KEY in .archloop/.env before the first Cursor sandbox run. archLoop will not write secrets for you, and bootstrap will fail without it.",
              "warn",
            );
          } else {
            cursorAuthChoice = "skip";
            yield* d.status(
              "Skipped Cursor auth setup for now. Set CURSOR_API_KEY before the first Cursor sandbox run, or bootstrap will fail.",
              "warn",
            );
          }
        }
      }

      const authSetupResult: AuthSetupResult = {
        nextStepLines: buildAuthSetupNextStepLines({
          githubChoice: githubAuthChoice,
          codexChoice: codexAuthChoice,
          cursorChoice: cursorAuthChoice,
        }),
      };

      const gitRemoteNextSteps =
        yield* githubIssuesGitRemoteNextStepLinesForCwd(
          selectedBacklogManager.name,
        );

      const hostRequirementResult: HostRequirementResult = {
        nextStepLines: buildHostRequirementNextStepLines({
          sandboxProvider: selectedSandboxProvider,
          backlogManager: selectedBacklogManager,
          projectProfile: selectedProjectProfile,
          gitRemoteNextSteps,
        }),
      };

      // Prompt user before building image (unless --build-image is set)
      const providerLabel = selectedSandboxProvider.label;
      const isNoSandboxInit = selectedSandboxProvider.name === "no-sandbox";
      let shouldBuild: boolean | symbol = false;
      if (!isNoSandboxInit) {
        if (buildImageCli._tag === "Some") {
          shouldBuild = yield* parseStrictBoolean(
            "build-image",
            buildImageCli.value,
          );
        } else {
          shouldBuild = yield* Effect.promise(() =>
            clack.confirm({
              message: `Build the default ${providerLabel} image now?`,
              initialValue: true,
            }),
          );
        }
      }

      if (shouldBuild === true) {
        const containerfileDir = join(cwd, CONFIG_DIR);
        if (selectedSandboxProvider.name === "podman") {
          yield* d.spinner(
            `Building ${providerLabel} image '${imageName}'...`,
            podmanBuildImage(imageName, containerfileDir),
          );
        } else {
          const { buildArgs, hostIsRoot } = resolveDockerUidBuildArgs();
          yield* statusDockerRootBuildGuidanceIfNeeded(hostIsRoot);
          yield* d.spinner(
            `Building ${providerLabel} image '${imageName}'...`,
            buildImage(imageName, containerfileDir, { buildArgs }),
          );
        }
        yield* d.status("Init complete! Image built successfully.", "success");
      } else if (isNoSandboxInit) {
        yield* d.status(
          "Init complete! no-sandbox selected, so image build was skipped.",
          "success",
        );
      } else {
        yield* d.status(
          `Init complete! Run \`archloop ${selectedSandboxProvider.cliNamespace} build-image\` to build the ${providerLabel} image later.`,
          "success",
        );
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(
        selectedTemplate,
        scaffoldResult.mainFilename,
        {
          presetAgentIds: scaffoldResult.presetAgentIds,
          packageSetup: scaffoldResult.packageSetup,
          dependencyInstallFailed: scaffoldResult.dependencyInstallFailed,
          ...(scaffoldResult.capabilityBlankTemplateWarning
            ? {
                capabilityBlankTemplateWarning:
                  scaffoldResult.capabilityBlankTemplateWarning,
              }
            : {}),
          authSetupSummary: {
            lines: authSetupResult.nextStepLines,
          },
          hostRequirementSummary: {
            lines: hostRequirementResult.nextStepLines,
          },
        },
      );
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;

      const { buildArgs, hostIsRoot } = resolveDockerUidBuildArgs();
      yield* statusDockerRootBuildGuidanceIfNeeded(hostIsRoot);

      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
          buildArgs,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Project status command ---

const projectTargetOption = Options.text("project").pipe(
  Options.withDescription("Hub project name"),
  Options.optional,
);

const projectConfigureProjectProfileOption = Options.text(
  "project-profile",
).pipe(
  Options.withDescription(
    "Project profile for the Hub project development contract (e.g. generic, node). Defaults to a prompt in TTYs.",
  ),
  Options.optional,
);

const describeProjectConfigureEditOutcome = (contract: {
  readonly preservedUserEdits: boolean;
  readonly projectProfileChanged: boolean;
}): string => {
  if (contract.preservedUserEdits) {
    return "preserved";
  }

  if (contract.projectProfileChanged) {
    return "replaced for the new project profile";
  }

  return "new contract";
};

const describeProjectConfigureStatus = (contract: {
  readonly backupPath?: string;
  readonly preservedUserEdits: boolean;
}): string => {
  if (contract.backupPath) {
    return `Backed up the previous contract to ${contract.backupPath}.`;
  }

  if (contract.preservedUserEdits) {
    return "Preserved user-edited setup, verify, and context while refreshing project facts.";
  }

  return "Refreshed project facts and wrote a new Hub project development contract.";
};

const resolveProjectTargetStatus = (
  project: OptionalTextFlag,
): Effect.Effect<
  Awaited<ReturnType<typeof resolveHubProjectStatus>>,
  ProjectStatusError
> =>
  Effect.gen(function* () {
    const target = yield* Effect.tryPromise({
      try: () =>
        resolveHubProjectTarget({
          projectSelector: optionalTextValue(project),
          isTTY: process.stdin.isTTY === true,
          selectProject: resolveInteractiveProjectSelection,
        }),
      catch: toProjectStatusError,
    });

    return yield* Effect.try({
      try: () =>
        resolveHubProjectStatus({
          cwd: target.project.repoRoot,
          hubProjectDir: target.project.hubProjectDir,
        }),
      catch: toProjectStatusError,
    });
  });

const taskIdArg = Args.text({ name: "id" });
const taskTitleArg = Args.text({ name: "title" });
const taskOriginOption = Options.text("origin").pipe(
  Options.withDescription(
    "Task origin (manual or user-feedback). Defaults to manual.",
  ),
  Options.optional,
);
const taskDescriptionOption = Options.text("description").pipe(
  Options.withDescription("Optional task description"),
  Options.optional,
);
const taskKindOption = Options.text("kind").pipe(
  Options.withDescription("Optional task kind metadata"),
  Options.withAlias("category"),
  Options.optional,
);
const prdRefArg = Args.text({ name: "prd-ref" });
const prdApproveOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Run a one-shot PRD decomposition proposal and create inbox tasks without interactive prompts.",
  ),
  Options.withDefault(false),
);
const prdStatusOption = Options.text("status").pipe(
  Options.withDescription(
    "Initial Hub status mode for PRD-derived tasks (inbox, classified_ready). Defaults to inbox.",
  ),
  Options.optional,
);
const prdDepsOption = Options.text("deps").pipe(
  Options.withDescription(
    "Dependency pairs as childIndex:parentIndex, e.g. 2:1,3:1.",
  ),
  Options.optional,
);
const taskDeleteYesOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Confirm destructive local delete without interactive prompts.",
  ),
  Options.withDefault(false),
);
const taskRepairStateYesOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Apply local Beads task-state repair after previewing planned changes.",
  ),
  Options.withDefault(false),
);
const taskDeleteDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription(
    "Preview what Beads would delete without making changes.",
  ),
  Options.withDefault(false),
);
const taskDeleteCascadeOption = Options.boolean("cascade").pipe(
  Options.withDescription(
    "Passthrough to Beads: recursively delete dependent tasks.",
  ),
  Options.withDefault(false),
);
const taskCleanupYesOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Confirm cleanup of safe managed branches without interactive prompts.",
  ),
  Options.withDefault(false),
);
const taskCleanupDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription(
    "Preview managed branch cleanup without deleting any git refs.",
  ),
  Options.withDefault(false),
);
const taskCleanupIncludeUnownedOption = Options.boolean("include-unowned").pipe(
  Options.withDescription(
    "Also delete safe historical unowned archloop/... branches when confirming cleanup.",
  ),
  Options.withDefault(false),
);
const taskSyncYesOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Apply sync changes after previewing them. Required for non-interactive tasks sync.",
  ),
  Options.withDefault(false),
);
const taskSyncDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Preview task sync changes without applying them."),
  Options.withDefault(false),
);
const taskSyncIncludeClosedOption = Options.boolean("include-closed").pipe(
  Options.withDescription(
    "Include closed historical GitHub issues when pulling into Beads.",
  ),
  Options.withDefault(false),
);
const taskSyncJsonOption = Options.boolean("json").pipe(
  Options.withDescription(
    "Emit a structured JSON payload including the per-task entries array.",
  ),
  Options.withDefault(false),
);
const taskResolveKeepOption = Options.choice("keep", [
  "local",
  "remote",
] as const).pipe(
  Options.withDescription(
    "Resolve a sync conflict by keeping the local or remote side (required in non-interactive mode).",
  ),
  Options.optional,
);
const taskResolveYesOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Skip the interactive keep prompt when --keep is also provided.",
  ),
  Options.withDefault(false),
);
const taskResolveJsonOption = Options.boolean("json").pipe(
  Options.withDescription(
    "Emit a structured JSON payload instead of the resolve section.",
  ),
  Options.withDefault(false),
);
const taskWarningOption = Options.text("warning").pipe(
  Options.withDescription(
    "Filter tasks by PRD warning severity (high, medium, or low).",
  ),
  Options.optional,
);
const taskListAllOption = Options.boolean("all").pipe(
  Options.withDescription(
    "Show every task in each status group, including the full done list.",
  ),
  Options.withDefault(false),
);
const taskListJsonOption = Options.boolean("json").pipe(
  Options.withDescription(
    "Emit a structured JSON array of task board rows, including remoteBadge when present.",
  ),
  Options.withDefault(false),
);
const taskSelectorsArg = Args.atLeast(
  Args.text({ name: "task-selector" }).pipe(
    Args.withDescription("Beads id, or exact task title."),
  ),
  1,
);

const resolveTaskCommandProjectTarget = (
  project: OptionalTextFlag,
): Effect.Effect<
  { readonly repoRoot: string; readonly projectName: string },
  TaskBoardError,
  never
> =>
  Effect.tryPromise({
    try: async () => {
      const resolved = await resolveHubProjectTarget({
        projectSelector: optionalTextValue(project),
        isTTY: process.stdin.isTTY === true,
        selectProject: resolveInteractiveProjectSelection,
      });
      return {
        repoRoot: resolved.project.repoRoot,
        projectName: resolved.project.name,
      };
    },
    catch: toTaskBoardError,
  });

const resolveTaskCommandRepoRoot = (
  project: OptionalTextFlag,
): Effect.Effect<string, TaskBoardError, never> =>
  Effect.map(
    resolveTaskCommandProjectTarget(project),
    (target) => target.repoRoot,
  );

const normalizeTaskOrigin = (
  value: string,
): "manual" | "user-feedback" | undefined => {
  const normalized = value.trim().toLowerCase();
  return normalized === "manual" || normalized === "user-feedback"
    ? normalized
    : undefined;
};

const resolveTaskOrigin = (
  origin: OptionalTextFlag,
): Effect.Effect<"manual" | "user-feedback", TaskBoardError, never> => {
  if (origin._tag !== "Some") {
    return Effect.succeed("manual");
  }

  const resolvedOrigin = normalizeTaskOrigin(origin.value);
  if (resolvedOrigin) {
    return Effect.succeed(resolvedOrigin);
  }

  return Effect.fail(
    new TaskBoardError({
      message: 'Invalid task origin. Use "manual" or "user-feedback".',
    }),
  );
};

const resolvePrdWarningFilter = (
  warning: OptionalTextFlag,
): Effect.Effect<PrdWarningSeverity | undefined, TaskBoardError, never> => {
  if (warning._tag !== "Some") {
    return Effect.succeed(undefined);
  }

  const normalized = warning.value.trim().toLowerCase();
  if (
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low"
  ) {
    return Effect.succeed(normalized);
  }

  return Effect.fail(
    new TaskBoardError({
      message: 'Invalid task warning filter. Use "high", "medium", or "low".',
    }),
  );
};

const tasksInitCommand = Command.make(
  "init",
  {
    project: projectTargetOption,
  },
  ({ project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const result = yield* Effect.try({
        try: () => initHubTaskStore(cwd),
        catch: toTaskBoardError,
      });

      if (result.alreadyInitialized) {
        yield* d.status("Hub task store is already initialized.", "success");
        return;
      }

      if (result.output.trim().length > 0) {
        yield* d.text(result.output.trim());
      }
      yield* d.status("Initialized local Hub task store.", "success");
    }),
);

const tasksListCommand = Command.make(
  "list",
  {
    warning: taskWarningOption,
    all: taskListAllOption,
    json: taskListJsonOption,
    project: projectTargetOption,
  },
  ({ warning, all, json, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const target = yield* resolveTaskCommandProjectTarget(project);
      const warningFilter = yield* resolvePrdWarningFilter(warning);
      const board = yield* Effect.try({
        try: () => loadHubTaskBoard(target.repoRoot),
        catch: toTaskBoardError,
      });
      const model = buildHubTaskBoardModel({
        projectName: target.projectName,
        board,
        warningFilter,
        showAll: all,
      });
      if (json) {
        yield* d.plain(formatTaskBoardJson(model));
        return;
      }
      yield* d.section("", taskBoardModelToBlocks(model));
    }),
);

const tasksCreateCommand = Command.make(
  "create",
  {
    title: taskTitleArg,
    origin: taskOriginOption,
    description: taskDescriptionOption,
    kind: taskKindOption,
    project: projectTargetOption,
  },
  ({ title, origin, description, kind, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const resolvedOrigin = yield* resolveTaskOrigin(origin);
      const kindValue = optionalTextValue(kind);
      const created = yield* Effect.try({
        try: () =>
          createHubTask(cwd, {
            title,
            description: optionalTextValue(description),
            origin: resolvedOrigin,
            kind: kindValue,
          }),
        catch: toTaskBoardError,
      });

      yield* d.section(
        "",
        hubTaskCreateSummaryModelToBlocks(
          buildHubTaskCreateSummaryModel({
            id: created.id,
            title: created.title,
            origin: resolvedOrigin,
            ...(kindValue !== undefined ? { kind: kindValue } : {}),
          }),
        ),
      );
    }),
);

const tasksShowCommand = Command.make(
  "show",
  { id: taskIdArg, project: projectTargetOption },
  ({ id, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const task = yield* Effect.try({
        try: () => loadHubTask(cwd, id),
        catch: toTaskBoardError,
      });

      const model = buildHubTaskDetailModel(task);
      yield* d.section("", taskDetailModelToBlocks(model));
    }),
);

const triageTaskIdArg = Args.text({ name: "task-id" }).pipe(Args.optional);
const triageQueryOption = Options.text("query").pipe(
  Options.withDescription(
    "Comma-separated Hub statuses to triage (inbox, needs_info).",
  ),
  Options.optional,
);
const triageApproveOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Approve and apply high-confidence triage decisions without interactive confirmation.",
  ),
  Options.withAlias("approve"),
  Options.withDefault(false),
);

const tasksTriageCommand = Command.make(
  "triage",
  {
    taskId: triageTaskIdArg,
    query: triageQueryOption,
    approve: triageApproveOption,
    project: projectTargetOption,
  },
  ({ taskId, query, approve, project }) =>
    Effect.gen(function* () {
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const explicitTaskId = optionalTextValue(taskId)?.trim();
      const explicitQuery = optionalTextValue(query)?.trim();
      const yes = approve;

      if (explicitTaskId && explicitQuery) {
        return yield* Effect.fail(
          new TaskBoardError({
            message:
              "Use either a task id argument or --query, not both. Example: archloop tasks triage bd-42",
          }),
        );
      }

      let resolvedTaskIds: string[] | undefined;
      let resolvedQuery: string | undefined;

      if (explicitTaskId) {
        if (!isTriageTaskIdInput(explicitTaskId)) {
          return yield* Effect.fail(
            new TaskBoardError({
              message: `Invalid triage task id "${explicitTaskId}". Use a Beads task id such as bd-42.`,
            }),
          );
        }
        resolvedTaskIds = [explicitTaskId.toLowerCase()];
      } else if (explicitQuery) {
        yield* Effect.try({
          try: () =>
            validateHubFlowInput("triage", {
              cwd,
              rawInput: explicitQuery,
            }),
          catch: (error) =>
            new TaskBoardError({
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        resolvedQuery = explicitQuery;
      } else if (process.stdin.isTTY) {
        const board = yield* Effect.try({
          try: () => loadHubTaskBoard(cwd),
          catch: toTaskBoardError,
        });
        resolvedTaskIds = yield* Effect.tryPromise({
          try: () => promptTriageTaskSelection({ board }),
          catch: toTaskBoardError,
        });
      } else if (yes) {
        resolvedQuery = HUB_TRIAGE_DEFAULT_TASK_QUERY;
      } else {
        return yield* Effect.fail(
          new TaskBoardError({
            message:
              "Non-interactive triage requires a task id, --query, or --yes. Example: archloop tasks triage bd-42, archloop tasks triage --query inbox,needs_info, or archloop tasks triage --yes",
          }),
        );
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          runTriageProposalFlowFromCli({
            cwd,
            taskIds: resolvedTaskIds,
            query: resolvedQuery,
            yes,
            isTTY: process.stdin.isTTY,
          }),
        catch: toTaskBoardError,
      });

      yield* handleTriageProposalFlowDisplay(
        result,
        (message) => new TaskBoardError({ message }),
      );
    }),
);

const normalizePrdHubStatusMode = (
  value: string,
): PrdHubStatusMode | undefined => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "inbox") {
    return "inbox";
  }
  if (
    normalized === "ready_for_agent" ||
    normalized === "ready_for_human" ||
    normalized === "classified_ready"
  ) {
    return "classified_ready";
  }
  return undefined;
};

const resolvePrdHubStatusMode = (
  status: OptionalTextFlag,
): Effect.Effect<PrdHubStatusMode, TaskBoardError, never> => {
  if (status._tag !== "Some") {
    return Effect.succeed("inbox");
  }

  const resolved = normalizePrdHubStatusMode(status.value);
  if (resolved) {
    return Effect.succeed(resolved);
  }

  return Effect.fail(
    new TaskBoardError({
      message:
        'Invalid PRD task status. Use "inbox", "ready_for_agent", "ready_for_human", or "classified_ready".',
    }),
  );
};

const resolvePrdDependencyOverride = (
  deps: OptionalTextFlag,
): string | undefined => (deps._tag === "Some" ? deps.value : undefined);

const tasksFromPrdCommand = Command.make(
  "from-prd",
  {
    prdRef: prdRefArg,
    approve: prdApproveOption,
    status: prdStatusOption,
    deps: prdDepsOption,
    project: projectTargetOption,
  },
  ({ prdRef, approve, status, deps, project }) =>
    Effect.gen(function* () {
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const explicitHubStatusMode =
        !approve && status._tag === "Some"
          ? yield* resolvePrdHubStatusMode(status)
          : undefined;

      const result = yield* Effect.tryPromise({
        try: () =>
          runPrdDecompositionProposalFlowFromCli({
            cwd,
            prdRef,
            yes: approve,
            hubStatusMode: explicitHubStatusMode,
            dependencyOverride: resolvePrdDependencyOverride(deps),
            isTTY: process.stdin.isTTY,
          }),
        catch: toTaskBoardError,
      });

      yield* handlePrdDecompositionFlowDisplay(
        result,
        (message) => new TaskBoardError({ message }),
      );
    }),
);

const runHubTaskSyncCommand = (input: {
  readonly mode: "sync" | "pull" | "push";
  readonly cwd: string;
  readonly projectName: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly includeClosed?: boolean;
  readonly json?: boolean;
}) =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = input.cwd;
    const dryRun = input.dryRun === true;
    const shouldPreview = input.mode === "sync" || dryRun;

    if (shouldPreview) {
      const preview = yield* Effect.try({
        try: () =>
          syncHubTasksWithGithub({
            cwd,
            mode: input.mode,
            includeClosed: input.includeClosed,
            dryRun: true,
          }),
        catch: toTaskBoardError,
      });

      for (const line of formatHubTaskSyncPreviewLines(preview)) {
        yield* d.text(line);
      }

      if (dryRun) {
        return;
      }

      if (input.mode === "sync") {
        const isTTY = process.stdin.isTTY === true;
        if (!input.yes && !isTTY) {
          return yield* Effect.fail(
            new TaskBoardError({
              message:
                "archloop tasks sync mutates local Beads and GitHub state. Re-run with --yes in non-interactive mode, or use --dry-run to preview.",
            }),
          );
        }

        if (!input.yes && isTTY) {
          const approved = yield* Effect.tryPromise({
            try: async () => {
              const result = await clack.confirm({
                message: "Apply these Hub task sync changes?",
                initialValue: false,
              });
              if (clack.isCancel(result)) {
                throw new TaskBoardError({
                  message: "Task sync cancelled.",
                });
              }
              return result === true;
            },
            catch: toTaskBoardError,
          });

          if (!approved) {
            return yield* Effect.fail(
              new TaskBoardError({
                message: "Task sync cancelled.",
              }),
            );
          }
        }
      }
    }

    const startedAt = Date.now();
    const result = yield* Effect.try({
      try: () =>
        syncHubTasksWithGithub({
          cwd,
          mode: input.mode,
          includeClosed: input.includeClosed,
        }),
      catch: toTaskBoardError,
    });
    const durationSeconds = (Date.now() - startedAt) / 1000;

    const board = yield* Effect.try({
      try: () => loadHubTaskBoard(cwd),
      catch: toTaskBoardError,
    });
    const model = buildSyncResultModel({
      result,
      projectName: input.projectName,
      durationSeconds,
      tasks: board.tasks,
    });

    if (input.json) {
      yield* d.plain(formatSyncResultJson(model));
      return;
    }

    yield* d.section("", syncResultModelToBlocks(model));
  });

const tasksSyncCommand = Command.make(
  "sync",
  {
    yes: taskSyncYesOption,
    dryRun: taskSyncDryRunOption,
    includeClosed: taskSyncIncludeClosedOption,
    json: taskSyncJsonOption,
    project: projectTargetOption,
  },
  ({ yes, dryRun, includeClosed, json, project }) =>
    Effect.gen(function* () {
      const target = yield* resolveTaskCommandProjectTarget(project);
      return yield* runHubTaskSyncCommand({
        mode: "sync",
        cwd: target.repoRoot,
        projectName: target.projectName,
        yes,
        dryRun,
        includeClosed,
        json,
      });
    }),
);

const tasksPullCommand = Command.make(
  "pull",
  {
    includeClosed: taskSyncIncludeClosedOption,
    dryRun: taskSyncDryRunOption,
    json: taskSyncJsonOption,
    project: projectTargetOption,
  },
  ({ includeClosed, dryRun, json, project }) =>
    Effect.gen(function* () {
      const target = yield* resolveTaskCommandProjectTarget(project);
      return yield* runHubTaskSyncCommand({
        mode: "pull",
        cwd: target.repoRoot,
        projectName: target.projectName,
        includeClosed,
        dryRun,
        json,
      });
    }),
);

const tasksPushCommand = Command.make(
  "push",
  {
    dryRun: taskSyncDryRunOption,
    json: taskSyncJsonOption,
    project: projectTargetOption,
  },
  ({ dryRun, json, project }) =>
    Effect.gen(function* () {
      const target = yield* resolveTaskCommandProjectTarget(project);
      return yield* runHubTaskSyncCommand({
        mode: "push",
        cwd: target.repoRoot,
        projectName: target.projectName,
        dryRun,
        json,
      });
    }),
);

const tasksCommentCommand = Command.make(
  "comment",
  {
    id: taskIdArg,
    project: projectTargetOption,
    body: Options.text("body").pipe(
      Options.withDescription("Comment body"),
      Options.optional,
    ),
  },
  ({ id, body, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const task = yield* Effect.try({
        try: () => resolveHubTaskSelector(cwd, id),
        catch: toTaskBoardError,
      });
      const commentBody =
        body._tag === "Some"
          ? body.value
          : yield* Effect.tryPromise({
              try: async () => {
                const result = await clack.text({
                  message: "Comment body:",
                });
                if (clack.isCancel(result)) {
                  throw new TaskBoardError({
                    message: "Comment entry cancelled.",
                  });
                }
                return String(result);
              },
              catch: toTaskBoardError,
            });

      yield* Effect.try({
        try: () => appendHubTaskComment(cwd, task.id, commentBody),
        catch: toTaskBoardError,
      });

      yield* d.status(
        `Appended a comment to Beads task ${task.id}.`,
        "success",
      );
    }),
);

const tasksRecoverCommand = Command.make(
  "recover",
  { id: taskIdArg, project: projectTargetOption },
  ({ id, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const task = yield* Effect.try({
        try: () => resolveHubTaskSelector(cwd, id),
        catch: toTaskBoardError,
      });
      const result = yield* Effect.tryPromise({
        try: () => recoverHubTask({ cwd, taskId: task.id }),
        catch: toTaskBoardError,
      });

      yield* d.section(
        "",
        hubTaskRecoverSummaryModelToBlocks(
          buildHubTaskRecoverSummaryModel({ taskId: task.id, result }),
        ),
      );
      yield* d.status(formatHubRecoveryComment(result.summary), "info");
    }),
);

const normalizeResolveKeep = (
  value: import("effect").Option.Option<HubConflictKeep>,
): HubConflictKeep | undefined =>
  value._tag === "Some" ? value.value : undefined;

const tasksResolveCommand = Command.make(
  "resolve",
  {
    id: taskIdArg,
    keep: taskResolveKeepOption,
    yes: taskResolveYesOption,
    json: taskResolveJsonOption,
    project: projectTargetOption,
  },
  ({ id, keep, yes, json, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const target = yield* resolveTaskCommandProjectTarget(project);
      const cwd = target.repoRoot;
      const task = yield* Effect.try({
        try: () => resolveHubTaskSelector(cwd, id),
        catch: toTaskBoardError,
      });

      if (!hasHubTaskSyncConflict(task)) {
        return yield* Effect.fail(
          new TaskBoardError({
            message: `archloop tasks resolve ${task.id}: nothing to resolve. This task has no sync conflict. Try archloop tasks show ${task.id}.`,
          }),
        );
      }

      const github = createDefaultGithubIssueClient(cwd, process.env, {
        includeClosed: true,
      });
      const issue = yield* Effect.try({
        try: () => loadRemoteConflictIssue(task, github),
        catch: toTaskBoardError,
      });
      const { localValue, remoteValue, divergedFields, reason } =
        buildConflictFieldValues({ task, issue });
      const model = buildHubTaskConflictResolveModel({
        taskId: task.id,
        projectName: target.projectName,
        reason,
        localValue,
        remoteValue,
        divergedFields,
      });

      if (!json) {
        yield* d.section("", hubTaskConflictResolveModelToBlocks(model));
      }

      let resolvedKeep = normalizeResolveKeep(keep);
      const isTTY = process.stdin.isTTY === true;

      if (!resolvedKeep) {
        if (!isTTY || yes) {
          return yield* Effect.fail(
            new TaskBoardError({
              message:
                "archloop tasks resolve requires --keep local|remote in non-interactive mode (or without an interactive keep prompt). Example: archloop tasks resolve <id> --keep local",
            }),
          );
        }

        resolvedKeep = yield* Effect.tryPromise({
          try: async () => {
            const result = await clack.select({
              message: "Which side should win?",
              options: [
                {
                  value: "local" as const,
                  label: formatConflictKeepOptionLabel(
                    "local",
                    localValue,
                    divergedFields,
                  ),
                },
                {
                  value: "remote" as const,
                  label: formatConflictKeepOptionLabel(
                    "remote",
                    remoteValue,
                    divergedFields,
                  ),
                },
              ],
            });
            if (clack.isCancel(result)) {
              throw new TaskBoardError({
                message: "Task resolve cancelled.",
              });
            }
            return result;
          },
          catch: toTaskBoardError,
        });
      }

      const result = yield* Effect.try({
        try: () =>
          resolveHubTaskSyncConflict({
            cwd,
            taskId: task.id,
            keep: resolvedKeep!,
            github,
          }),
        catch: toTaskBoardError,
      });

      if (json) {
        yield* d.plain(formatResolveHubTaskConflictJson(result));
        return;
      }

      yield* d.status(
        `Resolved sync conflict for ${result.id} by keeping ${result.kept}.`,
        "success",
      );
    }),
);

const tasksDoctorCommand = Command.make(
  "doctor",
  { project: projectTargetOption },
  ({ project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const result = yield* Effect.tryPromise({
        try: () => doctorHubTaskState({ cwd }),
        catch: toTaskBoardError,
      });

      for (const line of formatHubTaskStateDoctorLines(result)) {
        yield* d.text(line);
      }
    }),
);

const tasksCleanupCommand = Command.make(
  "cleanup",
  {
    yes: taskCleanupYesOption,
    dryRun: taskCleanupDryRunOption,
    includeUnowned: taskCleanupIncludeUnownedOption,
    project: projectTargetOption,
  },
  ({ yes, dryRun, includeUnowned, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const isTTY = process.stdin.isTTY === true;
      const evaluation = yield* Effect.tryPromise({
        try: () => evaluateHubManagedBranchCleanup({ cwd }),
        catch: toTaskBoardError,
      });
      const cleanupPlan = planHubManagedBranchCleanup(evaluation, {
        includeUnowned,
      });
      const managedDeletionCount = cleanupPlan.managedBranches.length;
      const historicalDeletionCount = cleanupPlan.historicalBranches.length;

      for (const line of formatHubManagedBranchCleanupLines(evaluation, {
        dryRun,
        includeUnowned,
      })) {
        yield* d.text(line);
      }

      if (dryRun) {
        yield* d.status("Dry run for managed branch cleanup.", "info");
        return;
      }

      if (cleanupPlan.totalBranches === 0) {
        yield* d.status(
          "No safe branches were eligible for managed branch cleanup.",
          "info",
        );
        return;
      }

      if (!yes && !isTTY) {
        return yield* Effect.fail(
          new TaskBoardError({
            message:
              "archloop tasks cleanup mutates git refs. Re-run with --yes in non-interactive mode, or use --dry-run to preview.",
          }),
        );
      }

      if (!yes && isTTY) {
        const approved = yield* Effect.tryPromise({
          try: async () => {
            const message =
              historicalDeletionCount > 0
                ? `Delete ${managedDeletionCount} managed branch(s) and ${historicalDeletionCount} safe historical candidate(s)? Historical candidates require --include-unowned.`
                : `Delete ${managedDeletionCount} managed branch(s)?`;
            const result = await clack.confirm({
              message,
              initialValue: false,
            });
            if (clack.isCancel(result)) {
              throw new TaskBoardError({
                message: "Managed branch cleanup cancelled.",
              });
            }
            return result === true;
          },
          catch: toTaskBoardError,
        });

        if (!approved) {
          return yield* Effect.fail(
            new TaskBoardError({
              message: "Managed branch cleanup cancelled.",
            }),
          );
        }
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          cleanupHubManagedBranches({
            cwd,
            includeUnowned,
          }),
        catch: toTaskBoardError,
      });

      for (const line of formatHubManagedBranchCleanupLines(result.evaluation, {
        includeUnowned,
        deletedManagedBranches: result.deletedManagedBranches,
        deletedHistoricalBranches: result.deletedHistoricalBranches,
      })) {
        yield* d.text(line);
      }

      yield* d.status("Completed managed branch cleanup.", "success");
    }),
);

const tasksRepairStateCommand = Command.make(
  "repair-state",
  {
    id: taskIdArg,
    yes: taskRepairStateYesOption,
    project: projectTargetOption,
  },
  ({ id, yes, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const preview = yield* Effect.tryPromise({
        try: () => repairHubTaskState({ cwd, taskSelector: id }),
        catch: toTaskBoardError,
      });

      for (const line of formatHubTaskStateRepairLines(preview)) {
        yield* d.text(line);
      }

      if (preview.plannedRepairs.length === 0) {
        return;
      }

      const isTTY = process.stdin.isTTY === true;
      if (!yes && !isTTY) {
        return yield* Effect.fail(
          new TaskBoardError({
            message:
              "archloop tasks repair-state mutates local Beads state. Re-run with --yes in non-interactive mode after reviewing the preview.",
          }),
        );
      }

      if (!yes && isTTY) {
        const approved = yield* Effect.tryPromise({
          try: async () => {
            const result = await clack.confirm({
              message: `Apply local task-state repair for ${id}?`,
              initialValue: false,
            });
            if (clack.isCancel(result)) {
              throw new TaskBoardError({
                message: "Task state repair cancelled.",
              });
            }
            return result === true;
          },
          catch: toTaskBoardError,
        });

        if (!approved) {
          return yield* Effect.fail(
            new TaskBoardError({
              message: "Task state repair cancelled.",
            }),
          );
        }
      }

      const applied = yield* Effect.tryPromise({
        try: () => repairHubTaskState({ cwd, taskSelector: id, yes: true }),
        catch: toTaskBoardError,
      });
      for (const line of formatHubTaskStateRepairLines(applied)) {
        yield* d.text(line);
      }
    }),
);

const tasksDeleteCommand = Command.make(
  "delete",
  {
    selectors: taskSelectorsArg,
    yes: taskDeleteYesOption,
    dryRun: taskDeleteDryRunOption,
    cascade: taskDeleteCascadeOption,
    project: projectTargetOption,
  },
  ({ selectors, yes, dryRun, cascade, project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = yield* resolveTaskCommandRepoRoot(project);
      const tasks = yield* Effect.try({
        try: () => resolveHubTaskSelectors(cwd, selectors),
        catch: toTaskBoardError,
      });
      const taskIds = tasks.map((task) => task.id);
      const isTTY = process.stdin.isTTY === true;

      if (!dryRun && !yes && !isTTY) {
        return yield* Effect.fail(
          new TaskBoardError({
            message:
              "archloop tasks delete is destructive. Re-run with --yes in non-interactive mode, or use --dry-run to preview.",
          }),
        );
      }

      if (!dryRun && !yes && isTTY) {
        const preview = yield* Effect.try({
          try: () =>
            deleteHubTasks({
              cwd,
              taskIds,
              dryRun: true,
              cascade,
            }),
          catch: toTaskBoardError,
        });
        if (preview.trim().length > 0) {
          yield* d.text(preview.trim());
        }

        const approved = yield* Effect.tryPromise({
          try: async () => {
            const result = await clack.confirm({
              message: `Permanently delete local Beads task(s) ${taskIds.join(", ")}? This does not delete remote GitHub issues.`,
              initialValue: false,
            });
            if (clack.isCancel(result)) {
              throw new TaskBoardError({
                message: "Task delete cancelled.",
              });
            }
            return result === true;
          },
          catch: toTaskBoardError,
        });

        if (!approved) {
          return yield* Effect.fail(
            new TaskBoardError({
              message: "Task delete cancelled.",
            }),
          );
        }
      }

      const output = yield* Effect.try({
        try: () =>
          deleteHubTasks({
            cwd,
            taskIds,
            dryRun,
            cascade,
            force: !dryRun,
          }),
        catch: toTaskBoardError,
      });

      if (dryRun) {
        if (output.trim().length > 0) {
          yield* d.text(output.trim());
        }
        yield* d.status(
          `Dry run for local Beads task delete (${taskIds.join(", ")}).`,
          "info",
        );
        return;
      }

      if (output.trim().length > 0) {
        yield* d.text(output.trim());
      }
      yield* d.status(
        `Deleted local Beads tasks ${taskIds.join(", ")}.`,
        "success",
      );
    }),
);

const tasksCommand = Command.make("tasks", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Hub task board commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([
    tasksInitCommand,
    tasksListCommand,
    tasksShowCommand,
    tasksCreateCommand,
    tasksTriageCommand,
    tasksFromPrdCommand,
    tasksPullCommand,
    tasksPushCommand,
    tasksSyncCommand,
    tasksResolveCommand,
    tasksCommentCommand,
    tasksRecoverCommand,
    tasksDoctorCommand,
    tasksCleanupCommand,
    tasksRepairStateCommand,
    tasksDeleteCommand,
  ]),
);

const projectStatusCommand = Command.make(
  "status",
  {
    project: projectTargetOption,
  },
  ({ project }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const status = yield* resolveProjectTargetStatus(project);
      const cleanupEvaluation = yield* Effect.tryPromise({
        try: () => evaluateHubManagedBranchCleanup({ cwd: status.repoRoot }),
        catch: toTaskBoardError,
      });

      yield* d.section(
        "",
        hubProjectStatusSummaryModelToBlocks(
          buildHubProjectStatusSummaryModel({
            status,
            cleanupDiagnosticsLines:
              formatHubManagedBranchCleanupDiagnosticsLines(cleanupEvaluation),
          }),
        ),
      );
    }),
);

const checkHubOption = Options.boolean("hub").pipe(
  Options.withDescription(
    "Run the Hub-wide readiness slice of archloop check.",
  ),
  Options.withDefault(false),
);

const checkAllProjectsOption = Options.boolean("all-projects").pipe(
  Options.withDescription("Check every registered Hub project."),
  Options.withDefault(false),
);

const NO_SELECTED_PROJECT_MESSAGE =
  "No selected Hub project exists. Run `archloop project add` to register one, `archloop project select <name>` to choose one, or pass `--project <name>`.";

const hubReadinessCheckFailedError = (): HubFlowError =>
  new HubFlowError({
    message: "Hub readiness check failed.",
  });

const runHubReadinessCheck = (
  options: Parameters<typeof collectHubReadinessChecks>[0] = {},
) =>
  Effect.gen(function* () {
    const d = yield* Display;
    const report = yield* Effect.tryPromise({
      try: () => collectHubReadinessChecks(options),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });

    for (const section of report.sections) {
      yield* d.spinner(section.title, Effect.void);
    }

    for (const line of formatHubReadinessCheckLines(report)) {
      yield* d.text(line);
    }

    if (report.hasErrors) {
      return yield* Effect.fail(hubReadinessCheckFailedError());
    }
  });

const runHubProjectReadinessCheck = (
  project: HubProjectRegistryEntry,
): Effect.Effect<void, Error, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const report = yield* Effect.tryPromise({
      try: () => collectHubProjectReadinessCheck(project, { env: process.env }),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });

    for (const section of report.sections) {
      yield* d.spinner(section.title, Effect.void);
    }

    for (const line of formatHubProjectReadinessCheckLines(project, report)) {
      yield* d.text(line);
    }

    if (report.hasErrors) {
      return yield* Effect.fail(hubReadinessCheckFailedError());
    }
  });

const checkCommand = Command.make(
  "check",
  {
    hub: checkHubOption,
    project: projectTargetOption,
    allProjects: checkAllProjectsOption,
  },
  ({ hub, project, allProjects }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      let hasErrors = false;
      const hasExplicitProject = project._tag === "Some";

      const captureCheckFailure = (
        effect: Effect.Effect<void, Error, Display>,
      ): Effect.Effect<void, never, Display> =>
        effect.pipe(
          Effect.catchAll(() => {
            hasErrors = true;
            return Effect.void;
          }),
        );

      const runProjectCheck = (
        target: HubProjectRegistryEntry,
        statusMessage: string,
      ): Effect.Effect<void, never, Display> =>
        Effect.gen(function* () {
          yield* d.status(statusMessage, "info");
          yield* captureCheckFailure(runHubProjectReadinessCheck(target));
        });

      if (hub && (hasExplicitProject || allProjects)) {
        return yield* Effect.fail(
          new HubFlowError({
            message:
              "`--hub` cannot be combined with `--project` or `--all-projects`.",
          }),
        );
      }

      if (hasExplicitProject && allProjects) {
        return yield* Effect.fail(
          new HubFlowError({
            message: "`--project` and `--all-projects` are mutually exclusive.",
          }),
        );
      }

      const shouldRunHub = hub || (!hasExplicitProject && !allProjects);
      if (shouldRunHub) {
        yield* captureCheckFailure(runHubReadinessCheck({ env: process.env }));
      }

      if (hasExplicitProject) {
        const resolved = yield* Effect.tryPromise({
          try: () =>
            resolveHubProjectTarget({
              projectSelector: project.value,
              isTTY: false,
            }),
          catch: toProjectStatusError,
        });
        yield* runProjectCheck(
          resolved.project,
          `Checking explicit Hub project readiness for ${resolved.project.name}.`,
        );
      } else if (allProjects) {
        const targets = listHubProjects({ env: process.env });
        if (targets.length === 0) {
          yield* d.status("No Hub projects are registered yet.", "info");
        } else {
          for (const target of targets) {
            yield* runProjectCheck(
              target,
              `Checking Hub project readiness for ${target.name}.`,
            );
          }
        }
      } else if (!hub) {
        const selectedProject = readSelectedHubProject({ env: process.env });
        if (!selectedProject) {
          yield* d.status(NO_SELECTED_PROJECT_MESSAGE, "warn");
        } else {
          yield* runProjectCheck(
            selectedProject,
            `Checking selected Hub project readiness for ${selectedProject.name}.`,
          );
        }
      }

      if (hasErrors) {
        return yield* Effect.fail(hubReadinessCheckFailedError());
      }
    }),
);

const initializeSkipCheckOption = Options.boolean("skip-check").pipe(
  Options.withDescription("Skip the default quick Hub check after setup."),
  Options.withDefault(false),
);

const confirmInitializeConfigChange = (
  message: string,
): Effect.Effect<boolean, InitError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await clack.confirm({
        message,
        initialValue: false,
      });
      if (clack.isCancel(result)) {
        throw new InitError({ message: "Hub initialization cancelled." });
      }
      return result === true;
    },
    catch: (error) =>
      error instanceof InitError
        ? error
        : new InitError({
            message: error instanceof Error ? error.message : String(error),
          }),
  });

const listMissingInitializeHubEnvKeys = (): string[] => {
  const existing = resolveHubEnv({ env: process.env });
  return collectHubEnvKeysForSetup({ env: process.env }).filter(
    (key) => normalizeHubEnvValue(existing[key]).length === 0,
  );
};

const runInitializeHubAgentConfig = (): Effect.Effect<
  void,
  HubAgentConfigError | InitError,
  Display
> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const config = yield* Effect.try({
      try: () => readHubAgentConfig({ env: process.env }),
      catch: toHubAgentConfigError,
    });
    const missingRoles = listMissingHubAgentRoles(config, HUB_AGENT_ROLES);

    if (missingRoles.length > 0) {
      yield* d.status(
        `Missing Hub agent roles: ${missingRoles.join(", ")}. Starting guided setup.`,
        "info",
      );
      yield* Effect.tryPromise({
        try: () => promptInitializeHubAgentConfig(),
        catch: toHubAgentConfigError,
      });
      return;
    }

    const shouldChange = yield* confirmInitializeConfigChange(
      "Existing Hub agent roles found. Change provider/model settings now?",
    );
    if (shouldChange) {
      yield* Effect.tryPromise({
        try: () => promptInitHubAgentConfig(),
        catch: toHubAgentConfigError,
      });
      return;
    }

    yield* d.status("Keeping existing Hub agent role settings.", "info");
  });

const runInitializeHubEnv = (): Effect.Effect<
  void,
  HubEnvError | InitError,
  Display
> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const missingKeys = listMissingInitializeHubEnvKeys();

    if (missingKeys.length > 0) {
      yield* d.status(
        `Missing Hub env values: ${missingKeys.join(", ")}. Starting guided setup.`,
        "info",
      );
      yield* Effect.tryPromise({
        try: () => promptInitializeHubEnv(),
        catch: toHubEnvError,
      });
      return;
    }

    const shouldChange = yield* confirmInitializeConfigChange(
      "Existing Hub env values found. Change shared env credentials now?",
    );
    if (shouldChange) {
      yield* Effect.tryPromise({
        try: () => promptInitHubEnv(),
        catch: toHubEnvError,
      });
      return;
    }

    yield* d.status("Keeping existing Hub env values.", "info");
  });

const initializeCommand = Command.make(
  "initialize",
  {
    skipCheck: initializeSkipCheckOption,
  },
  ({ skipCheck }) =>
    Effect.gen(function* () {
      const d = yield* Display;

      if (!hasInteractiveTerminal()) {
        return yield* Effect.fail(
          new InitError({
            message:
              "Interactive Hub initialization requires a TTY. Use `archloop agent-config set-role`, `archloop env set`, and `archloop auth login` in scripts.",
          }),
        );
      }

      yield* d.intro("Initialize archLoop Hub");
      yield* d.status(
        "Configure shared Hub agent roles, env values, and auth guidance without touching any Hub project.",
        "info",
      );

      yield* runInitializeHubAgentConfig();
      yield* runInitializeHubEnv();

      for (const line of formatHubAuthShowLines()) {
        yield* d.text(line);
      }

      if (skipCheck) {
        yield* d.status("Skipped the quick Hub check.", "info");
      } else {
        yield* d.text(
          "Quick Hub check may make a small provider/model call. Run `archloop initialize --skip-check` to skip it.",
        );
        yield* runHubReadinessCheck({ env: process.env });
      }

      yield* d.status("Hub initialization complete.", "success");
      yield* d.text("archloop project add");
    }),
);

const toHubProjectRegistryError = (error: unknown): HubProjectRegistryError =>
  error instanceof HubProjectRegistryError
    ? error
    : new HubProjectRegistryError({
        message: error instanceof Error ? error.message : String(error),
      });

const projectAddNameOption = Options.text("name").pipe(
  Options.withDescription("User-facing Hub project name"),
  Options.optional,
);

const projectAddPathOption = Options.text("path").pipe(
  Options.withDescription("Path to an existing git repository"),
  Options.optional,
);

const projectAddProfileOption = Options.text("project-profile").pipe(
  Options.withDescription(
    "Project profile to use for the Hub project development contract",
  ),
  Options.optional,
);

const projectSelectNameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Hub project name"),
  Args.optional,
);

const projectRenameProjectArg = Args.text({ name: "project" }).pipe(
  Args.withDescription("Existing Hub project name or id"),
);

const projectRenameNameArg = Args.text({ name: "new-name" }).pipe(
  Args.withDescription("New user-facing Hub project name"),
);

const projectRelinkProjectArg = Args.text({ name: "project" }).pipe(
  Args.withDescription("Existing Hub project name or id"),
);

const projectRelinkPathOption = Options.text("path").pipe(
  Options.withDescription("New path to the existing git repository"),
);

const resolveInteractiveProjectName = async (
  initialValue: string,
): Promise<string> => {
  const prompted = await clack.text({
    message: "Hub project name",
    initialValue,
    validate: (input) => {
      const trimmed = input?.trim() ?? "";
      return trimmed.length === 0 ? "Project name is required" : undefined;
    },
  });
  if (clack.isCancel(prompted)) {
    throw new HubProjectRegistryError({
      message: "Project registration cancelled.",
    });
  }
  return String(prompted).trim();
};

const resolveInteractiveProjectPath = async (): Promise<string> => {
  const prompted = await clack.text({
    message: "Repo path",
    validate: (input) => {
      const trimmed = input?.trim() ?? "";
      return trimmed.length === 0 ? "Repo path is required" : undefined;
    },
  });
  if (clack.isCancel(prompted)) {
    throw new HubProjectRegistryError({
      message: "Project registration cancelled.",
    });
  }
  return String(prompted).trim();
};

const resolveInteractiveProjectSelection = async (
  projects: readonly HubProjectListEntry[],
): Promise<string> => {
  const result = await clack.select({
    message: "Select a Hub project:",
    options: projects.map((project) => ({
      value: project.name,
      label: project.name,
      hint: project.repoRoot,
    })),
  });
  if (clack.isCancel(result)) {
    throw new HubProjectRegistryError({
      message: "Project selection cancelled.",
    });
  }
  return String(result);
};

const resolveInteractiveProjectProfile = async (
  initialValue: string,
): Promise<string> => {
  const result = await clack.select({
    message: "Select a project profile:",
    initialValue,
    options: listProjectProfiles().map((profile) => ({
      value: profile.name,
      label: profile.label,
      hint: profile.description,
    })),
  });
  if (clack.isCancel(result)) {
    throw new HubProjectRegistryError({
      message: "Project profile selection cancelled.",
    });
  }
  return String(result);
};

const resolveProjectAddProfile = (
  repoRoot: string,
  projectProfile: string | undefined,
  display: DisplayService,
): Effect.Effect<string, HubProjectRegistryError> =>
  Effect.gen(function* () {
    const profileRecommendation = recommendHubProjectProfile(repoRoot);
    if (projectProfile && projectProfile.length > 0) {
      return projectProfile;
    }

    if (!hasInteractiveTerminal()) {
      return profileRecommendation.projectProfileName;
    }

    yield* display.text(
      formatHubProjectProfileRecommendation(profileRecommendation),
    );

    return yield* Effect.tryPromise({
      try: () =>
        resolveInteractiveProjectProfile(
          profileRecommendation.projectProfileName,
        ),
      catch: toHubProjectRegistryError,
    });
  });

const confirmProjectAddTaskStoreInitialization = async (): Promise<boolean> => {
  const response = await clack.confirm({
    message: "Initialize the local task store now?",
    initialValue: true,
  });
  return clack.isCancel(response) ? false : response === true;
};

const initializeProjectAddTaskStore = (
  display: DisplayService,
  repoRoot: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    try {
      const result = initHubTaskStore(repoRoot);
      const output = result.output.trim();
      if (output.length > 0) {
        yield* display.text(output);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield* display.status(
        `Skipped local task store initialization: ${message}`,
        "warn",
      );
      return false;
    }
  });

const projectAddCommand = Command.make(
  "add",
  {
    name: projectAddNameOption,
    path: projectAddPathOption,
    projectProfile: projectAddProfileOption,
  },
  ({ name, path, projectProfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      let projectName = optionalTextValue(name)?.trim() ?? "";
      let repoPath = optionalTextValue(path)?.trim() ?? "";
      let selectedProjectProfile = optionalTextValue(projectProfile)?.trim();

      if (projectName.length === 0 || repoPath.length === 0) {
        if (!hasInteractiveTerminal()) {
          return yield* Effect.fail(
            new HubProjectRegistryError({
              message:
                "archloop project add requires --name and --path in non-interactive mode.",
            }),
          );
        }
      }

      if (repoPath.length === 0) {
        repoPath = yield* Effect.tryPromise({
          try: () => resolveInteractiveProjectPath(),
          catch: toHubProjectRegistryError,
        });
      }

      const repoRoot = yield* Effect.try({
        try: () => resolveHubProjectRegistrationRepoRoot(repoPath),
        catch: toHubProjectRegistryError,
      });

      if (projectName.length === 0) {
        projectName = yield* Effect.tryPromise({
          try: () =>
            resolveInteractiveProjectName(suggestHubProjectName(repoRoot)),
          catch: toHubProjectRegistryError,
        });
      }

      selectedProjectProfile = yield* resolveProjectAddProfile(
        repoRoot,
        selectedProjectProfile,
        d,
      );

      const result = yield* Effect.try({
        try: () =>
          registerHubProject({
            repoPath,
            projectName,
            projectProfileName: selectedProjectProfile,
            initializeTaskStore: false,
          }),
        catch: toHubProjectRegistryError,
      });

      let taskStoreInitialized = result.taskStoreInitialized;
      if (hasInteractiveTerminal()) {
        const shouldInitializeTaskStore = yield* Effect.tryPromise({
          try: () => confirmProjectAddTaskStoreInitialization(),
          catch: toHubProjectRegistryError,
        });
        if (shouldInitializeTaskStore) {
          taskStoreInitialized = yield* initializeProjectAddTaskStore(
            d,
            result.project.repoRoot,
          );
        }
      }

      yield* d.section(
        "",
        hubProjectRegisterSummaryModelToBlocks(
          buildHubProjectRegisterSummaryModel({
            result,
            taskStoreInitialized,
          }),
        ),
      );
      yield* d.status(
        `Registered Hub project ${result.project.name} and selected it for this CLI.`,
        "success",
      );
      if (!taskStoreInitialized) {
        yield* d.text(
          "Run `archloop tasks init` in this repository later to initialize the local task store.",
        );
      }
    }),
);

const projectListCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const projects = yield* Effect.try({
      try: () => listHubProjects(),
      catch: toHubProjectRegistryError,
    });

    if (projects.length === 0) {
      yield* d.status("No Hub projects registered yet.", "info");
      yield* d.text("Run `archloop project add` to register an existing repo.");
      return;
    }

    const projections = yield* Effect.try({
      try: () => resolveHubProjectListProjections(projects),
      catch: toHubProjectRegistryError,
    });

    yield* d.section(
      "",
      hubProjectListSummaryModelToBlocks(
        buildHubProjectListSummaryModel(projections),
      ),
    );
  }),
);

const projectSelectCommand = Command.make(
  "select",
  {
    name: projectSelectNameArg,
  },
  ({ name }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      let projectName = optionalTextValue(name)?.trim();

      if (!projectName) {
        const projects = yield* Effect.try({
          try: () => listHubProjects(),
          catch: toHubProjectRegistryError,
        });
        if (projects.length === 0) {
          return yield* Effect.fail(
            new HubProjectRegistryError({
              message:
                "No Hub projects are registered yet. Run `archloop project add` first.",
            }),
          );
        }
        if (!hasInteractiveTerminal()) {
          return yield* Effect.fail(
            new HubProjectRegistryError({
              message:
                "archloop project select requires a project name in non-interactive mode.",
            }),
          );
        }

        projectName = yield* Effect.tryPromise({
          try: () => resolveInteractiveProjectSelection(projects),
          catch: toHubProjectRegistryError,
        });
      }

      const project = yield* Effect.try({
        try: () => selectHubProject({ projectSelector: projectName }),
        catch: toHubProjectRegistryError,
      });
      yield* d.status(`Selected Hub project ${project.name}.`, "success");
    }),
);

const projectRenameCommand = Command.make(
  "rename",
  {
    project: projectRenameProjectArg,
    newName: projectRenameNameArg,
  },
  ({ project, newName }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const result = yield* Effect.try({
        try: () =>
          renameHubProject({
            projectSelector: project,
            newProjectName: newName,
            env: process.env,
          }),
        catch: toHubProjectRegistryError,
      });

      yield* d.section(
        "",
        hubProjectRenameSummaryModelToBlocks(
          buildHubProjectRenameSummaryModel(result),
        ),
      );
      yield* d.status(
        `Renamed Hub project ${result.previousProjectName} to ${result.project.name}.`,
        "success",
      );
    }),
);

const projectRelinkCommand = Command.make(
  "relink",
  {
    project: projectRelinkProjectArg,
    path: projectRelinkPathOption,
  },
  ({ project, path }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const result = yield* Effect.try({
        try: () =>
          relinkHubProject({
            projectSelector: project,
            repoPath: path,
            env: process.env,
          }),
        catch: toHubProjectRegistryError,
      });

      yield* d.section(
        "",
        hubProjectRelinkSummaryModelToBlocks(
          buildHubProjectRelinkSummaryModel(result),
        ),
      );
      yield* d.status(
        `Relinked Hub project ${result.project.name} to ${result.project.repoRoot}.`,
        "success",
      );
    }),
);

const projectConfigureCommand = Command.make(
  "configure",
  {
    project: projectTargetOption,
    projectProfile: projectConfigureProjectProfileOption,
  },
  ({ project, projectProfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const status = yield* resolveProjectTargetStatus(project);

      const availableProjectProfiles = formatProjectProfileNames();
      let selectedProjectProfile: string;

      if (projectProfile._tag === "Some") {
        selectedProjectProfile = projectProfile.value;
      } else {
        if (!process.stdin.isTTY) {
          yield* Effect.fail(
            new ProjectStatusError({
              message:
                "Project configure requires --project-profile in non-interactive mode. Available: " +
                availableProjectProfiles,
            }),
          );
        }

        selectedProjectProfile = yield* Effect.tryPromise({
          try: () =>
            resolveInteractiveProjectProfile(DEFAULT_PROJECT_PROFILE_NAME),
          catch: toProjectStatusError,
        });
      }

      const contract = yield* Effect.try({
        try: () =>
          configureHubProjectDevelopmentContract({
            repoRoot: status.repoRoot,
            hubProjectDir: status.hubProjectDir,
            projectProfileName: selectedProjectProfile,
          }),
        catch: toProjectStatusError,
      });

      yield* d.section(
        "",
        hubProjectConfigureSummaryModelToBlocks(
          buildHubProjectConfigureSummaryModel({
            repoRoot: status.repoRoot,
            hubProjectDir: status.hubProjectDir,
            contract,
            editOutcome: describeProjectConfigureEditOutcome(contract),
          }),
        ),
      );

      yield* d.status(describeProjectConfigureStatus(contract), "success");
    }),
);

const projectCommand = Command.make("project", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Hub project commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([
    projectAddCommand,
    projectListCommand,
    projectSelectCommand,
    projectRenameCommand,
    projectRelinkCommand,
    projectStatusCommand,
    projectConfigureCommand,
  ]),
);

const getHubFlowIds = (): string =>
  listHubFlows()
    .map((flow) => flow.id)
    .join(", ");

const flowOption = Options.text("flow").pipe(
  Options.withDescription(`Hub flow id (${getHubFlowIds()})`),
  Options.optional,
);

const flowInputOption = Options.text("input").pipe(
  Options.withDescription(
    "Flow-specific input value (PRD path for prd-decomposition; optional task query for triage)",
  ),
  Options.optional,
);

const flowYesOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Skip the interactive run-start debounce (and proposal prompts) and start immediately.",
  ),
  Options.withDefault(false),
);

const flowDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription(
    "Render the Hub run plan section and exit without starting the flow.",
  ),
  Options.withDefault(false),
);

const flowBatchStrategyOption = Options.text("batch-strategy").pipe(
  Options.withDescription(
    "Task-board batch selection strategy (default planned; planned uses an agent planner when available, limited selects ready-queue order up to --max-tasks, conservative selects one eligible ready task)",
  ),
  Options.optional,
);

const flowMaxTasksOption = Options.text("max-tasks").pipe(
  Options.withDescription(
    "Maximum tasks to select for a task-board flow batch (1-10, default 3)",
  ),
  Options.optional,
);

const flowMaxBatchesOption = Options.text("max-batches").pipe(
  Options.withDescription(
    "Maximum batches to complete in one task-board flow run (positive integer; unlimited by default)",
  ),
  Options.optional,
);

const flowIdleTimeoutOption = Options.text("idle-timeout").pipe(
  Options.withDescription(
    "Agent idle timeout in seconds (default 600). Resets on agent output; does not fire while an agent-spawned child process is still running.",
  ),
  Options.optional,
);

const flowOutputOption = Options.choice("output", ["auto", "plain", "json"] as [
  "auto",
  "plain",
  "json",
]).pipe(
  Options.withDescription(
    "Run output mode (auto for a live TTY view with plain fallback, plain for deterministic text, json for versioned JSONL)",
  ),
  Options.optional,
);

const flowNoColorOption = Options.boolean("no-color").pipe(
  Options.withDescription(
    "Disable color while preserving live terminal labels and symbols.",
  ),
  Options.withDefault(false),
);

const flowStreamOption = Options.boolean("stream").pipe(
  Options.withDescription(
    "Force append-only line output instead of the alt-screen dashboard (useful for CI logs and piped consumers).",
  ),
  Options.withDefault(false),
);

const runProjectArg = Args.text({ name: "project" }).pipe(
  Args.withDescription(
    "Hub project name or legacy repo path (use . temporarily for the current repo)",
  ),
  Args.optional,
);

const runProjectOption = Options.text("project").pipe(
  Options.withDescription("Hub project name"),
  Options.optional,
);

const isLegacyRunProjectTarget = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  return (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~") ||
    isAbsolute(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  );
};

const resolveInteractiveRunFlowSelection = async (
  flows: ReturnType<typeof listHubFlows>,
): Promise<string> => {
  const result = await clack.select({
    message: "Select a Hub flow:",
    options: flows.map((flow) => ({
      value: flow.id,
      label: flow.id,
      hint: flow.description,
    })),
  });
  if (clack.isCancel(result)) {
    throw new HubFlowError({
      message: "Flow selection cancelled.",
    });
  }

  return String(result);
};

const resolveRunFlowDefinition = async (
  flowId: string | undefined,
  isInteractive: boolean,
): Promise<HubFlowDefinition> => {
  const requireFlowDefinition = (value: string): HubFlowDefinition => {
    const flowDefinition = getHubFlowDefinition(value);
    if (!flowDefinition) {
      throw new HubFlowError({
        message: `Unknown Hub flow "${value}". Available flows: ${getHubFlowIds()}`,
      });
    }
    return flowDefinition;
  };

  if (flowId) {
    return requireFlowDefinition(flowId);
  }

  if (!isInteractive) {
    throw new HubFlowError({
      message:
        "No Hub flow was provided. Run `archloop run --flow <id>`, `archloop run <project-name> --flow <id>`, or `archloop run --project <name> --flow <id>`.",
    });
  }

  return requireFlowDefinition(
    await resolveInteractiveRunFlowSelection(listHubFlows()),
  );
};

const promptRequiredRunFlowInput = async (
  flowInput: HubFlowInputSchema,
): Promise<string> => {
  const promptedInput = await clack.text({
    message: flowInput.label,
    validate: (value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed.length === 0
        ? `${flowInput.label} is required`
        : undefined;
    },
  });
  if (clack.isCancel(promptedInput)) {
    throw new HubFlowError({
      message: "Flow input selection cancelled.",
    });
  }

  return String(promptedInput).trim();
};

const resolveRunFlowInput = async ({
  flowDefinition,
  cwd,
  rawInput,
  isInteractive,
}: {
  readonly flowDefinition: HubFlowDefinition;
  readonly cwd: string;
  readonly rawInput: string | undefined;
  readonly isInteractive: boolean;
}): Promise<ValidatedHubFlowInput | undefined> => {
  if (rawInput && !flowDefinition.input) {
    throw new HubFlowError({
      message: `Hub flow "${flowDefinition.id}" does not accept --input.`,
    });
  }

  const flowInput = flowDefinition.input;
  if (!flowInput) {
    return undefined;
  }

  let resolvedInput = rawInput;
  if (resolvedInput === undefined && flowInput.required && isInteractive) {
    resolvedInput = await promptRequiredRunFlowInput(flowInput);
  }

  return validateHubFlowInput(flowDefinition.id, {
    cwd,
    rawInput: resolvedInput,
  });
};

type RunProjectResolution = {
  readonly repoRoot: string;
  readonly targetProjectName?: string;
  readonly legacyProjectTarget?: string;
};

const resolveRunProjectTarget = ({
  projectFlag,
  positionalProject,
  isInteractive,
  display,
  showLegacyGuidance,
}: {
  readonly projectFlag: string | undefined;
  readonly positionalProject: string | undefined;
  readonly isInteractive: boolean;
  readonly display: DisplayService;
  readonly showLegacyGuidance: boolean;
}): Effect.Effect<RunProjectResolution, HubFlowError> =>
  Effect.gen(function* () {
    const legacyProjectTarget =
      projectFlag === undefined &&
      positionalProject !== undefined &&
      isLegacyRunProjectTarget(positionalProject)
        ? positionalProject
        : undefined;

    if (legacyProjectTarget) {
      const repoRoot = yield* Effect.try({
        try: () => resolveGitRepoRoot(legacyProjectTarget),
        catch: toHubFlowError,
      });
      if (showLegacyGuidance) {
        yield* display.status(
          "Legacy path target detected. Run `archloop project add` and `archloop project select <name>` to target this repo by Hub project name next time.",
          "warn",
        );
      }
      return {
        repoRoot,
        legacyProjectTarget,
      };
    }

    const target = yield* Effect.tryPromise({
      try: () =>
        resolveHubProjectTarget({
          projectSelector: projectFlag ?? positionalProject,
          isTTY: isInteractive,
          selectProject: resolveInteractiveProjectSelection,
        }),
      catch: toHubFlowError,
    });

    return {
      repoRoot: target.project.repoRoot,
      targetProjectName: target.project.name,
    };
  });

const resolveRunPlanReadyCount = (repoRoot: string): number => {
  try {
    return selectHubFlowTasks(loadHubTaskBoard(repoRoot)).length;
  } catch {
    return 0;
  }
};

const requireProposalRunInput = (
  flowDefinition: HubFlowDefinition,
  validatedInput: ValidatedHubFlowInput | undefined,
): ValidatedHubFlowInput => {
  if (validatedInput) {
    return validatedInput;
  }

  throw new HubFlowError({
    message: `Hub flow "${flowDefinition.id}" requires flow input.`,
  });
};

const toHubAgentConfigError = (error: unknown): HubAgentConfigError =>
  error instanceof HubAgentConfigError
    ? error
    : new HubAgentConfigError({
        message: error instanceof Error ? error.message : String(error),
      });

const parseHubAgentRoleOptions = (
  raw: string | undefined,
): Record<string, string> | undefined => {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  const options: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new HubAgentConfigError({
        message: `Invalid --options value "${trimmed}". Use comma-separated key=value pairs.`,
      });
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    options[key] = value;
  }

  return Object.keys(options).length > 0 ? options : undefined;
};

const agentConfigPathCommand = Command.make("path", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.text(resolveHubAgentConfigPath());
  }),
);

const agentConfigShowCommand = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const config = yield* Effect.try({
      try: () => readHubAgentConfig(),
      catch: toHubAgentConfigError,
    });
    for (const line of formatHubAgentConfigShowLines(config)) {
      yield* d.text(line);
    }
  }),
);

const agentConfigProviderOption = Options.text("provider").pipe(
  Options.withDescription(
    "Agent provider (claude-code, pi, codex, cursor, opencode)",
  ),
  Options.optional,
);

const agentConfigModelOption = Options.text("model").pipe(
  Options.withDescription("Agent model"),
  Options.optional,
);

const agentConfigOptionsOption = Options.text("options").pipe(
  Options.withDescription(
    "Comma-separated provider options as key=value pairs (e.g. effort=medium,mode=plan)",
  ),
  Options.optional,
);

const runAgentConfigInit = () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const config = yield* Effect.tryPromise({
      try: () => promptInitHubAgentConfig(),
      catch: toHubAgentConfigError,
    });
    yield* d.section(
      "",
      hubAgentConfigInitSummaryModelToBlocks(
        buildHubAgentConfigInitSummaryModel({
          config,
          configPath: resolveHubAgentConfigPath(),
        }),
      ),
    );
  });

const agentConfigInitCommand = Command.make("init", {}, runAgentConfigInit);

const agentConfigConfigureCommand = Command.make(
  "configure",
  {},
  runAgentConfigInit,
);

const agentConfigSetRoleCommand = Command.make(
  "set-role",
  {
    role: Args.text({ name: "role" }).pipe(
      Args.withDescription(
        "Hub agent role (planning, triage, implementation, review, merge, recovery)",
      ),
    ),
    provider: agentConfigProviderOption,
    model: agentConfigModelOption,
    options: agentConfigOptionsOption,
  },
  ({ role, provider, model, options }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const parsedOptions = yield* Effect.try({
        try: () => parseHubAgentRoleOptions(optionalTextValue(options)),
        catch: toHubAgentConfigError,
      });
      const entry = yield* Effect.tryPromise({
        try: () =>
          resolveHubAgentRoleEntry({
            role,
            provider: optionalTextValue(provider),
            model: optionalTextValue(model),
            options: parsedOptions,
            isTTY: process.stdin.isTTY,
            configureRole: promptHubAgentRoleSetup,
          }),
        catch: toHubAgentConfigError,
      });
      const saved = yield* Effect.try({
        try: () => setHubAgentRole(role, entry),
        catch: toHubAgentConfigError,
      });
      yield* d.section(
        "",
        hubAgentConfigSetRoleSummaryModelToBlocks(
          buildHubAgentConfigSetRoleSummaryModel({
            role: saved.role,
            entry: saved.entry,
          }),
        ),
      );
    }),
);

const agentConfigCommand = Command.make("agent-config", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Hub-wide agent role configuration. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([
    agentConfigPathCommand,
    agentConfigShowCommand,
    agentConfigInitCommand,
    agentConfigConfigureCommand,
    agentConfigSetRoleCommand,
  ]),
);

const toHubEnvError = (error: unknown): HubEnvError =>
  error instanceof HubEnvError
    ? error
    : new HubEnvError({
        message: error instanceof Error ? error.message : String(error),
      });

const envPathCommand = Command.make("path", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.text(resolveHubEnvPath());
  }),
);

const envShowCommand = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    for (const line of formatHubEnvShowLines()) {
      yield* d.text(line);
    }
  }),
);

const runEnvInit = () =>
  Effect.gen(function* () {
    const d = yield* Display;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return yield* Effect.fail(
        new HubEnvError({
          message:
            "Interactive Hub env setup requires a TTY. Use `archloop env set <key> <value>` in scripts. For Codex CLI session auth, use `archloop auth login codex` instead of `OPENAI_KEY`; `OPENAI_KEY` uses OpenAI API billing.",
        }),
      );
    }

    yield* Effect.tryPromise({
      try: () => promptInitHubEnv(),
      catch: toHubEnvError,
    });
    yield* d.status("Hub environment configured.", "success");
  });

const envInitCommand = Command.make("init", {}, runEnvInit);

const envConfigureCommand = Command.make("configure", {}, runEnvInit);

const envSetKeyArg = Args.text({ name: "key" }).pipe(
  Args.withDescription(
    "Environment variable name (for example CURSOR_API_KEY)",
  ),
);

const envSetValueArg = Args.text({ name: "value" }).pipe(
  Args.withDescription("Environment variable value"),
  Args.optional,
);

const envSetCommand = Command.make(
  "set",
  {
    key: envSetKeyArg,
    value: envSetValueArg,
  },
  ({ key, value }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const envKey = key.trim();
      if (!isHubEnvKnownKey(envKey)) {
        return yield* Effect.fail(
          new HubEnvError({
            message: `Unknown Hub env key "${envKey}". Known keys: CURSOR_API_KEY, ANTHROPIC_API_KEY, OPENAI_KEY, OPENCODE_API_KEY, GH_TOKEN.`,
          }),
        );
      }

      let envValue = optionalTextValue(value)?.trim() ?? "";
      if (envValue.length === 0) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          return yield* Effect.fail(
            new HubEnvError({
              message: `archloop env set ${envKey} <value> requires a value in non-interactive mode.`,
            }),
          );
        }

        const prompted = yield* Effect.promise(() =>
          clack.password({
            message: `${envKey} value`,
            validate: (input) => {
              const trimmed = input?.trim() ?? "";
              return trimmed.length === 0 ? "Value is required" : undefined;
            },
          }),
        );
        if (clack.isCancel(prompted)) {
          return yield* Effect.fail(
            new HubEnvError({ message: "Hub env setup cancelled." }),
          );
        }
        envValue = String(prompted).trim();
      }

      const savedPath = yield* Effect.try({
        try: () => upsertHubEnvKey(envKey, envValue),
        catch: toHubEnvError,
      });
      yield* d.section(
        "",
        hubEnvSetSummaryModelToBlocks(
          buildHubEnvSetSummaryModel({ key: envKey, path: savedPath }),
        ),
      );
    }),
);

const envCommand = Command.make("env", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Hub-wide environment variables for archLoop flows. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([
    envPathCommand,
    envShowCommand,
    envInitCommand,
    envConfigureCommand,
    envSetCommand,
  ]),
);

const toHubAuthError = (error: unknown): HubAuthError =>
  error instanceof HubAuthError
    ? error
    : new HubAuthError({
        message: error instanceof Error ? error.message : String(error),
      });

const authPathProviderArg = Args.text({ name: "provider" }).pipe(
  Args.withDescription("Provider auth path to print (codex or github)"),
);

const authPathCommand = Command.make(
  "path",
  { provider: authPathProviderArg },
  ({ provider }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const path = yield* Effect.try({
        try: () => resolveProviderHubAuthDir(provider.trim()),
        catch: toHubAuthError,
      });
      yield* d.text(path);
    }),
);

const authShowCommand = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    for (const line of formatHubAuthShowLines()) {
      yield* d.text(line);
    }
  }),
);

const runHubAuthLogin = (provider: "codex" | "github") =>
  Effect.gen(function* () {
    const d = yield* Display;
    const envVar = getHubAuthEnvVar(provider);
    const authDir = ensureHubAuthDir(provider);
    const command = getHubAuthLoginCommand(provider);
    const actionableCommand = `${envVar}=${authDir} ${command}`;

    if (provider === "codex") {
      yield* d.status(
        "Codex supports either OPENAI_KEY API billing through `archloop env set OPENAI_KEY <value>` or a Codex/ChatGPT CLI login session through this command.",
        "info",
      );
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return yield* Effect.fail(
        new HubAuthError({
          message: `Interactive ${provider} login requires a TTY. Run \`${actionableCommand}\` from an interactive shell, or use \`archloop env set ${provider === "codex" ? "OPENAI_KEY" : "GH_TOKEN"} <value>\`.`,
        }),
      );
    }

    yield* d.status(`Running ${command} with ${envVar}=${authDir}`, "info");
    yield* Effect.try({
      try: () =>
        execSync(command, {
          stdio: "inherit",
          env: {
            ...process.env,
            [envVar]: authDir,
          },
        }),
      catch: (error) =>
        new HubAuthError({
          message: `${provider === "codex" ? "Codex" : "GitHub"} login failed. Retry with \`${actionableCommand}\`. ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
    });
    yield* d.section(
      "",
      hubAuthLoginSummaryModelToBlocks(
        buildHubAuthLoginSummaryModel({ provider, envVar, authDir }),
      ),
    );
  });

const authLoginCodexCommand = Command.make("codex", {}, () =>
  runHubAuthLogin("codex"),
);

const authLoginGithubCommand = Command.make("github", {}, () =>
  runHubAuthLogin("github"),
);

const authLoginCommand = Command.make("login", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Provider login commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([authLoginCodexCommand, authLoginGithubCommand]),
);

const authCommand = Command.make("auth", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Hub provider auth sessions. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([authShowCommand, authPathCommand, authLoginCommand]),
);

const toHubFlowError = (error: unknown): HubFlowError =>
  error instanceof HubFlowError
    ? error
    : new HubFlowError({
        message: error instanceof Error ? error.message : String(error),
      });

const isHubRunCancellationError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly _tag?: unknown;
  };
  return (
    candidate.name === "AbortError" ||
    candidate.code === "ABORT_ERR" ||
    candidate._tag === "InterruptedException"
  );
};

const formatEarlyHubRunJsonFailure = (input: {
  readonly flowId: string;
  readonly hubProject?: string;
  readonly error: unknown;
}): string => {
  const rawDiagnostic =
    input.error instanceof Error ? input.error.message : String(input.error);
  const diagnostic =
    rawDiagnostic
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.slice(0, 240) ?? "Run failed.";
  return JSON.stringify({
    schemaVersion: 1,
    eventId: "unknown:output:1",
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: "run_failed",
    runId: "unknown",
    flowId: input.flowId,
    ...(input.hubProject ? { hubProject: input.hubProject } : {}),
    outcome: "failed",
    summary: "Run failed",
    diagnostic,
    exitCode: 1,
    logs: "",
  });
};

const runCommand = Command.make(
  "run",
  {
    projectPath: runProjectArg,
    project: runProjectOption,
    flow: flowOption,
    input: flowInputOption,
    yes: flowYesOption,
    dryRun: flowDryRunOption,
    batchStrategy: flowBatchStrategyOption,
    maxTasks: flowMaxTasksOption,
    maxBatches: flowMaxBatchesOption,
    idleTimeout: flowIdleTimeoutOption,
    output: flowOutputOption,
    noColor: flowNoColorOption,
    stream: flowStreamOption,
  },
  ({
    projectPath,
    project,
    flow,
    input,
    yes,
    dryRun,
    batchStrategy,
    maxTasks,
    maxBatches,
    idleTimeout,
    output,
    noColor,
    stream,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const outputMode = output._tag === "Some" ? output.value : "auto";
      const isPlainOutput = outputMode === "plain";
      const isJsonOutput = outputMode === "json";
      const isMachineOutput = isPlainOutput || isJsonOutput;
      const autoOutputResolution =
        outputMode === "auto"
          ? resolveHubRunOutputMode({
              isTTY: process.stdout.isTTY,
              columns: process.stdout.columns,
              rows: process.stdout.rows,
              colorEnabled: !noColor,
              cursorControl: supportsHubRunCursorControl(process.env),
              env: process.env,
            })
          : undefined;
      const autoDisablesPrompts =
        autoOutputResolution?.mode === "plain" &&
        autoOutputResolution.reason === "ci";
      const isInteractive =
        hasInteractiveTerminal() && !isMachineOutput && !autoDisablesPrompts;
      const projectFlag = trimOptionalText(optionalTextValue(project));
      const positionalProject = trimOptionalText(
        optionalTextValue(projectPath),
      );
      const { repoRoot, targetProjectName, legacyProjectTarget } =
        yield* resolveRunProjectTarget({
          projectFlag,
          positionalProject,
          isInteractive,
          display: d,
          showLegacyGuidance: !isMachineOutput,
        });
      const initialFlowId = trimOptionalText(optionalTextValue(flow));
      let flowDefinition = yield* Effect.tryPromise({
        try: () => resolveRunFlowDefinition(initialFlowId, isInteractive),
        catch: toHubFlowError,
      });
      const maxBatchesValue = optionalTextValue(maxBatches);
      const flowMaxBatches = yield* Effect.try({
        try: () =>
          maxBatchesValue !== undefined
            ? parseHubFlowMaxBatches(maxBatchesValue)
            : undefined,
        catch: toHubFlowError,
      });
      const idleTimeoutValue = optionalTextValue(idleTimeout);
      const flowIdleTimeoutSeconds = yield* Effect.try({
        try: () =>
          idleTimeoutValue !== undefined
            ? parseHubFlowIdleTimeoutSeconds(idleTimeoutValue)
            : undefined,
        catch: toHubFlowError,
      });
      const rejectProposalWithMaxBatches = (
        definition: HubFlowDefinition,
      ): Effect.Effect<void, HubFlowError> =>
        definition.kind === "proposal" && flowMaxBatches !== undefined
          ? Effect.fail(
              new HubFlowError({
                message: "Proposal flows do not support --max-batches.",
              }),
            )
          : Effect.void;
      yield* rejectProposalWithMaxBatches(flowDefinition);

      const rawInput = optionalTextValue(input);
      let validatedInput = yield* Effect.tryPromise({
        try: () =>
          resolveRunFlowInput({
            flowDefinition,
            cwd: repoRoot,
            rawInput,
            isInteractive,
          }),
        catch: toHubFlowError,
      });

      // Pre-start plan + optional debounce (Phase 3b). Edit (`e`) re-selects flow.
      for (;;) {
        const showDecoratedPlan =
          isInteractive ||
          dryRun ||
          !(
            flowDefinition.kind === "task-board" ||
            flowDefinition.kind === "proposal"
          );

        if (validatedInput && showDecoratedPlan) {
          yield* d.status(
            formatValidatedHubFlowInputSummary(validatedInput),
            "info",
          );
        }

        if (showDecoratedPlan) {
          const model = buildRunPlanModel({
            flowId: flowDefinition.id,
            repoRoot,
            projectName: targetProjectName,
            legacyProjectTarget,
            readyCount: resolveRunPlanReadyCount(repoRoot),
            flowInputSummary: validatedInput
              ? formatValidatedHubFlowInputSummary(validatedInput)
              : undefined,
          });
          yield* d.section("", runPlanModelToBlocks(model));
        }

        if (dryRun) {
          yield* d.status("Dry run — Hub flow not started.", "info");
          return;
        }

        if (!(isInteractive && !yes)) {
          break;
        }

        const outcome = yield* Effect.tryPromise({
          try: () =>
            waitForKeypress({
              timeoutMs: RUN_START_DEBOUNCE_MS,
            }),
          catch: toHubFlowError,
        });

        if (outcome === "cancel") {
          process.exitCode = 130;
          yield* d.status("Run cancelled.", "warn");
          return;
        }

        if (outcome === "edit") {
          flowDefinition = yield* Effect.tryPromise({
            try: () => resolveRunFlowDefinition(undefined, true),
            catch: toHubFlowError,
          });
          yield* rejectProposalWithMaxBatches(flowDefinition);
          validatedInput = yield* Effect.tryPromise({
            try: () =>
              resolveRunFlowInput({
                flowDefinition,
                cwd: repoRoot,
                rawInput,
                isInteractive: true,
              }),
            catch: toHubFlowError,
          });
          continue;
        }

        break;
      }

      const usesTaskBoardOutput = flowDefinition.kind === "task-board";
      const usesStructuredRunOutput =
        usesTaskBoardOutput || flowDefinition.kind === "proposal";
      let activeTaskBoardOutput: "live" | "plain" | "json" | undefined =
        usesStructuredRunOutput
          ? isJsonOutput
            ? "json"
            : isPlainOutput || stream
              ? "plain"
              : autoOutputResolution?.mode
          : undefined;
      const suppressDecoratedTaskBoardOutput =
        activeTaskBoardOutput !== undefined;

      const batchSelectionOptions = yield* Effect.try({
        try: () =>
          resolveHubBatchSelectionOptions({
            flowKind: flowDefinition.kind,
            batchStrategy: optionalTextValue(batchStrategy),
            maxTasks: optionalTextValue(maxTasks),
          }),
        catch: toHubFlowError,
      });

      if (flowDefinition.kind === "proposal") {
        let proposalDisplayState = createHubProposalRunDisplayState({
          hubProjectName: targetProjectName ?? legacyProjectTarget ?? repoRoot,
          flowId: flowDefinition.id,
        });
        const proposalJsonRenderer =
          activeTaskBoardOutput === "json"
            ? createHubProposalRunJsonRenderer({
                hubProjectName:
                  targetProjectName ?? legacyProjectTarget ?? repoRoot,
                flowId: flowDefinition.id,
              })
            : undefined;
        let proposalLiveDisplay =
          activeTaskBoardOutput === "live" &&
          autoOutputResolution?.mode === "live"
            ? createHubProposalRunLiveDisplay({
                terminal: {
                  write: (chunk) => {
                    process.stdout.write(chunk);
                  },
                },
                clock: { now: () => Date.now() },
                startedAt: Date.now(),
                columns: process.stdout.columns ?? 0,
                rows: process.stdout.rows,
                color: autoOutputResolution.color,
              })
            : undefined;
        const proposalPlainHistory: string[] = [];
        let proposalLiveRefresh: ReturnType<typeof setInterval> | undefined;
        let resizeProposalLiveDisplay: (() => void) | undefined;
        const stopProposalLiveRuntime = (): void => {
          if (proposalLiveRefresh) {
            clearInterval(proposalLiveRefresh);
            proposalLiveRefresh = undefined;
          }
          if (resizeProposalLiveDisplay) {
            process.stdout.off("resize", resizeProposalLiveDisplay);
            resizeProposalLiveDisplay = undefined;
          }
        };
        const flushProposalPlainHistory = (): void => {
          for (const line of proposalPlainHistory) {
            Effect.runSync(d.plain(line));
          }
          proposalPlainHistory.length = 0;
        };
        const fallbackProposalLiveToPlain = (): void => {
          try {
            proposalLiveDisplay?.dispose();
          } catch {
            // Process-level cleanup remains the final fallback.
          }
          proposalLiveDisplay = undefined;
          stopProposalLiveRuntime();
          activeTaskBoardOutput = "plain";
          flushProposalPlainHistory();
        };
        if (proposalLiveDisplay) {
          proposalLiveRefresh = setInterval(() => {
            try {
              if (proposalLiveDisplay?.refresh() === false) {
                fallbackProposalLiveToPlain();
              }
            } catch {
              fallbackProposalLiveToPlain();
            }
          }, 1_000);
          proposalLiveRefresh.unref();
          resizeProposalLiveDisplay = () => {
            try {
              if (
                proposalLiveDisplay?.resize(
                  process.stdout.columns ?? 0,
                  process.stdout.rows,
                )
              ) {
                return;
              }
            } catch {
              // Fall through to deterministic plain output.
            }
            fallbackProposalLiveToPlain();
          };
          process.stdout.on("resize", resizeProposalLiveDisplay);
        }
        const onPresentationEvent = (
          event: HubProposalPresentationEvent,
        ): void => {
          if (
            !acceptsHubProposalPresentationEvent(proposalDisplayState, event)
          ) {
            return;
          }
          proposalDisplayState = reduceHubProposalRunDisplayState(
            proposalDisplayState,
            event,
          );
          if (activeTaskBoardOutput === "json") {
            Effect.runSync(d.plain(proposalJsonRenderer!.event(event)));
            return;
          }
          const line = formatPlainHubProposalEvent(
            event,
            proposalDisplayState.hubProjectName,
          );
          if (activeTaskBoardOutput === "live") {
            proposalPlainHistory.push(line);
            try {
              if (proposalLiveDisplay?.update(proposalDisplayState) === false) {
                fallbackProposalLiveToPlain();
              }
            } catch {
              fallbackProposalLiveToPlain();
            }
            return;
          }
          Effect.runSync(d.plain(line));
        };
        const proposalRunSignal = createRunSignalController();
        const proposalAttempt = yield* Effect.promise(() =>
          runHubProposalFlowFromCli({
            cwd: repoRoot,
            validatedInput: requireProposalRunInput(
              flowDefinition,
              validatedInput,
            ),
            yes,
            isTTY: process.stdin.isTTY,
            interactive: isInteractive,
            showDecoratedOutput: false,
            onPresentationEvent,
            beforePrompt: () => {
              try {
                proposalLiveDisplay?.suspend();
              } catch {
                fallbackProposalLiveToPlain();
              }
            },
            afterPrompt: () => {
              try {
                if (proposalLiveDisplay?.resume() === false) {
                  fallbackProposalLiveToPlain();
                }
              } catch {
                fallbackProposalLiveToPlain();
              }
            },
            signal: proposalRunSignal.signal,
          })
            .then(
              (result) => ({ _tag: "Success" as const, result }),
              (error: unknown) =>
                isHubRunCancellationError(error)
                  ? ({ _tag: "Cancelled" as const, error } as const)
                  : ({ _tag: "Failure" as const, error } as const),
            )
            .finally(proposalRunSignal.dispose),
        );
        if (proposalAttempt._tag === "Cancelled") {
          const cancellation = projectHubProposalRunCancellation(
            proposalDisplayState,
            getRunCancellationExitCode(proposalAttempt.error),
          );
          process.exitCode = cancellation.exitCode;
          stopProposalLiveRuntime();
          if (activeTaskBoardOutput === "live") {
            try {
              proposalLiveDisplay?.finalize(proposalDisplayState, cancellation);
              return;
            } catch {
              fallbackProposalLiveToPlain();
            }
          }
          if (activeTaskBoardOutput === "json") {
            yield* d.plain(
              proposalJsonRenderer!.outcome(proposalDisplayState, cancellation),
            );
            return;
          }
          yield* d.plain(
            formatPlainHubProposalOutcome(proposalDisplayState, cancellation),
          );
          return;
        }
        if (proposalAttempt._tag === "Failure") {
          const failure = projectHubProposalRunFailure(
            proposalDisplayState,
            proposalAttempt.error,
          );
          process.exitCode = 1;
          stopProposalLiveRuntime();
          if (activeTaskBoardOutput === "json") {
            yield* d.plain(
              proposalJsonRenderer!.failure(
                proposalDisplayState,
                proposalAttempt.error,
              ),
            );
            return;
          }
          if (activeTaskBoardOutput === "live") {
            try {
              proposalLiveDisplay?.finalize(proposalDisplayState, failure);
              return;
            } catch {
              fallbackProposalLiveToPlain();
            }
          }
          yield* d.plain(
            formatPlainHubProposalOutcome(proposalDisplayState, failure),
          );
          return;
        }
        const outcome = projectHubProposalRunOutcome(proposalDisplayState);
        process.exitCode = outcome.exitCode;
        if (activeTaskBoardOutput === "live") {
          try {
            proposalLiveDisplay?.finalize(proposalDisplayState, outcome);
            stopProposalLiveRuntime();
            return;
          } catch {
            fallbackProposalLiveToPlain();
          }
        }
        if (activeTaskBoardOutput === "json") {
          stopProposalLiveRuntime();
          yield* d.plain(
            proposalJsonRenderer!.outcome(proposalDisplayState, outcome),
          );
          return;
        }
        yield* d.plain(
          formatPlainHubProposalOutcome(proposalDisplayState, outcome),
        );
        stopProposalLiveRuntime();
        return;
      }

      let displayState = createHubRunDisplayState({
        hubProjectName: targetProjectName ?? legacyProjectTarget ?? repoRoot,
        flowId: flowDefinition.id,
      });
      const jsonRenderer = isJsonOutput
        ? createHubRunJsonRenderer({
            hubProjectName:
              targetProjectName ?? legacyProjectTarget ?? repoRoot,
            flowId: flowDefinition.id,
          })
        : undefined;
      const plainHistory: string[] = [];
      const seenPlainSourceEventIds = new Set<string>();
      const plainSourceSequences = new Map<string, number>();
      let plainHistoryFlushed = false;
      const acceptsPlainSourceEvent = (event: HubRunEvent): boolean => {
        if (seenPlainSourceEventIds.has(event.eventId)) {
          return false;
        }
        seenPlainSourceEventIds.add(event.eventId);
        const scope =
          "taskId" in event
            ? `${event.runId}:task:${event.taskId}`
            : "batchId" in event
              ? `${event.runId}:batch:${event.batchId}`
              : `${event.runId}:run`;
        const currentSequence = plainSourceSequences.get(scope);
        if (
          currentSequence !== undefined &&
          event.sequence <= currentSequence
        ) {
          return false;
        }
        plainSourceSequences.set(scope, event.sequence);
        return true;
      };
      const flushPlainHistory = (): void => {
        if (plainHistoryFlushed) {
          return;
        }
        for (const line of plainHistory) {
          Effect.runSync(d.plain(line));
        }
        plainHistory.length = 0;
        plainHistoryFlushed = true;
      };
      let liveDisplay =
        activeTaskBoardOutput === "live" &&
        autoOutputResolution?.mode === "live"
          ? createHubRunLiveDisplay({
              terminal: {
                write: (chunk) => {
                  process.stdout.write(chunk);
                },
              },
              clock: { now: () => Date.now() },
              startedAt: Date.now(),
              columns: process.stdout.columns ?? 0,
              rows: process.stdout.rows,
              color: autoOutputResolution.color,
              enableSpinner:
                autoOutputResolution.color &&
                Boolean(process.stdout.isTTY) &&
                Boolean(process.stdin.isTTY),
              mode: shouldUseAltScreenDashboard({
                isTTY: Boolean(process.stdout.isTTY),
                plain: isPlainOutput || noColor,
                stream,
                yes,
                env: process.env,
              })
                ? "alt-screen"
                : "fallback",
            })
          : undefined;
      let liveRefresh: ReturnType<typeof setInterval> | undefined;
      let resizeLiveDisplay: (() => void) | undefined;
      const stopLiveRuntime = (): void => {
        if (liveRefresh) {
          clearInterval(liveRefresh);
          liveRefresh = undefined;
        }
        if (resizeLiveDisplay) {
          process.stdout.off("resize", resizeLiveDisplay);
          resizeLiveDisplay = undefined;
        }
      };
      const fallbackLiveToPlain = (): void => {
        try {
          liveDisplay?.dispose();
        } catch {
          // Process-level terminal cleanup remains the final fallback.
        }
        stopLiveRuntime();
        flushPlainHistory();
        liveDisplay = undefined;
        activeTaskBoardOutput = "plain";
      };
      if (liveDisplay) {
        liveRefresh = setInterval(() => {
          try {
            if (liveDisplay?.refresh() === false) {
              fallbackLiveToPlain();
            }
          } catch {
            fallbackLiveToPlain();
          }
        }, 1_000);
        liveRefresh.unref();
        resizeLiveDisplay = () => {
          try {
            if (
              liveDisplay?.resize(
                process.stdout.columns ?? 0,
                process.stdout.rows,
              )
            ) {
              return;
            }
          } catch {
            // Fall through to deterministic plain output.
          }
          fallbackLiveToPlain();
        };
        process.stdout.on("resize", resizeLiveDisplay);
      }
      const cleanupLiveDisplay = (): void => {
        stopLiveRuntime();
        try {
          liveDisplay?.dispose();
        } catch {
          // setupTerminalCleanup() restores the cursor on process exit.
        }
        liveDisplay = undefined;
      };
      const taskBoardRunSignal = createRunSignalController();
      const runAttempt = yield* Effect.promise(() =>
        runHubFlow({
          flowId: flowDefinition.id,
          cwd: repoRoot,
          signal: taskBoardRunSignal.signal,
          implementer: createHubFlowRunImplementer({
            cwd: repoRoot,
            env: process.env,
            showAgentStartup: !suppressDecoratedTaskBoardOutput,
            idleTimeoutSeconds: flowIdleTimeoutSeconds,
          }),
          reviewer: flowDefinition.hasReviewer
            ? createHubFlowRunReviewer({
                cwd: repoRoot,
                env: process.env,
                showAgentStartup: !suppressDecoratedTaskBoardOutput,
                idleTimeoutSeconds: flowIdleTimeoutSeconds,
              })
            : undefined,
          batchStrategy: batchSelectionOptions.batchStrategy,
          maxTasks: batchSelectionOptions.maxTasks,
          maxBatches: flowMaxBatches,
          batchPlanner:
            batchSelectionOptions.batchStrategy === "planned"
              ? createHubBatchPlannerInvoker({
                  env: process.env,
                  signal: taskBoardRunSignal.signal,
                })
              : undefined,
          onEvent: suppressDecoratedTaskBoardOutput
            ? (event) => {
                const nextDisplayState = reduceHubRunDisplayState(
                  displayState,
                  event,
                );
                if (activeTaskBoardOutput === "json") {
                  displayState = nextDisplayState;
                  const line = jsonRenderer?.event(event);
                  if (line !== undefined) {
                    Effect.runSync(d.plain(line));
                  }
                  return;
                }
                const acceptedPlainEvent = acceptsPlainSourceEvent(event);
                if (activeTaskBoardOutput === "live") {
                  displayState = nextDisplayState;
                  if (acceptedPlainEvent && event.type !== "run_completed") {
                    plainHistory.push(
                      formatPlainHubRunEvent(event, displayState),
                    );
                  }
                  try {
                    if (liveDisplay?.update(displayState) === false) {
                      fallbackLiveToPlain();
                    }
                  } catch {
                    fallbackLiveToPlain();
                  }
                  return;
                }
                if (!acceptedPlainEvent) {
                  return;
                }
                displayState = nextDisplayState;
                if (event.type === "run_completed") {
                  return;
                }
                Effect.runSync(
                  d.plain(formatPlainHubRunEvent(event, displayState)),
                );
              }
            : undefined,
        })
          .then(
            (result) => ({ _tag: "Success" as const, result }),
            (error: unknown) =>
              isHubRunCancellationError(error)
                ? ({ _tag: "Cancelled" as const, error } as const)
                : ({ _tag: "Failure" as const, error } as const),
          )
          .finally(taskBoardRunSignal.dispose),
      );
      if (runAttempt._tag === "Cancelled") {
        process.exitCode = getRunCancellationExitCode(runAttempt.error);
        if (activeTaskBoardOutput === "live") {
          let finalized = false;
          try {
            liveDisplay?.cancel(displayState);
            finalized = true;
          } catch {
            fallbackLiveToPlain();
          } finally {
            cleanupLiveDisplay();
          }
          if (finalized) {
            return;
          }
        }
        if (activeTaskBoardOutput === "json") {
          for (const line of jsonRenderer!.cancellation(
            displayState,
            getRunCancellationExitCode(runAttempt.error),
          )) {
            yield* d.plain(line);
          }
        } else if (activeTaskBoardOutput === "plain") {
          yield* d.plain(formatPlainHubRunCancellation(displayState));
        } else {
          yield* d.status("Run cancelled.", "warn");
        }
        cleanupLiveDisplay();
        return;
      }
      if (runAttempt._tag === "Failure") {
        if (activeTaskBoardOutput === "json") {
          process.exitCode = 1;
          yield* d.plain(jsonRenderer!.failure(displayState, runAttempt.error));
          cleanupLiveDisplay();
          return;
        }
        if (activeTaskBoardOutput === "plain") {
          process.exitCode = 1;
          yield* d.plain(
            formatPlainHubRunFailure(displayState, runAttempt.error),
          );
          cleanupLiveDisplay();
          return;
        }
        if (activeTaskBoardOutput === "live") {
          try {
            liveDisplay?.finalize(
              displayState,
              projectHubRunStateOutcome(displayState, {
                outcome: "failed",
                summary: "Run failed",
                exitCode: 1,
              }),
            );
          } catch {
            fallbackLiveToPlain();
          } finally {
            cleanupLiveDisplay();
          }
        }
        cleanupLiveDisplay();
        return yield* Effect.fail(toHubFlowError(runAttempt.error));
      }
      const result = runAttempt.result;
      const outcome = projectHubRunOutcome(result);
      process.exitCode = outcome.exitCode;

      if (activeTaskBoardOutput === "live") {
        let finalized = false;
        try {
          liveDisplay?.finalize(displayState, outcome);
          finalized = true;
        } catch {
          fallbackLiveToPlain();
        } finally {
          cleanupLiveDisplay();
        }
        if (finalized) {
          return;
        }
      }

      if (activeTaskBoardOutput === "json") {
        for (const line of jsonRenderer!.outcome(result, outcome)) {
          yield* d.plain(line);
        }
        cleanupLiveDisplay();
        return;
      }

      if (activeTaskBoardOutput === "plain") {
        for (const line of formatPlainHubRunOutcome(result, outcome)) {
          yield* d.plain(line);
        }
        cleanupLiveDisplay();
        return;
      }

      for (const line of formatHubFlowResultLines(result)) {
        yield* d.status(line, "info");
      }

      const failures = result.results.filter(
        (taskResult) =>
          taskResult.outcome === "agent_failed" ||
          taskResult.outcome === "sandbox_failed",
      );
      if (result.stopReason === "no_ready_tasks") {
        yield* d.status("Hub flow found no ready tasks to run.", "info");
      } else if (result.stopReason === "batch_failed") {
        const failureMessage =
          failures.length > 0
            ? `Hub flow completed with ${failures.length} failed task(s).`
            : "Hub flow stopped after a failed batch.";
        yield* d.status(failureMessage, "warn");
      } else {
        yield* d.status("Hub flow completed.", "success");
      }
    }).pipe(
      Effect.catchAll((error) => {
        if (output._tag !== "Some" || output.value !== "json") {
          return Effect.fail(error);
        }
        return Effect.gen(function* () {
          const d = yield* Display;
          process.exitCode = 1;
          yield* d.plain(
            formatEarlyHubRunJsonFailure({
              flowId: trimOptionalText(optionalTextValue(flow)) ?? "unknown",
              hubProject:
                trimOptionalText(optionalTextValue(project)) ??
                trimOptionalText(optionalTextValue(projectPath)),
              error,
            }),
          );
        });
      }),
    ),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
  },
  ({ imageName: imageNameFlag, containerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = join(cwd, CONFIG_DIR);
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Root command ---

const rootCommand = Command.make("archloop", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`archLoop v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const archloop = rootCommand.pipe(
  Command.withSubcommands([
    initializeCommand,
    initCommand,
    checkCommand,
    runCommand,
    tasksCommand,
    projectCommand,
    agentConfigCommand,
    envCommand,
    authCommand,
    dockerCommand,
    podmanCommand,
  ]),
);

export const cli = Command.run(archloop, {
  name: "archloop",
  version: VERSION,
});
