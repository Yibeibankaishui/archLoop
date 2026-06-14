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
  createHubFlowRunImplementer,
  createHubFlowRunReviewer,
  formatHubFlowResultLines,
  runHubFlow,
} from "./hubFlowExecution.js";
import { getHubFlowDefinition, listHubFlows } from "./hubFlows.js";
import {
  draftPrdSlices,
  formatPrdDraftPlan,
  parseDependencySpec,
  publishPrdDraftPlan,
  readPrdFile,
  type PrdHubStatus,
} from "./prdDecomposition.js";
import {
  formatHubTaskBoardLines,
  appendHubTaskComment,
  createHubTask,
  formatHubTaskCommentLines,
  formatHubTaskDetailsRows,
  loadHubTask,
  loadHubTaskBoard,
} from "./taskBoard.js";
import { triageHubTasks, type HubTriageOutcome } from "./hubTriage.js";
import {
  formatHubTaskSyncSummaryLines,
  syncHubTasksWithGithub,
} from "./hubTaskSync.js";
import { formatHubRecoveryComment, recoverHubTask } from "./hubTaskRecover.js";
import {
  formatHubAgentConfigShowLines,
  formatHubAgentRoleOptions,
  readHubAgentConfig,
  resolveHubAgentConfigPath,
  setHubAgentRole,
} from "./hubAgentConfig.js";

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

const CONFIG_DIR = ".sandcastle";

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
          message: "No .sandcastle/ found. Run `sandcastle init` first.",
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

const initCreateSandcastleLabelOption = Options.text(
  "create-sandcastle-label",
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
      "Add GH_TOKEN to .sandcastle/.env before running GitHub Issues templates.",
    );
  } else if (options.githubChoice === "skip") {
    lines.push(
      "Set up GitHub auth later with GH_TOKEN in .sandcastle/.env or `GH_CONFIG_DIR=.sandcastle/auth/gh gh auth login --insecure-storage`.",
    );
  } else if (options.githubChoice === "deferred") {
    lines.push(
      "This scripted init skipped interactive GitHub auth setup. Use GH_TOKEN in .sandcastle/.env or `GH_CONFIG_DIR=.sandcastle/auth/gh gh auth login --insecure-storage` before running GitHub Issues templates.",
    );
  }

  if (options.codexChoice === "env") {
    lines.push(
      "Add OPENAI_KEY to .sandcastle/.env before running Codex in the sandbox.",
    );
  } else if (options.codexChoice === "skip") {
    lines.push(
      "Set up Codex auth later with OPENAI_KEY in .sandcastle/.env or `CODEX_HOME=.sandcastle/auth/codex codex login`.",
    );
  } else if (options.codexChoice === "deferred") {
    lines.push(
      "This scripted init skipped interactive Codex auth setup. Use OPENAI_KEY in .sandcastle/.env or `CODEX_HOME=.sandcastle/auth/codex codex login` before running Codex in the sandbox.",
    );
  }

  if (options.cursorChoice === "env") {
    lines.push(
      "Add CURSOR_API_KEY to .sandcastle/.env before the first Cursor sandbox run. Bootstrap and task runs will fail without it.",
    );
  } else if (options.cursorChoice === "skip") {
    lines.push(
      "Set CURSOR_API_KEY in .sandcastle/.env before the first Cursor sandbox run. Bootstrap and task runs will fail until it is set.",
    );
  } else if (options.cursorChoice === "deferred") {
    lines.push(
      "This scripted init skipped interactive Cursor auth setup. Set CURSOR_API_KEY in .sandcastle/.env before the first Cursor sandbox run, or bootstrap will fail.",
    );
  }

  return lines;
};

