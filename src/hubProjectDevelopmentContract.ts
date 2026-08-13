import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_PROJECT_PROFILE_NAME,
  formatProjectProfileNames,
  getProjectProfile,
  type ProjectProfileEntry,
} from "./InitService.js";
import type {
  SectionBlock,
  SectionFooterBlock,
  SectionHeaderBlock,
  SectionKvBlock,
} from "./section.js";

export const HUB_PROJECT_DEVELOPMENT_CONTRACT_FILE_NAME =
  "development-contract.json";

export const HUB_PROJECT_DEVELOPMENT_CONTRACT_VERSION = 1 as const;

const PROJECT_FACT_SIGNAL_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "requirements.txt",
  "CMakeLists.txt",
  "Makefile",
  "makefile",
  "project.config.json",
] as const;

export interface HubProjectDevelopmentContractFacts {
  readonly observedFiles: readonly string[];
  readonly configuredScripts: readonly string[];
}

export interface HubProjectDevelopmentContractTimestamps {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HubProjectDevelopmentContract {
  readonly version: typeof HUB_PROJECT_DEVELOPMENT_CONTRACT_VERSION;
  readonly projectProfile: string;
  readonly projectFacts: HubProjectDevelopmentContractFacts;
  readonly setup: readonly string[];
  readonly verify: readonly string[];
  readonly context: readonly string[];
  readonly timestamps: HubProjectDevelopmentContractTimestamps;
}

export interface HubProjectDevelopmentContractState {
  readonly contractPath: string;
  readonly contract: HubProjectDevelopmentContract;
  readonly persisted: boolean;
}

export interface EnsureHubProjectDevelopmentContractStateResult extends HubProjectDevelopmentContractState {
  readonly createdGenericFallback: boolean;
}

export interface ConfigureHubProjectDevelopmentContractResult extends HubProjectDevelopmentContractState {
  readonly backupPath?: string;
  readonly projectProfileChanged: boolean;
  readonly preservedUserEdits: boolean;
  readonly refreshedProjectFacts: boolean;
}

export interface ResolveHubProjectDevelopmentContractStateInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly now?: Date;
}

export interface ConfigureHubProjectDevelopmentContractInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly projectProfileName: string;
  readonly now?: Date;
}

const contractPathFor = (hubProjectDir: string): string =>
  join(hubProjectDir, HUB_PROJECT_DEVELOPMENT_CONTRACT_FILE_NAME);

const contractBackupPathFor = (
  hubProjectDir: string,
  profileName: string,
  now: string,
): string =>
  join(
    hubProjectDir,
    `development-contract.backup-${profileName}-${now
      .replace(/:/g, "-")
      .replace(/\./g, "-")}.json`,
  );

const readPackageJsonConfiguredScripts = (
  repoRoot: string,
): readonly string[] => {
  const packageJsonPath = join(repoRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as
      | { scripts?: Record<string, unknown> }
      | undefined;
    const scripts = packageJson?.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      return [];
    }

    return Object.entries(scripts)
      .filter(
        ([, value]) => typeof value === "string" && value.trim().length > 0,
      )
      .map(([name]) => name)
      .sort();
  } catch {
    return [];
  }
};

const scanHubProjectFacts = (
  repoRoot: string,
): HubProjectDevelopmentContractFacts => ({
  observedFiles: PROJECT_FACT_SIGNAL_FILES.filter((fileName) =>
    existsSync(join(repoRoot, fileName)),
  ),
  configuredScripts: readPackageJsonConfiguredScripts(repoRoot),
});

const hasProjectFactSummary = (
  facts: HubProjectDevelopmentContractFacts,
): boolean =>
  facts.observedFiles.length > 0 || facts.configuredScripts.length > 0;

export const formatHubProjectDevelopmentContractFactsSummary = (
  facts: HubProjectDevelopmentContractFacts,
): string => {
  if (facts.observedFiles.length > 0 && facts.configuredScripts.length > 0) {
    return `${facts.observedFiles.join(", ")}; scripts: ${facts.configuredScripts.join(", ")}`;
  }

  if (facts.observedFiles.length > 0) {
    return facts.observedFiles.join(", ");
  }

  if (facts.configuredScripts.length > 0) {
    return `scripts: ${facts.configuredScripts.join(", ")}`;
  }

  return "no obvious stack signals";
};

