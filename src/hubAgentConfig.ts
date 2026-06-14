import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getAgent } from "./InitService.js";
import { resolveSandcastleUserDataDir } from "./projectStatus.js";

export const HUB_AGENT_ROLES = [
  "planning",
  "triage",
  "implementation",
  "review",
  "merge",
  "recovery",
] as const;

export type HubAgentRole = (typeof HUB_AGENT_ROLES)[number];

export interface HubAgentRoleEntry {
  readonly provider: string;
  readonly model: string;
  readonly options?: Readonly<Record<string, string>>;
}

export interface HubAgentConfig {
  readonly roles: Partial<Record<HubAgentRole, HubAgentRoleEntry>>;
}

export interface HubAgentConfigStoreOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export type HubAgentRoleConfigurator = (
  role: HubAgentRole,
) => Promise<HubAgentRoleEntry>;

const isHubAgentRole = (role: string): role is HubAgentRole =>
  (HUB_AGENT_ROLES as readonly string[]).includes(role);

const normalizeCredentialKey = (key: string): string =>
  key.toLowerCase().replace(/[_-]/g, "");

const isCredentialKey = (key: string): boolean => {
  const normalized = normalizeCredentialKey(key);
  return (
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized === "auth" ||
    normalized.includes("login")
  );
};

const assertNoCredentialFields = (
  value: unknown,
  path = "role config",
): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isCredentialKey(key)) {
      throw new Error(
        `Hub agent ${path} cannot store credentials or auth state (${key})`,
      );
    }
    if (nested && typeof nested === "object") {
      assertNoCredentialFields(nested, `${path}.${key}`);
    }
  }
};

const normalizeOptions = (
  options: HubAgentRoleEntry["options"],
): HubAgentRoleEntry["options"] | undefined => {
  if (!options) {
    return undefined;
  }

  const entries = Object.entries(options).filter(
    ([, value]) => value.length > 0,
  );
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
};

const normalizeRoleEntry = (entry: HubAgentRoleEntry): HubAgentRoleEntry => {
  const options = normalizeOptions(entry.options);
  return options
    ? { ...entry, options }
    : { provider: entry.provider, model: entry.model };
};

export const resolveHubAgentConfigPath = (
  options: HubAgentConfigStoreOptions = {},
): string => {
  const userDataDir = resolveSandcastleUserDataDir(
    options.env,
    options.homeDir,
  );
  return `${userDataDir}/hub/agent-roles.json`;
};

export const readHubAgentConfig = (
  options: HubAgentConfigStoreOptions = {},
): HubAgentConfig => {
  const configPath = resolveHubAgentConfigPath(options);
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      roles?: Partial<Record<string, HubAgentRoleEntry>>;
    };
    assertNoCredentialFields(parsed, "config");

    const roles: Partial<Record<HubAgentRole, HubAgentRoleEntry>> = {};
    for (const [role, entry] of Object.entries(parsed.roles ?? {})) {
      if (!entry || !isHubAgentRole(role)) {
        continue;
      }
      roles[role] = normalizeRoleEntry(entry);
    }

    return { roles };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { roles: {} };
    }
    throw error;
  }
};

const writeHubAgentConfig = (
  config: HubAgentConfig,
  options: HubAgentConfigStoreOptions = {},
): void => {
  const configPath = resolveHubAgentConfigPath(options);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ roles: config.roles }, null, 2)}\n`,
    "utf8",
  );
};

export const validateHubAgentRoleEntry = (
  role: string,
  entry: HubAgentRoleEntry,
): HubAgentRole => {
  if (!isHubAgentRole(role)) {
    throw new Error(
      `Unknown Hub agent role "${role}". Supported roles: ${HUB_AGENT_ROLES.join(", ")}`,
    );
  }

  const provider = entry.provider.trim();
  const model = entry.model.trim();
  if (provider.length === 0 || model.length === 0) {
    throw new Error(
      `Hub agent role "${role}" requires a non-empty provider and model`,
    );
  }

  if (!getAgent(provider)) {
    throw new Error(
      `Unknown agent provider "${provider}" for role "${role}". Supported providers: claude-code, pi, codex, cursor, opencode`,
    );
  }

  assertNoCredentialFields(entry, `role "${role}"`);
  return role;
};

export const setHubAgentRole = (
  role: string,
  entry: HubAgentRoleEntry,
  options: HubAgentConfigStoreOptions = {},
): HubAgentConfig => {
  const validatedRole = validateHubAgentRoleEntry(role, entry);
  const config = readHubAgentConfig(options);
  const nextConfig: HubAgentConfig = {
    roles: {
      ...config.roles,
      [validatedRole]: normalizeRoleEntry(entry),
    },
  };
  writeHubAgentConfig(nextConfig, options);
  return nextConfig;
};

export const listMissingHubAgentRoles = (
  config: HubAgentConfig,
  requiredRoles: readonly HubAgentRole[] = HUB_AGENT_ROLES,
): HubAgentRole[] =>
  requiredRoles.filter((role) => config.roles[role] === undefined);

export const formatMissingHubAgentRolesMessage = (
  missingRoles: readonly HubAgentRole[],
): string => {
  const examples = missingRoles
    .map(
      (role) =>
        `sandcastle agent-config set-role ${role} --provider <provider> --model <model>`,
    )
    .join("\n");

  return [
    `Missing Hub agent role config: ${missingRoles.join(", ")}`,
    "Configure the required roles before running this flow:",
    examples,
    "Run `sandcastle agent-config show` to inspect current Hub agent roles.",
  ].join("\n");
};

export const formatHubAgentConfigShowLines = (
  config: HubAgentConfig,
  options: HubAgentConfigStoreOptions = {},
): string[] => {
  const lines = [
    `Hub agent config: ${resolveHubAgentConfigPath(options)}`,
    "",
    "Configured roles:",
  ];

  for (const role of HUB_AGENT_ROLES) {
    const entry = config.roles[role];
    if (!entry) {
      lines.push(`  ${role}: (missing)`);
      continue;
    }

    const optionSuffix = entry.options
      ? ` (${Object.entries(entry.options)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")})`
      : "";
    lines.push(`  ${role}: ${entry.provider} / ${entry.model}${optionSuffix}`);
  }

  const missingRoles = listMissingHubAgentRoles(config);
  if (missingRoles.length > 0) {
    lines.push("", `Missing roles: ${missingRoles.join(", ")}`);
    lines.push(
      "Configure a role with `sandcastle agent-config set-role <role> --provider <provider> --model <model>`.",
    );
  }

  return lines;
};

export const ensureHubAgentRolesConfigured = async (input: {
  readonly requiredRoles: readonly HubAgentRole[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly isTTY?: boolean;
  readonly configureRole?: HubAgentRoleConfigurator;
}): Promise<HubAgentConfig> => {
  const storeOptions = { env: input.env, homeDir: input.homeDir };
  let config = readHubAgentConfig(storeOptions);
  const missingRoles = listMissingHubAgentRoles(config, input.requiredRoles);
  if (missingRoles.length === 0) {
    return config;
  }

  const interactive =
    input.interactive ?? input.isTTY ?? process.stdin.isTTY ?? false;
  const canPrompt = interactive && !input.yes && input.configureRole;

  if (canPrompt) {
    for (const role of missingRoles) {
      const entry = await input.configureRole(role);
      config = setHubAgentRole(role, entry, storeOptions);
    }
    return config;
  }

  throw new Error(formatMissingHubAgentRolesMessage(missingRoles));
};