const hostHasCommand = (command: string): boolean => {
  const checkCommand =
    process.platform === "win32" ? `where ${command}` : `command -v ${command}`;
  try {
    execSync(checkCommand, {
      stdio: "ignore",
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
};

const validateHostRequirementsForInit = (options: {
  readonly sandboxProvider: SandboxProviderEntry;
  readonly backlogManager: BacklogManagerEntry;
}): Effect.Effect<void, InitError, never> => {
  if (
    options.sandboxProvider.name === "no-sandbox" &&
    options.backlogManager.name === "beads" &&
    !hostHasCommand("bd")
  ) {
    return Effect.fail(
      new InitError({
        message:
          "Using --sandbox no-sandbox with backlog manager beads requires `bd` on the host PATH because backlog commands run on the host in this mode. Install Beads locally or choose docker.",
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
        "Keep `bd` available on your host PATH when using no-sandbox + beads. Prompt shell expressions run on the host in this mode, not in a container.",
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
          "Install project-local miniprogram-ci as a dev dependency? (Recommended for platform preview validation; global CLI and npx do not satisfy Sandcastle's managed loop.)",
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
  createSandcastleLabelCli: OptionalTextFlag;
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
    options.createSandcastleLabelCli._tag === "Some");

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
    createSandcastleLabel: initCreateSandcastleLabelOption,
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
    createSandcastleLabel: createSandcastleLabelCli,
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
        createSandcastleLabelCli,
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

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub backlog managers)
      let shouldCreateLabel: boolean | symbol = false;
      if (selectedBacklogManager.name === "github-issues") {
        if (createSandcastleLabelCli._tag === "Some") {
          shouldCreateLabel = yield* parseStrictBoolean(
            "create-sandcastle-label",
            createSandcastleLabelCli.value,
          );
        } else {
          shouldCreateLabel = yield* Effect.promise(() =>
            clack.confirm({
              message:
                'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
              initialValue: true,
            }),
          );
        }

        if (shouldCreateLabel === true) {
          yield* Effect.try({
            try: () =>
              execSync(
                'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
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
        "Scaffolding .sandcastle/ config directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel === true,
          backlogManager: selectedBacklogManager,
          sandboxProvider: selectedSandboxProvider,
          installedRuntimes: selectedInstalledRuntimes,
          projectProfile: selectedProjectProfile,
          sandcastleVersion: VERSION,
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
          "package.json was updated but `npm install` failed. Run `npm install` in the project root before `npm run sandcastle`.",
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
                  label: "Use GH_TOKEN in .sandcastle/.env",
                },
                {
                  value: "login",
                  label: "Run gh auth login into .sandcastle/auth/gh",
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
              "Add GH_TOKEN to .sandcastle/.env when you're ready. Sandcastle will not write secrets for you.",
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
                    GH_CONFIG_DIR: join(cwd, ".sandcastle", "auth", "gh"),
                  },
                }),
              catch: () =>
                new InitError({
                  message:
                    "GitHub login failed. You can retry with `GH_CONFIG_DIR=.sandcastle/auth/gh gh auth login --insecure-storage`.",
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
                  label: "Use OPENAI_KEY in .sandcastle/.env",
                },
                {
                  value: "login",
                  label: "Run codex login into .sandcastle/auth/codex",
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
              "Add OPENAI_KEY to .sandcastle/.env when you're ready. Sandcastle will not write secrets for you.",
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
                    CODEX_HOME: join(cwd, ".sandcastle", "auth", "codex"),
                  },
                }),
              catch: () =>
                new InitError({
                  message:
                    "Codex login failed. You can retry with `CODEX_HOME=.sandcastle/auth/codex codex login`.",
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
                  label: "Use CURSOR_API_KEY in .sandcastle/.env",
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
              "Set CURSOR_API_KEY in .sandcastle/.env before the first Cursor sandbox run. Sandcastle will not write secrets for you, and bootstrap will fail without it.",
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
          `Init complete! Run \`sandcastle ${selectedSandboxProvider.cliNamespace} build-image\` to build the ${providerLabel} image later.`,
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
  "Sandcastle user data dir": status.sandcastleUserDataDir,
  "Hub project dir": status.hubProjectDir,
  "Hub project registration": status.projectRegistered ? "existing" : "created",
  "Beads available": status.beadsAvailable ? "yes" : "no",
  "Task board ready": String(status.taskCounts.ready),
  "Task board total": String(status.taskCounts.total),
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
    "Approve the drafted PRD slices without interactive confirmation.",
  ),
  Options.withDefault(false),
);
const prdStatusOption = Options.text("status").pipe(
  Options.withDescription(
    "Initial Hub status for PRD-derived tasks (inbox, ready_for_agent, ready_for_human). Defaults to inbox.",
  ),
  Options.optional,
);
const prdDepsOption = Options.text("deps").pipe(
  Options.withDescription(
    "Dependency pairs as childIndex:parentIndex, e.g. 2:1,3:1.",
  ),
  Options.optional,
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

const tasksListCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const board = yield* Effect.try({
      try: () => loadHubTaskBoard(cwd),
      catch: toTaskBoardError,
    });

    for (const line of formatHubTaskBoardLines(board)) {
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

const formatTriageOutcomeLabel = (outcome: HubTriageOutcome): string =>
  outcome.replaceAll("_", " ");

const tasksTriageCommand = Command.make("triage", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const result = yield* Effect.try({
      try: () => triageHubTasks({ cwd }),
      catch: toTaskBoardError,
    });

    if (result.triaged.length === 0) {
      yield* d.status("No inbox or needs_info tasks required triage.", "info");
      return;
    }

    yield* d.summary("Triaged Hub tasks", {
      Total: String(result.triaged.length),
    });
    for (const entry of result.triaged) {
      yield* d.text(
        `  ${entry.taskId}: ${entry.priorStatus} -> ${formatTriageOutcomeLabel(entry.outcome)}`,
      );
    }
  }),
);

const normalizePrdHubStatus = (value: string): PrdHubStatus | undefined => {
  const normalized = value.trim().toLowerCase();
  return normalized === "inbox" ||
    normalized === "ready_for_agent" ||
    normalized === "ready_for_human"
    ? normalized
    : undefined;
};

const resolvePrdHubStatus = (
  status: OptionalTextFlag,
): Effect.Effect<PrdHubStatus, TaskBoardError, never> => {
  if (status._tag !== "Some") {
    return Effect.succeed("inbox");
  }

  const resolved = normalizePrdHubStatus(status.value);
  if (resolved) {
    return Effect.succeed(resolved);
  }

  return Effect.fail(
    new TaskBoardError({
      message:
        'Invalid PRD task status. Use "inbox", "ready_for_agent", or "ready_for_human".',
    }),
  );
};

const promptPrdHubStatus = (): Effect.Effect<
  PrdHubStatus,
  TaskBoardError,
  never
> =>
  Effect.tryPromise({
    try: async () => {
      const selected = await clack.select({
        message:
          "Initial Hub status for PRD-derived tasks (defaults to inbox):",
        options: [
          { value: "inbox", label: "inbox", hint: "needs triage" },
          {
            value: "ready_for_agent",
            label: "ready_for_agent",
            hint: "AFK-ready after confirmation",
          },
          {
            value: "ready_for_human",
            label: "ready_for_human",
            hint: "human-owned work",
          },
        ],
        initialValue: "inbox",
      });
      if (clack.isCancel(selected)) {
        throw new TaskBoardError({
          message: "PRD task creation cancelled.",
        });
      }
      return selected as PrdHubStatus;
    },
    catch: toTaskBoardError,
  });

const resolvePrdDependencySpec = (
  deps: OptionalTextFlag,
  approve: boolean,
): Effect.Effect<string, TaskBoardError, never> => {
  if (deps._tag === "Some") {
    return Effect.succeed(deps.value);
  }

  if (approve) {
    return Effect.succeed("");
  }

  return Effect.tryPromise({
    try: async () => {
      const result = await clack.text({
        message:
          "Dependency pairs as childIndex:parentIndex (comma-separated, optional):",
        placeholder: "2:1,3:2",
        defaultValue: "",
      });
      if (clack.isCancel(result)) {
        throw new TaskBoardError({
          message: "PRD task creation cancelled.",
        });
      }
      return String(result);
    },
    catch: toTaskBoardError,
  });
};

const resolvePrdHubStatusSelection = (
  status: OptionalTextFlag,
  approve: boolean,
): Effect.Effect<PrdHubStatus, TaskBoardError, never> => {
  if (status._tag === "Some") {
    return resolvePrdHubStatus(status);
  }

  if (approve) {
    return Effect.succeed("inbox");
  }

  return promptPrdHubStatus();
};

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
      const d = yield* Display;
      const cwd = process.cwd();
      const content = yield* Effect.try({
        try: () => readPrdFile(cwd, prdRef),
        catch: (error) =>
          new TaskBoardError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });
      const plan = draftPrdSlices(content, prdRef);

      if (plan.slices.length === 0) {
        return yield* Effect.fail(
          new TaskBoardError({
            message:
              "No unchecked Tasks, Deliverables, or User Stories were found in the PRD.",
          }),
        );
      }

      const dependencySpec = yield* resolvePrdDependencySpec(deps, approve);

      const dependencies = yield* Effect.try({
        try: () => parseDependencySpec(dependencySpec, plan.slices.length),
        catch: (error) =>
          new TaskBoardError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });

      for (const line of formatPrdDraftPlan(plan, dependencies)) {
        yield* d.text(line);
      }

      if (!approve) {
        const confirmed = yield* Effect.tryPromise({
          try: async () => {
            const result = await clack.confirm({
              message: "Create these PRD-derived Beads tasks?",
              initialValue: true,
            });
            if (clack.isCancel(result)) {
              throw new TaskBoardError({
                message: "PRD task creation cancelled.",
              });
            }
            return result;
          },
          catch: toTaskBoardError,
        });

        if (!confirmed) {
          return yield* Effect.fail(
            new TaskBoardError({
              message: "PRD task creation cancelled.",
            }),
          );
        }
      }

      const hubStatus = yield* resolvePrdHubStatusSelection(status, approve);

      const published = yield* Effect.try({
        try: () =>
          publishPrdDraftPlan({
            cwd,
            plan,
            hubStatus,
            dependencies,
          }),
        catch: toTaskBoardError,
      });

      yield* d.summary("Created PRD-derived Beads tasks", {
        PRD: plan.prdTitle,
        Reference: plan.prdRef,
        Status: hubStatus,
        Tasks: String(published.tasks.length),
        Dependencies: String(published.dependencies.length),
      });

      for (const task of published.tasks) {
        yield* d.text(`  ${task.id}: ${task.title}`);
      }
      for (const dependency of published.dependencies) {
        yield* d.text(
          `  ${dependency.dependentId} depends on ${dependency.blockerId}`,
        );
      }
    }),
);

const tasksSyncCommand = Command.make("sync", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const result = yield* Effect.try({
      try: () => syncHubTasksWithGithub({ cwd }),
      catch: toTaskBoardError,
    });

    for (const line of formatHubTaskSyncSummaryLines(result)) {
      yield* d.text(line);
    }
  }),
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
        try: () => appendHubTaskComment(cwd, id, commentBody),
        catch: toTaskBoardError,
      });

      yield* d.status(`Appended a comment to Beads task ${id}.`, "success");
    }),
);