const buildSetupLines = (
  profile: ProjectProfileEntry,
  facts: HubProjectDevelopmentContractFacts,
): readonly string[] => {
  const observedFiles = formatHubProjectDevelopmentContractFactsSummary(facts);

  switch (profile.name) {
    case "node":
      return [
        "Use the Node bootstrap guidance to prepare dependencies before implementation.",
        `Observed repo signals: ${observedFiles}.`,
      ];
    case "python":
      return [
        "Use the Python bootstrap guidance to prepare the virtual environment before implementation.",
        `Observed repo signals: ${observedFiles}.`,
      ];
    case "cpp":
      return [
        "Use the C++ bootstrap guidance to configure the toolchain before implementation.",
        `Observed repo signals: ${observedFiles}.`,
      ];
    default:
      return [
        "Use the Hub-owned bootstrap guidance as a no-op baseline until the repo-specific setup is customized.",
        `Observed repo signals: ${observedFiles}.`,
      ];
  }
};

const buildVerifyLines = (profile: ProjectProfileEntry): readonly string[] => [
  profile.promptVerifyGuidance,
];

const buildContextLines = (
  profile: ProjectProfileEntry,
  facts: HubProjectDevelopmentContractFacts,
): readonly string[] => {
  const observed = hasProjectFactSummary(facts)
    ? `Observed repo facts: ${formatHubProjectDevelopmentContractFactsSummary(facts)}.`
    : "No obvious stack signals were observed in the repository root.";

  const profileNote =
    profile.name === DEFAULT_PROJECT_PROFILE_NAME
      ? "Generic profile selected; repo facts remain advisory until the project is configured with a specific profile."
      : "Selected project profile remains authoritative over observed repo facts.";

  return [observed, profileNote];
};

const buildHubProjectDevelopmentContract = (input: {
  readonly profile: ProjectProfileEntry;
  readonly facts: HubProjectDevelopmentContractFacts;
  readonly createdAt: string;
  readonly updatedAt: string;
}): HubProjectDevelopmentContract => ({
  version: HUB_PROJECT_DEVELOPMENT_CONTRACT_VERSION,
  projectProfile: input.profile.name,
  projectFacts: input.facts,
  setup: buildSetupLines(input.profile, input.facts),
  verify: buildVerifyLines(input.profile),
  context: buildContextLines(input.profile, input.facts),
  timestamps: {
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  },
});

const readStringArray = (value: unknown, path: string): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return value;
};

const readRecord = (
  value: unknown,
  errorMessage: string,
): Readonly<Record<string, unknown>> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(errorMessage);
};

const normalizeContract = (
  value: unknown,
  contractPath: string,
): HubProjectDevelopmentContract => {
  const record = readRecord(
    value,
    `Hub project development contract at ${contractPath} must be a JSON object.`,
  );

  if (record.version !== HUB_PROJECT_DEVELOPMENT_CONTRACT_VERSION) {
    throw new Error(
      `Hub project development contract at ${contractPath} must use version ${HUB_PROJECT_DEVELOPMENT_CONTRACT_VERSION}.`,
    );
  }

  const projectProfile = record.projectProfile;
  if (
    typeof projectProfile !== "string" ||
    projectProfile.trim().length === 0
  ) {
    throw new Error(
      `Hub project development contract at ${contractPath} must include a projectProfile string.`,
    );
  }

  const projectFacts = readRecord(
    record.projectFacts,
    `Hub project development contract at ${contractPath} must include a projectFacts object.`,
  );

  const timestamps = readRecord(
    record.timestamps,
    `Hub project development contract at ${contractPath} must include a timestamps object.`,
  );

  const createdAt = timestamps.createdAt;
  const updatedAt = timestamps.updatedAt;
  if (typeof createdAt !== "string" || createdAt.trim().length === 0) {
    throw new Error(
      `Hub project development contract at ${contractPath} must include timestamps.createdAt.`,
    );
  }
  if (typeof updatedAt !== "string" || updatedAt.trim().length === 0) {
    throw new Error(
      `Hub project development contract at ${contractPath} must include timestamps.updatedAt.`,
    );
  }

  return {
    version: HUB_PROJECT_DEVELOPMENT_CONTRACT_VERSION,
    projectProfile: projectProfile.trim(),
    projectFacts: {
      observedFiles: readStringArray(
        projectFacts.observedFiles,
        `${contractPath}.projectFacts.observedFiles`,
      ),
      configuredScripts: readOptionalStringArray(
        projectFacts.configuredScripts,
        `${contractPath}.projectFacts.configuredScripts`,
      ),
    },
    setup: readStringArray(record.setup, `${contractPath}.setup`),
    verify: readStringArray(record.verify, `${contractPath}.verify`),
    context: readStringArray(record.context, `${contractPath}.context`),
    timestamps: {
      createdAt: createdAt.trim(),
      updatedAt: updatedAt.trim(),
    },
  };
};

