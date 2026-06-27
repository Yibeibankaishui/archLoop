import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import * as clack from "@clack/prompts";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
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
  formatHubProjectStatusLines,
  resolveHubProjectStatus,
} from "./projectStatus.js";
import {
  configureHubProjectDevelopmentContract,
  resolveHubProjectDevelopmentContractPath,
} from "./hubProjectDevelopmentContract.js";
import {
  createHubFlowRunImplementer,
  createHubFlowRunReviewer,
  formatHubFlowResultLines,
  runHubFlow,
} from "./hubFlowExecution.js";
import { createHubBatchPlannerInvoker } from "./hubBatchPlannerAgent.js";
import { resolveHubBatchSelectionOptions } from "./hubBatchPlanner.js";
import { getHubFlowDefinition, listHubFlows } from "./hubFlows.js";
import {
  formatValidatedHubFlowInputSummary,
  validateHubFlowInput,
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
  formatHubTaskBoardLines,
  appendHubTaskComment,
  createHubTask,
  deleteHubTasks,
  formatHubTaskCommentLines,
  formatHubTaskDetailsRows,
  loadHubTask,
  loadHubTaskBoard,
  resolveHubTaskSelector,
  resolveHubTaskSelectors,
} from "./taskBoard.js";
import { HUB_TRIAGE_DEFAULT_TASK_QUERY } from "./hubTriage.js";
import { initHubTaskStore } from "./hubTaskStore.js";
import { isTriageTaskIdInput } from "./hubTriageProposal.js";
import {
  formatHubTaskSyncPreviewLines,
  formatHubTaskSyncSummaryLines,
  syncHubTasksWithGithub,
} from "./hubTaskSync.js";
import { formatHubRecoveryComment, recoverHubTask } from "./hubTaskRecover.js";
import {
  doctorHubTaskState,
  formatHubTaskStateDoctorLines,
  formatHubTaskStateRepairLines,
  repairHubTaskState,
} from "./hubTaskStateDoctor.js";
import {
  formatHubAgentConfigShowLines,
  formatHubAgentRoleOptions,
  HUB_AGENT_ROLES,
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
} from "./hubAgentConfigPrompt.js";
import {
  formatHubEnvShowLines,
  isHubEnvKnownKey,
  resolveHubEnvPath,
  upsertHubEnvKey,
} from "./hubEnv.js";
import { promptInitHubEnv } from "./hubEnvPrompt.js";
import {
  ensureHubAuthDir,
  formatHubAuthShowLines,
  getHubAuthEnvVar,
  getHubAuthLoginCommand,
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

const formatHubProjectStatusRows = (
  status: Awaited<ReturnType<typeof resolveHubProjectStatus>>,
): Record<string, string> => ({
  "Repository root": status.repoRoot,
  "archLoop user data dir": status.archloopUserDataDir,
  "Hub project dir": status.hubProjectDir,
  "Hub project profile": status.projectProfile ?? DEFAULT_PROJECT_PROFILE_NAME,
  "Hub project development contract": status.projectDevelopmentContractPath
    ? status.projectDevelopmentContractPath
    : resolveHubProjectDevelopmentContractPath(status.hubProjectDir),
  "Hub project registration": status.projectRegistered ? "existing" : "created",
  "Beads available": status.beadsAvailable ? "yes" : "no",
  "Task store initialized": status.taskStoreInitialized ? "yes" : "no",
  "Task board ready": String(status.taskCounts.ready),
  "Task board total": String(status.taskCounts.total),
});

const projectConfigureProjectProfileOption = Options.text(
  "project-profile",
).pipe(
  Options.withDescription(
    "Project profile for the Hub project development contract (e.g. generic, node). Defaults to a prompt in TTYs.",
  ),
  Options.optional,
);

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
const taskWarningOption = Options.text("warning").pipe(
  Options.withDescription(
    "Filter tasks by PRD warning severity (high, medium, or low).",
  ),
  Options.optional,
);
const taskSelectorsArg = Args.atLeast(
  Args.text({ name: "task-selector" }).pipe(
    Args.withDescription(
      "Beads id, exact task title, or 1-based number from tasks list.",
    ),
  ),
  1,
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

const tasksInitCommand = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
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
  { warning: taskWarningOption },
  ({ warning }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const warningFilter = yield* resolvePrdWarningFilter(warning);
      const board = yield* Effect.try({
        try: () => loadHubTaskBoard(cwd),
        catch: toTaskBoardError,
      });

      for (const line of formatHubTaskBoardLines(board, { warningFilter })) {
        yield* d.text(line);
      }
    }),
);