const tasksRecoverCommand = Command.make(
  "recover",
  { id: taskIdArg },
  ({ id }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const result = yield* Effect.tryPromise({
        try: () => recoverHubTask({ cwd, taskId: id }),
        catch: toTaskBoardError,
      });

      yield* d.summary(`Recovered Beads task ${id}`, {
        Outcome: result.outcome,
        "Prior status": result.priorStatus,
        "Hub status": result.hubStatus,
        Summary: result.summary,
      });
      yield* d.status(formatHubRecoveryComment(result.summary), "info");
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
    tasksListCommand,
    tasksShowCommand,
    tasksCreateCommand,
    tasksTriageCommand,
    tasksFromPrdCommand,
    tasksSyncCommand,
    tasksCommentCommand,
    tasksRecoverCommand,
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

const projectCommand = Command.make("project", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Hub project commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([projectStatusCommand]));

const getHubFlowIds = (): string =>
  listHubFlows()
    .map((flow) => flow.id)
    .join(", ");

const flowOption = Options.text("flow").pipe(
  Options.withDescription(`Hub flow id (${getHubFlowIds()})`),
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
);

const agentConfigModelOption = Options.text("model").pipe(
  Options.withDescription("Agent model"),
);

const agentConfigOptionsOption = Options.text("options").pipe(
  Options.withDescription(
    "Comma-separated provider options as key=value pairs (e.g. effort=medium,mode=plan)",
  ),
  Options.optional,
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
      const saved = yield* Effect.try({
        try: () =>
          setHubAgentRole(role, {
            provider,
            model,
            options: parsedOptions,
          }),
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
    agentConfigSetRoleCommand,
  ]),
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
  },
  ({ project, flow }) =>
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

      const repoRoot = yield* Effect.try({
        try: () => resolveGitRepoRoot(projectDir),
        catch: toHubFlowError,
      });

      const result = yield* Effect.tryPromise({
        try: () =>
          runHubFlow({
            flowId: flowDefinition.id,
            cwd: repoRoot,
            implementer: createHubFlowRunImplementer({ cwd: repoRoot }),
            reviewer: flowDefinition.hasReviewer
              ? createHubFlowRunReviewer({ cwd: repoRoot })
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

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    runCommand,
    tasksCommand,
    projectCommand,
    agentConfigCommand,
    dockerCommand,
    podmanCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});
