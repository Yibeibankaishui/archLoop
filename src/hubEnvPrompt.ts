import * as clack from "@clack/prompts";

import {
  collectHubEnvKeysForSetup,
  ensureHubEnvFile,
  readHubEnvFile,
  type HubEnvKnownKey,
  type HubEnvStoreOptions,
  writeHubEnvFile,
} from "./hubEnv.js";
import { maskEnvValue } from "./envFile.js";

const promptHubEnvValue = async (
  key: HubEnvKnownKey,
  currentValue: string,
): Promise<string | null> => {
  const status =
    currentValue.length > 0
      ? `current: ${maskEnvValue(key, currentValue)}`
      : "not set";
  const value = await clack.password({
    message: `${key} (${status}). Leave blank to keep unchanged.`,
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
): Promise<Record<string, string>> => {
  clack.intro("Configure Hub environment variables");
  clack.log.info(
    "Codex users can use `sandcastle auth login codex` for Codex/ChatGPT CLI session auth. `OPENAI_KEY` uses OpenAI API billing.",
  );

  const { created } = ensureHubEnvFile(options);
  if (created) {
    clack.log.info("Created Hub env file with placeholders.");
  }

  const keys = collectHubEnvKeysForSetup(options);
  const existing = readHubEnvFile(options);
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
