import * as clack from "@clack/prompts";

import { maskEnvValue } from "./envFile.js";
import {
  collectHubEnvKeysForSetup,
  ensureHubEnvFile,
  readHubEnvFile,
  type HubEnvKnownKey,
  type HubEnvStoreOptions,
  writeHubEnvFile,
} from "./hubEnv.js";
import {
  formatHubEnvKeyGuidanceLines,
  HUB_ENV_BLANK_INPUT_NOTE,
} from "./hubEnvKeyGuidance.js";

const promptHubEnvValue = async (
  key: HubEnvKnownKey,
  currentValue: string,
): Promise<string | null> => {
  for (const line of formatHubEnvKeyGuidanceLines(key)) {
    clack.log.info(line);
  }

  const status =
    currentValue.length > 0
      ? `current: ${maskEnvValue(key, currentValue)}`
      : "not set";
  const value = await clack.password({
    message: `${key} (${status}). ${HUB_ENV_BLANK_INPUT_NOTE}`,
  });
  if (clack.isCancel(value)) {
    clack.cancel("Hub env setup cancelled.");
    process.exit(0);
  }

  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const promptInitHubEnv = async (
  options: HubEnvStoreOptions = {},
): Promise<Record<string, string>> =>
  promptHubEnvSetup(({ keys }) => keys, options);

const promptHubEnvSetup = async (
  selectKeys: (input: {
    readonly keys: readonly HubEnvKnownKey[];
    readonly existing: Readonly<Record<string, string>>;
  }) => readonly HubEnvKnownKey[],
  options: HubEnvStoreOptions,
): Promise<Record<string, string>> => {
  clack.intro("Configure Hub environment variables");
  clack.log.info(HUB_ENV_BLANK_INPUT_NOTE);

  const { created } = ensureHubEnvFile(options);
  if (created) {
    clack.log.info("Created Hub env file with placeholders.");
  }

  const existing = readHubEnvFile(options);
  const keys = selectKeys({
    keys: collectHubEnvKeysForSetup(options),
    existing,
  });
  const updates: Record<string, string> = {};

  for (const key of keys) {
    const nextValue = await promptHubEnvValue(key, existing[key] ?? "");
    if (nextValue) {
      updates[key] = nextValue;
    }
  }

  if (Object.keys(updates).length === 0) {
    clack.outro("No Hub env changes saved.");
    return existing;
  }

  const saved = { ...existing, ...updates };
  writeHubEnvFile(saved, options);
  clack.outro("Hub environment variables saved.");
  return saved;
};

export const promptInitializeHubEnv = async (
  options: HubEnvStoreOptions = {},
): Promise<Record<string, string>> =>
  promptHubEnvSetup(
    ({ keys, existing }) =>
      keys.filter((key) => (existing[key] ?? "").trim().length === 0),
    options,
  );
