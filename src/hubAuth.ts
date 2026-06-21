import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { maskEnvValue } from "./envFile.js";
import { readHubEnvFile, type HubEnvKnownKey } from "./hubEnv.js";
import {
  ensureHubAuthDir,
  resolveHubAuthDir,
  type HubLoginProviderId,
} from "./hubAuthPaths.js";
import { resolveArchloopUserDataDir } from "./projectStatus.js";

export type HubAuthProviderId =
  | "codex"
  | "github"
  | "cursor"
  | "opencode"
  | "claude-code"
  | "pi";

export interface HubAuthStoreOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

interface HubAuthProvider {
  readonly id: HubAuthProviderId;
  readonly label: string;
  readonly envKey: HubEnvKnownKey;
  readonly authEnvVar?: "CODEX_HOME" | "GH_CONFIG_DIR";
  readonly authDirName?: string;
  readonly loginCommand?: string;
  readonly loginSupported: boolean;
}

const HUB_AUTH_PROVIDERS: readonly HubAuthProvider[] = [
  {
    id: "codex",
    label: "Codex",
    envKey: "OPENAI_KEY",
    authEnvVar: "CODEX_HOME",
    authDirName: "codex",
    loginCommand: "codex login",
    loginSupported: true,
  },
  {
    id: "github",
    label: "GitHub",
    envKey: "GH_TOKEN",
    authEnvVar: "GH_CONFIG_DIR",
    authDirName: "github",
    loginCommand: "gh auth login --insecure-storage",
    loginSupported: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    envKey: "CURSOR_API_KEY",
    loginSupported: false,
  },
  {
    id: "opencode",
    label: "OpenCode",
    envKey: "OPENCODE_API_KEY",
    loginSupported: false,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    envKey: "ANTHROPIC_API_KEY",
    loginSupported: false,
  },
  {
    id: "pi",
    label: "Pi",
    envKey: "ANTHROPIC_API_KEY",
    loginSupported: false,
  },
];

export const listHubAuthProviders = (): readonly HubAuthProviderId[] =>
  HUB_AUTH_PROVIDERS.map((provider) => provider.id);

const getHubAuthProvider = (providerId: string): HubAuthProvider => {
  const provider = HUB_AUTH_PROVIDERS.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(
      `Unknown auth provider "${providerId}". Known providers: ${listHubAuthProviders().join(", ")}.`,
    );
  }
  return provider;
};

export const resolveProviderHubAuthDir = (
  providerId: string,
  options: HubAuthStoreOptions = {},
): string => {
  const provider = getHubAuthProvider(providerId);
  if (!provider.authDirName) {
    throw new Error(
      `Provider "${providerId}" does not have a Hub auth directory. Use \`archloop env set ${provider.envKey} <value>\`.`,
    );
  }

  return resolveHubAuthDir(provider.id as HubLoginProviderId, options);
};

const hasHubAuthSession = (
  provider: HubAuthProvider,
  options: HubAuthStoreOptions,
): boolean => {
  if (!provider.authDirName) {
    return false;
  }

  const authDir = resolveProviderHubAuthDir(provider.id, options);
  try {
    return existsSync(authDir) && readdirSync(authDir).length > 0;
  } catch {
    return false;
  }
};

export { ensureHubAuthDir };

export const getHubAuthLoginCommand = (
  providerId: "codex" | "github",
): string => getHubAuthProvider(providerId).loginCommand!;

export const getHubAuthEnvVar = (
  providerId: "codex" | "github",
): "CODEX_HOME" | "GH_CONFIG_DIR" => getHubAuthProvider(providerId).authEnvVar!;

export const formatHubAuthShowLines = (
  options: HubAuthStoreOptions = {},
): readonly string[] => {
  const env = options.env ?? process.env;
  const hubEnv = readHubEnvFile(options);
  const lines = [
    `Hub auth directory: ${join(resolveArchloopUserDataDir(env, options.homeDir), "hub", "auth")}`,
    "",
  ];

  for (const provider of HUB_AUTH_PROVIDERS) {
    const runtimeValue = env[provider.envKey] ?? "";
    const hubValue = hubEnv[provider.envKey] ?? "";
    const authDirReady = hasHubAuthSession(provider, options);

    let status: string;
    if (runtimeValue.length > 0) {
      status = `process env ${provider.envKey}=${maskEnvValue(provider.envKey, runtimeValue)}`;
    } else if (hubValue.length > 0) {
      status = `Hub env file ${provider.envKey}=${maskEnvValue(provider.envKey, hubValue)}`;
    } else if (authDirReady && provider.authEnvVar) {
      status = `Hub auth dir/session (${provider.authEnvVar}=${resolveProviderHubAuthDir(provider.id, options)})`;
    } else {
      status = "missing";
    }

    lines.push(`  ${provider.id}: ${status}`);

    if (status === "missing") {
      if (provider.loginSupported) {
        lines.push(`    Login: archloop auth login ${provider.id}`);
      }
      lines.push(
        `    API key/token: archloop env set ${provider.envKey} <value>`,
      );
    } else if (!provider.loginSupported) {
      lines.push(
        `    Provider login is not supported yet. Use \`archloop env set ${provider.envKey} <value>\`.`,
      );
    }
  }

  return lines;
};

export const resolveHubAuthSessionEnv = (
  options: HubAuthStoreOptions = {},
): Record<string, string> => {
  const env = options.env ?? process.env;
  const resolved: Record<string, string> = {};

  for (const provider of HUB_AUTH_PROVIDERS) {
    if (!provider.authEnvVar) {
      continue;
    }

    const runtimeValue = env[provider.authEnvVar] ?? "";
    if (runtimeValue.length > 0) {
      resolved[provider.authEnvVar] = runtimeValue;
      continue;
    }

    if (hasHubAuthSession(provider, options)) {
      resolved[provider.authEnvVar] = resolveProviderHubAuthDir(
        provider.id,
        options,
      );
    }
  }

  return resolved;
};
