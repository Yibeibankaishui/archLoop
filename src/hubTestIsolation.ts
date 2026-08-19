import { homedir } from "node:os";
import { resolve } from "node:path";

import { HubProjectRegistryError } from "./errors.js";
import { resolveArchloopUserDataDir } from "./projectStatus.js";

export const REAL_HUB_REGISTRY_TEST_GUARD_MESSAGE =
  "Tests must not resolve the real Hub project registry. Set a test-owned XDG_DATA_HOME (and isolated XDG_CONFIG_HOME / XDG_CACHE_HOME) before Hub registry or selection I/O.";

export const resolveDefaultArchloopUserDataDir = (
  homeDir: string = homedir(),
): string => resolveArchloopUserDataDir({} as NodeJS.ProcessEnv, homeDir);

export const isRealArchloopUserDataDir = (
  userDataDir: string,
  homeDir: string = homedir(),
): boolean =>
  resolve(userDataDir) === resolve(resolveDefaultArchloopUserDataDir(homeDir));

export const assertHubUserDataDirIsolatedForTests = (
  userDataDir: string,
  homeDir: string = homedir(),
): void => {
  if (process.env.VITEST !== "true") {
    return;
  }
  if (process.env.ARCHLOOP_ALLOW_REAL_HUB_REGISTRY === "1") {
    return;
  }
  if (isRealArchloopUserDataDir(userDataDir, homeDir)) {
    throw new HubProjectRegistryError({
      message: REAL_HUB_REGISTRY_TEST_GUARD_MESSAGE,
    });
  }
};
