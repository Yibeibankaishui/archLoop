import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import * as clack from "@clack/prompts";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import {
  resolveDockerUidBuildArgs,
  rootHostDockerUidGuidance,
} from "./dockerUidBuildArgs.js";
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
import { ConfigDirError, InitError } from "./errors.js";
import {
  getCapabilityPackDefinition,
  listCapabilityPacksForInit,
  resolveCapabilityInitOptions,
} from "./capabilityPacks.js";
import {
  getPresetAgentDefinition,
  listPresetAgentsForInit,
} from "./presetAgents.js";

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

const parseCapabilityAddonsCliValue = (
  raw: string,
): Effect.Effect<readonly string[], InitError, never> => {
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "none") {
    return Effect.succeed([]);
  }
  return Effect.succeed(
    t
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
};

const parsePresetAgentsCliValue = (
  raw: string,
): Effect.Effect<readonly string[] | undefined, InitError, never> => {
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "none") {
    return Effect.succeed(undefined);
  }
  const ids = t
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
}): string[] => {
  if (
    options.sandboxProvider.name === "no-sandbox" &&
    options.backlogManager.name === "beads"
  ) {
    return [
      "Keep `bd` available on your host PATH when using no-sandbox + beads. Prompt shell expressions run on the host in this mode, not in a container.",
    ];
  }

  return [];
};

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

      let selectedCapabilityId: string | undefined;
      if (capabilityCli._tag === "Some") {
        selectedCapabilityId = capabilityCli.value;
      }

      let capabilityAddonIds: readonly string[] = [];
      if (capabilityAddonsCli._tag === "Some") {
        capabilityAddonIds = yield* parseCapabilityAddonsCliValue(
          capabilityAddonsCli.value,
        );
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

      if (
        selectedCapabilityId === undefined &&
        capabilityCli._tag === "None" &&
        !scriptedInit
      ) {
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
        if (picked !== "generic") {
          selectedCapabilityId = picked;
        }
      }

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
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: capabilityInit.templateName,
            options: templates.map((tmpl) => ({
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
      const hostRequirementResult: HostRequirementResult = {
        nextStepLines: buildHostRequirementNextStepLines({
          sandboxProvider: selectedSandboxProvider,
          backlogManager: selectedBacklogManager,
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
          if (hostIsRoot) {
            yield* d.status(rootHostDockerUidGuidance(), "info");
          }
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
      if (hostIsRoot) {
        yield* d.status(rootHostDockerUidGuidance(), "info");
      }

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
  Command.withSubcommands([initCommand, dockerCommand, podmanCommand]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});
