import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getAgentRuntime, listAgents } from "./InitService.js";
import {
  maskEnvValue,
  parseEnvFileContent,
  serializeEnvFile,
} from "./envFile.js";
import type { HubAgentConfig } from "./hubAgentConfig.js";
import { readHubAgentConfig } from "./hubAgentConfig.js";
import {
  formatHubEnvKeyAcquisitionHint,
  getHubEnvKeyGuidance,
} from "./hubEnvKeyGuidance.js";
import { resolveArchloopUserDataDir } from "./projectStatus.js";

export const HUB_ENV_KNOWN_KEYS = [
  "CURSOR_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_KEY",
  "OPENCODE_API_KEY",
  "GH_TOKEN",
] as const;

export type HubEnvKnownKey = (typeof HUB_ENV_KNOWN_KEYS)[number];

const HUB_ENV_KNOWN_KEY_SET = new Set<string>(HUB_ENV_KNOWN_KEYS);

export interface HubEnvStoreOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export const resolveHubEnvPath = (options: HubEnvStoreOptions = {}): string => {
  const userDataDir = resolveArchloopUserDataDir(options.env, options.homeDir);
  return `${userDataDir}/.env`;
};

export const buildDefaultHubEnvTemplate = (): string =>
  serializeEnvFile(
    Object.fromEntries(HUB_ENV_KNOWN_KEYS.map((key) => [key, ""])),
    [
      "# archLoop Hub shared credentials",
      "# Values here apply to Hub flows (tasks from-prd, triage, run, and so on).",
      "# process.env overrides non-empty values at runtime.",
      "# Project .archloop/.env overrides Hub values for the same key when set.",
    ],
  );