const tasksCreateCommand = Command.make(
  "create",
  {
    title: taskTitleArg,
    origin: taskOriginOption,
    description: taskDescriptionOption,
    kind: taskKindOption,
  },
  ({ title, origin, description, kind }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
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

      yield* d.summary("Created Beads task", {
        "Beads id": created.id,
        Title: created.title,
        Origin: resolvedOrigin,
        ...(kindValue !== undefined ? { Kind: kindValue } : {}),
      });
    }),
);

const tasksShowCommand = Command.make("show", { id: taskIdArg }, ({ id }) =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const task = yield* Effect.try({
      try: () => loadHubTask(cwd, id),
      catch: toTaskBoardError,
    });

    yield* d.summary(`Beads task ${task.id}`, formatHubTaskDetailsRows(task));
    for (const line of formatHubTaskCommentLines(task)) {
      yield* d.text(line);
    }
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
  },
  ({ taskId, query, approve }) =>
    Effect.gen(function* () {
      const cwd = process.cwd();
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
  },
  ({ prdRef, approve, status, deps }) =>
    Effect.gen(function* () {
      const cwd = process.cwd();
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
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly includeClosed?: boolean;
}) =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
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

    const result = yield* Effect.try({
      try: () =>
        syncHubTasksWithGithub({
          cwd,
          mode: input.mode,
          includeClosed: input.includeClosed,
        }),
      catch: toTaskBoardError,
    });

    for (const line of formatHubTaskSyncSummaryLines(result)) {
      yield* d.text(line);
    }
  });

const tasksSyncCommand = Command.make(
  "sync",
  {
    yes: taskSyncYesOption,
    dryRun: taskSyncDryRunOption,
    includeClosed: taskSyncIncludeClosedOption,
  },
  ({ yes, dryRun, includeClosed }) =>
    runHubTaskSyncCommand({ mode: "sync", yes, dryRun, includeClosed }),
);

const tasksPullCommand = Command.make(
  "pull",
  {
    includeClosed: taskSyncIncludeClosedOption,
    dryRun: taskSyncDryRunOption,
  },
  ({ includeClosed, dryRun }) =>
    runHubTaskSyncCommand({
      mode: "pull",
      includeClosed,
      dryRun,
    }),
);

const tasksPushCommand = Command.make(
  "push",
  { dryRun: taskSyncDryRunOption },
  ({ dryRun }) => runHubTaskSyncCommand({ mode: "push", dryRun }),
);

const tasksCommentCommand = Command.make(
  "comment",
  {
    id: taskIdArg,
    body: Options.text("body").pipe(
      Options.withDescription("Comment body"),
      Options.optional,
    ),
  },
  ({ id, body }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
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
  { id: taskIdArg },
  ({ id }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const task = yield* Effect.try({
        try: () => resolveHubTaskSelector(cwd, id),
        catch: toTaskBoardError,
      });
      const result = yield* Effect.tryPromise({
        try: () => recoverHubTask({ cwd, taskId: task.id }),
        catch: toTaskBoardError,
      });

      yield* d.summary(`Recovered Beads task ${task.id}`, {
        Outcome: result.outcome,
        "Prior status": result.priorStatus,
        "Hub status": result.hubStatus,
        Summary: result.summary,
      });
      yield* d.status(formatHubRecoveryComment(result.summary), "info");
    }),
);

const tasksDoctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const result = yield* Effect.tryPromise({
      try: () => doctorHubTaskState({ cwd }),
      catch: toTaskBoardError,
    });

    for (const line of formatHubTaskStateDoctorLines(result)) {
      yield* d.text(line);
    }
  }),
);

const tasksRepairStateCommand = Command.make(
  "repair-state",
  {
    id: taskIdArg,
    yes: taskRepairStateYesOption,
  },
  ({ id, yes }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
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
  },
  ({ selectors, yes, dryRun, cascade }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
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
    tasksCommentCommand,
    tasksRecoverCommand,
    tasksDoctorCommand,
    tasksRepairStateCommand,
    tasksDeleteCommand,
  ]),
);

const projectStatusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const status = yield* Effect.try({
      try: () => resolveHubProjectStatus({ cwd }),
      catch: (error) =>
        new ProjectStatusError({
          message: error instanceof Error ? error.message : String(error),
        }),
    });

    yield* d.summary("Hub project status", formatHubProjectStatusRows(status));
    for (const line of formatHubProjectStatusLines(status)) {
      yield* d.text(line);
    }
  }),
);

const projectConfigureCommand = Command.make(
  "configure",
  {
    projectProfile: projectConfigureProjectProfileOption,
  },
  ({ projectProfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const status = yield* Effect.try({
        try: () => resolveHubProjectStatus({ cwd }),
        catch: (error) =>
          new ProjectStatusError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });

      let selectedProjectProfile =
        optionalTextValue(projectProfile) ?? DEFAULT_PROJECT_PROFILE_NAME;

      if (projectProfile._tag === "None") {
        if (!process.stdin.isTTY) {
          yield* Effect.fail(
            new ProjectStatusError({
              message:
                "Project configure requires --project-profile in non-interactive mode. Available: " +
                formatProjectProfileNames(),
            }),
          );
        }

        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a project profile:",
            initialValue: DEFAULT_PROJECT_PROFILE_NAME,
            options: listProjectProfiles().map((profile) => ({
              value: profile.name,
              label: profile.label,
              hint: profile.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new ProjectStatusError({
              message: "Project profile selection cancelled.",
            }),
          );
        }
        selectedProjectProfile = selected as string;
      }

      const contract = yield* Effect.try({
        try: () =>
          configureHubProjectDevelopmentContract({
            repoRoot: status.repoRoot,
            hubProjectDir: status.hubProjectDir,
            projectProfileName: selectedProjectProfile,
          }),
        catch: (error) =>
          new ProjectStatusError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });

      yield* d.summary("Hub project development contract", {
        "Repository root": status.repoRoot,
        "Hub project dir": status.hubProjectDir,
        "Hub project profile": contract.contract.projectProfile,
        "Hub project development contract": contract.contractPath,
      });

      if (contract.persisted) {
        yield* d.status("Hub project development contract written.", "success");
      }
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
  Command.withSubcommands([projectStatusCommand, projectConfigureCommand]),
);

const getHubFlowIds = (): string =>
  listHubFlows()
    .map((flow) => flow.id)
    .join(", ");

const flowOption = Options.text("flow").pipe(
  Options.withDescription(`Hub flow id (${getHubFlowIds()})`),
);

const flowInputOption = Options.text("input").pipe(
  Options.withDescription(
    "Flow-specific input value (PRD path for prd-decomposition; optional task query for triage)",
  ),
  Options.optional,
);

const flowYesOption = Options.boolean("yes").pipe(
  Options.withDescription(
    "Run proposal flows in one-shot mode without interactive prompts.",
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
    const configuredRoleCount = HUB_AGENT_ROLES.filter(
      (role) => config.roles[role] !== undefined,
    ).length;
    yield* d.summary("Configured Hub agent roles", {
      Roles: String(configuredRoleCount),
      Config: resolveHubAgentConfigPath(),
    });
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
      yield* d.summary(`Saved Hub agent role ${saved.role}`, {
        Provider: saved.entry.provider,
        Model: saved.entry.model,
        Options: formatHubAgentRoleOptions(saved.entry.options) ?? "(none)",
      });
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
      yield* d.summary(`Saved ${envKey}`, { Path: savedPath });
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
    yield* d.summary(
      `${provider === "codex" ? "Codex" : "GitHub"} auth saved`,
      {
        [envVar]: authDir,
      },
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

const runCommand = Command.make(
  "run",
  {
    project: Args.text({ name: "project" }).pipe(
      Args.withDescription(
        "Path to the git repository (use . for current repo)",
      ),
    ),
    flow: flowOption,
    input: flowInputOption,
    yes: flowYesOption,
    batchStrategy: flowBatchStrategyOption,
    maxTasks: flowMaxTasksOption,
  },
  ({ project, flow, input, yes, batchStrategy, maxTasks }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const projectDir = project.trim().length > 0 ? project : ".";
      const flowDefinition = getHubFlowDefinition(flow);
      if (!flowDefinition) {
        return yield* Effect.fail(
          new HubFlowError({
            message: `Unknown Hub flow "${flow}". Available flows: ${getHubFlowIds()}`,
          }),
        );
      }

      const batchSelectionOptions = yield* Effect.try({
        try: () =>
          resolveHubBatchSelectionOptions({
            flowKind: flowDefinition.kind,
            batchStrategy: optionalTextValue(batchStrategy),
            maxTasks: optionalTextValue(maxTasks),
          }),
        catch: toHubFlowError,
      });

      const repoRoot = yield* Effect.try({
        try: () => resolveGitRepoRoot(projectDir),
        catch: toHubFlowError,
      });

      const rawInput = optionalTextValue(input);
      if (rawInput && !flowDefinition.input) {
        return yield* Effect.fail(
          new HubFlowError({
            message: `Hub flow "${flow}" does not accept --input.`,
          }),
        );
      }

      if (flowDefinition.input) {
        const validatedInput = yield* Effect.try({
          try: () =>
            validateHubFlowInput(flowDefinition.id, {
              cwd: repoRoot,
              rawInput,
            }),
          catch: toHubFlowError,
        });
        yield* d.status(
          formatValidatedHubFlowInputSummary(validatedInput),
          "info",
        );

        if (flowDefinition.kind === "proposal") {
          const execution = yield* Effect.tryPromise({
            try: () =>
              runHubProposalFlowFromCli({
                cwd: repoRoot,
                validatedInput,
                yes,
                isTTY: process.stdin.isTTY,
              }),
            catch: toHubFlowError,
          });

          if (execution.flowId === "prd-decomposition") {
            yield* handlePrdDecompositionFlowDisplay(
              execution.result,
              (message) => new HubFlowError({ message }),
            );
            return;
          }

          yield* handleTriageProposalFlowDisplay(
            execution.result,
            (message) => new HubFlowError({ message }),
          );
          return;
        }
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          runHubFlow({
            flowId: flowDefinition.id,
            cwd: repoRoot,
            implementer: createHubFlowRunImplementer({
              cwd: repoRoot,
              env: process.env,
            }),
            reviewer: flowDefinition.hasReviewer
              ? createHubFlowRunReviewer({ cwd: repoRoot, env: process.env })
              : undefined,
            batchStrategy: batchSelectionOptions.batchStrategy,
            maxTasks: batchSelectionOptions.maxTasks,
            batchPlanner:
              batchSelectionOptions.batchStrategy === "planned"
                ? createHubBatchPlannerInvoker({ env: process.env })
                : undefined,
          }),
        catch: toHubFlowError,
      });

      for (const line of formatHubFlowResultLines(result)) {
        yield* d.status(line, "info");
      }

      const failures = result.results.filter(
        (taskResult) =>
          taskResult.outcome === "agent_failed" ||
          taskResult.outcome === "sandbox_failed",
      );
      if (failures.length > 0) {
        yield* d.status(
          `Hub flow completed with ${failures.length} failed task(s).`,
          "warn",
        );
      } else if (result.results.length > 0) {
        yield* d.status("Hub flow completed.", "success");
      } else {
        yield* d.status("Hub flow found no ready tasks to run.", "info");
      }
    }),
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
    initCommand,
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