const readOptionalStringArray = (
  value: unknown,
  path: string,
): readonly string[] => {
  if (value === undefined) {
    return [];
  }
  return readStringArray(value, path);
};

const readHubProjectDevelopmentContractFile = (
  contractPath: string,
): HubProjectDevelopmentContract => {
  const raw = readFileSync(contractPath, "utf8");
  return normalizeContract(JSON.parse(raw) as unknown, contractPath);
};

const writeHubProjectDevelopmentContractFile = (
  contractPath: string,
  contract: HubProjectDevelopmentContract,
): void => {
  mkdirSync(dirname(contractPath), { recursive: true });
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
};

const formatHubProjectDevelopmentContractPromptSection = (
  lines: readonly string[],
): string =>
  lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- (none)";

export const resolveHubProjectDevelopmentContractPath = (
  hubProjectDir: string,
): string => contractPathFor(hubProjectDir);

export const listHubProjectDevelopmentContractSupportedProfiles = (): string =>
  formatProjectProfileNames();

const buildConfiguredHubProjectDevelopmentContract = (input: {
  readonly existing: HubProjectDevelopmentContractState;
  readonly profile: ProjectProfileEntry;
  readonly facts: HubProjectDevelopmentContractFacts;
  readonly now: string;
}): HubProjectDevelopmentContract => {
  const { existing, profile, facts, now } = input;
  if (existing.persisted && existing.contract.projectProfile === profile.name) {
    return {
      ...existing.contract,
      projectFacts: facts,
      timestamps: {
        createdAt: existing.contract.timestamps.createdAt,
        updatedAt: now,
      },
    };
  }

  return buildHubProjectDevelopmentContract({
    profile,
    facts,
    createdAt: existing.persisted
      ? existing.contract.timestamps.createdAt
      : now,
    updatedAt: now,
  });
};

export const resolveHubProjectDevelopmentContractState = (
  input: ResolveHubProjectDevelopmentContractStateInput,
): HubProjectDevelopmentContractState => {
  const contractPath = contractPathFor(input.hubProjectDir);
  const persisted = existsSync(contractPath);
  if (persisted) {
    const contract = readHubProjectDevelopmentContractFile(contractPath);
    return {
      contractPath,
      contract,
      persisted: true,
    };
  }

  const profile = getProjectProfile(DEFAULT_PROJECT_PROFILE_NAME);
  if (!profile) {
    throw new Error(
      `Default project profile "${DEFAULT_PROJECT_PROFILE_NAME}" is unavailable.`,
    );
  }

  const facts = scanHubProjectFacts(input.repoRoot);
  const now = (input.now ?? new Date()).toISOString();

  return {
    contractPath,
    contract: buildHubProjectDevelopmentContract({
      profile,
      facts,
      createdAt: now,
      updatedAt: now,
    }),
    persisted: false,
  };
};

export const buildHubProjectDevelopmentContractPromptArgs = (input: {
  readonly contract: HubProjectDevelopmentContractState;
}): Readonly<Record<string, string>> => ({
  PROJECT_PROFILE: input.contract.contract.projectProfile,
  PROJECT_DEVELOPMENT_CONTRACT_PATH: input.contract.contractPath,
  PROJECT_DEVELOPMENT_CONTRACT_SETUP:
    formatHubProjectDevelopmentContractPromptSection(
      input.contract.contract.setup,
    ),
  PROJECT_DEVELOPMENT_CONTRACT_VERIFY:
    formatHubProjectDevelopmentContractPromptSection(
      input.contract.contract.verify,
    ),
  PROJECT_DEVELOPMENT_CONTRACT_CONTEXT:
    formatHubProjectDevelopmentContractPromptSection(
      input.contract.contract.context,
    ),
});

export const ensureHubProjectDevelopmentContractState = (
  input: ResolveHubProjectDevelopmentContractStateInput,
): EnsureHubProjectDevelopmentContractStateResult => {
  const resolved = resolveHubProjectDevelopmentContractState(input);
  if (resolved.persisted) {
    return {
      ...resolved,
      createdGenericFallback: false,
    };
  }

  writeHubProjectDevelopmentContractFile(
    resolved.contractPath,
    resolved.contract,
  );

  return {
    ...resolved,
    persisted: true,
    createdGenericFallback: true,
  };
};