export const readHubEnvFile = (
  options: HubEnvStoreOptions = {},
): Record<string, string> => {
  const envPath = resolveHubEnvPath(options);
  try {
    return parseEnvFileContent(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
};

export const resolveHubEnv = (
  options: HubEnvStoreOptions = {},
): Record<string, string> => {
  const runtimeEnv = options.env ?? process.env;
  const fileEnv = readHubEnvFile(options);
  const resolved: Record<string, string> = {};

  for (const [key, fileValue] of Object.entries(fileEnv)) {
    const runtimeValue = runtimeEnv[key];
    const value =
      runtimeValue && runtimeValue.length > 0 ? runtimeValue : fileValue;
    if (value && value.length > 0) {
      resolved[key] = value;
    }
  }

  return resolved;
};

export const mergeHubAndProjectEnv = (input: {
  readonly hubFileEnv: Readonly<Record<string, string>>;
  readonly projectFileEnv: Readonly<Record<string, string>>;
  readonly runtimeEnv?: NodeJS.ProcessEnv;
}): Record<string, string> => {
  const runtimeEnv = input.runtimeEnv ?? process.env;
  const allKeys = new Set([
    ...Object.keys(input.hubFileEnv),
    ...Object.keys(input.projectFileEnv),
  ]);
  const resolved: Record<string, string> = {};

  for (const key of allKeys) {
    const projectValue = input.projectFileEnv[key];
    const hubValue = input.hubFileEnv[key];
    const runtimeValue = runtimeEnv[key];

    let value: string | undefined;
    if (key in input.projectFileEnv) {
      value = projectValue || runtimeValue || hubValue;
    } else {
      value = runtimeValue && runtimeValue.length > 0 ? runtimeValue : hubValue;
    }

    if (value && value.length > 0) {
      resolved[key] = value;
    }
  }

  return resolved;
};

export const ensureHubEnvFile = (
  options: HubEnvStoreOptions = {},
): { readonly path: string; readonly created: boolean } => {
  const envPath = resolveHubEnvPath(options);
  try {
    readFileSync(envPath, "utf8");
    return { path: envPath, created: false };
  } catch {
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, buildDefaultHubEnvTemplate(), "utf8");
    return { path: envPath, created: true };
  }
};

export const writeHubEnvFile = (
  vars: Record<string, string>,
  options: HubEnvStoreOptions = {},
): string => {
  const envPath = resolveHubEnvPath(options);
  mkdirSync(dirname(envPath), { recursive: true });

  const existing = readHubEnvFile(options);
  const merged = { ...existing, ...vars };
  const header = [
    "# archLoop Hub shared credentials",
    "# Values here apply to Hub flows (tasks from-prd, triage, run, and so on).",
    "# process.env overrides non-empty values at runtime.",
    "# Project .archloop/.env overrides Hub values for the same key when set.",
  ];
  writeFileSync(envPath, serializeEnvFile(merged, header), "utf8");
  return envPath;
};

export const upsertHubEnvKey = (
  key: string,
  value: string,
  options: HubEnvStoreOptions = {},
): string => writeHubEnvFile({ [key]: value }, options);

export const isHubEnvKnownKey = (key: string): key is HubEnvKnownKey =>
  HUB_ENV_KNOWN_KEY_SET.has(key);

const providerEnvKeys = (provider: string): readonly HubEnvKnownKey[] => {
  const agent = getAgentRuntime(provider);
  return (agent?.envVars ?? []).filter(isHubEnvKnownKey);
};

export const collectHubEnvKeysForAgentConfig = (
  config: HubAgentConfig,
): HubEnvKnownKey[] => {
  const keys = new Set<HubEnvKnownKey>();
  for (const entry of Object.values(config.roles)) {
    if (!entry) {
      continue;
    }
    for (const envKey of providerEnvKeys(entry.provider)) {
      keys.add(envKey);
    }
  }
  return [...keys].sort();
};

export const collectHubEnvKeysForSetup = (
  options: HubEnvStoreOptions = {},
): HubEnvKnownKey[] => {
  const config = readHubAgentConfig(options);
  const roleKeys = collectHubEnvKeysForAgentConfig(config);
  if (roleKeys.length > 0) {
    return roleKeys.includes("GH_TOKEN") ? roleKeys : [...roleKeys, "GH_TOKEN"];
  }
  return [...HUB_ENV_KNOWN_KEYS];
};

export const formatHubEnvShowLines = (
  options: HubEnvStoreOptions = {},
): readonly string[] => {
  const envPath = resolveHubEnvPath(options);
  const fileEnv = readHubEnvFile(options);
  const resolved = resolveHubEnv(options);
  const runtimeEnv = options.env ?? process.env;
  const keys =
    Object.keys(fileEnv).length > 0
      ? [...new Set([...HUB_ENV_KNOWN_KEYS, ...Object.keys(fileEnv)])].sort()
      : [...HUB_ENV_KNOWN_KEYS];

  const lines = [`Hub env file: ${envPath}`, ""];
  let hasEmptyKnownKey = false;

  for (const key of keys) {
    const fileValue = fileEnv[key] ?? "";
    const effectiveValue = resolved[key] ?? "";
    const runtimeValue = runtimeEnv[key];
    const runtimeOverride =
      runtimeValue &&
      runtimeValue.length > 0 &&
      fileValue.length > 0 &&
      runtimeValue !== fileValue;

    lines.push(
      `  ${key}: ${maskEnvValue(key, effectiveValue)}${
        runtimeOverride ? " (overridden by process.env)" : ""
      }`,
    );

    if (effectiveValue.length === 0 && isHubEnvKnownKey(key)) {
      hasEmptyKnownKey = true;
      lines.push(`    hint: ${formatHubEnvKeyAcquisitionHint(key)}`);
    }
  }

  if (Object.keys(fileEnv).length === 0) {
    lines.push(
      "",
      "No Hub env file yet. Run `archloop env init` to create one.",
    );
  } else if (hasEmptyKnownKey) {
    lines.push("", "Run `archloop env init` for guided credential setup.");
  }

  return lines;
};

export const listHubEnvKeyDescriptions = (): readonly {
  readonly key: HubEnvKnownKey;
  readonly label: string;
}[] =>
  HUB_ENV_KNOWN_KEYS.map((key) => {
    const agent = listAgents().find((entry) =>
      getAgentRuntime(entry.name)?.envVars.includes(key),
    );
    const guidance = getHubEnvKeyGuidance(key);
    const backlogLabel =
      key === "GH_TOKEN" ? "GitHub Issues / gh CLI" : undefined;
    return {
      key,
      label: agent?.label ?? backlogLabel ?? guidance.service,
    };
  });
