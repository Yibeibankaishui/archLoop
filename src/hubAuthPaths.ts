import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveArchloopUserDataDir } from "./projectStatus.js";

export type HubLoginProviderId = "codex" | "github";

const HUB_AUTH_DIR_NAMES: Record<HubLoginProviderId, string> = {
  codex: "codex",
  github: "github",
};

export interface HubAuthPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export const resolveHubAuthDir = (
  providerId: HubLoginProviderId,
  options: HubAuthPathOptions = {},
): string =>
  join(
    resolveArchloopUserDataDir(options.env, options.homeDir),
    "hub",
    "auth",
    HUB_AUTH_DIR_NAMES[providerId],
  );

export const ensureHubAuthDir = (
  providerId: HubLoginProviderId,
  options: HubAuthPathOptions = {},
): string => {
  const authDir = resolveHubAuthDir(providerId, options);
  mkdirSync(authDir, { recursive: true });
  return authDir;
};