export const configureHubProjectDevelopmentContract = (
  input: ConfigureHubProjectDevelopmentContractInput,
): ConfigureHubProjectDevelopmentContractResult => {
  const profile = getProjectProfile(input.projectProfileName);
  if (!profile) {
    throw new Error(
      `Unknown project profile "${input.projectProfileName}". Available: ${listHubProjectDevelopmentContractSupportedProfiles()}`,
    );
  }

  const contractPath = contractPathFor(input.hubProjectDir);
  const existing = resolveHubProjectDevelopmentContractState({
    repoRoot: input.repoRoot,
    hubProjectDir: input.hubProjectDir,
    now: input.now,
  });
  const now = (input.now ?? new Date()).toISOString();
  const facts = scanHubProjectFacts(input.repoRoot);
  const projectProfileChanged =
    existing.persisted && existing.contract.projectProfile !== profile.name;
  const contract = buildConfiguredHubProjectDevelopmentContract({
    existing,
    profile,
    facts,
    now,
  });
  let backupPath: string | undefined;

  if (projectProfileChanged) {
    backupPath = contractBackupPathFor(
      input.hubProjectDir,
      existing.contract.projectProfile,
      now,
    );
    writeHubProjectDevelopmentContractFile(backupPath, existing.contract);
  }

  writeHubProjectDevelopmentContractFile(contractPath, contract);

  return {
    contractPath,
    contract,
    persisted: true,
    backupPath,
    projectProfileChanged,
    preservedUserEdits: existing.persisted && !projectProfileChanged,
    refreshedProjectFacts: true,
  };
};

// ---------------------------------------------------------------------------
// project configure summary model (Variant C section primitive)
// ---------------------------------------------------------------------------

const PROJECT_CONFIGURE_KV_GUTTER = 32;

export interface HubProjectConfigureSummaryModel {
  readonly header: SectionHeaderBlock;
  readonly identity: SectionKvBlock;
  readonly footer: SectionFooterBlock;
}

export interface BuildHubProjectConfigureSummaryModelInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly contract: ConfigureHubProjectDevelopmentContractResult;
  readonly editOutcome: string;
  readonly landingHostTargetBranch?: string;
  readonly landingPublishTargetRef?: string;
  readonly landingPublishPolicy?: string;
  readonly landingRemoteTarget?: string;
}

const describeContractConfigureAction = (
  contract: ConfigureHubProjectDevelopmentContractResult,
): string => {
  if (contract.backupPath) {
    return "replaced (backup created)";
  }
  if (contract.preservedUserEdits) {
    return "refreshed (user edits preserved)";
  }
  return "wrote new contract";
};

export const buildHubProjectConfigureSummaryModel = (
  input: BuildHubProjectConfigureSummaryModelInput,
): HubProjectConfigureSummaryModel => {
  const {
    repoRoot,
    hubProjectDir,
    contract,
    editOutcome,
    landingHostTargetBranch,
    landingPublishTargetRef,
    landingPublishPolicy,
    landingRemoteTarget,
  } = input;
  const rows: SectionKvBlock["rows"][number][] = [
    { key: "Repository root", value: repoRoot },
    { key: "Hub project dir", value: hubProjectDir },
    { key: "Hub project profile", value: contract.contract.projectProfile },
    {
      key: "Hub project development contract",
      value: contract.contractPath,
    },
    {
      key: "Project facts refreshed",
      value: formatHubProjectDevelopmentContractFactsSummary(
        contract.contract.projectFacts,
      ),
    },
    {
      key: "User-edited setup/verify/context",
      value: editOutcome,
    },
    {
      key: "Previous contract backup",
      value: contract.backupPath ?? "none",
    },
    { key: "Outcome", value: describeContractConfigureAction(contract) },
    ...(landingHostTargetBranch
      ? [
          {
            key: "Host target branch",
            value: landingHostTargetBranch,
          },
          {
            key: "Hub publish target",
            value: landingPublishTargetRef ?? "(unpinned)",
          },
          {
            key: "Publish policy",
            value: landingPublishPolicy ?? "off",
          },
          {
            key: "Remote target",
            value: landingRemoteTarget ?? "(none)",
          },
        ]
      : []),
  ];

  return {
    header: {
      kind: "header",
      title: "archLoop",
      subtitle: "project · configure",
      right: contract.contract.projectProfile,
    },
    identity: {
      kind: "kv",
      gutter: PROJECT_CONFIGURE_KV_GUTTER,
      rows,
    },
    footer: {
      kind: "footer",
      label: "next",
      command: "archloop project status",
    },
  };
};

export const hubProjectConfigureSummaryModelToBlocks = (
  model: HubProjectConfigureSummaryModel,
): readonly SectionBlock[] => [model.header, model.identity, model.footer];
