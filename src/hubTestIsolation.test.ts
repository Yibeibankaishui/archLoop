import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HubProjectRegistryError } from "./errors.js";
import {
  REAL_HUB_REGISTRY_TEST_GUARD_MESSAGE,
  assertHubUserDataDirIsolatedForTests,
  resolveDefaultArchloopUserDataDir,
} from "./hubTestIsolation.js";
import { resolveHubProjectRegistryPath } from "./hubProjectRegistry.js";

describe("Hub registry test isolation guard", () => {
  it("rejects the default user data directory during tests", () => {
    expect(() =>
      assertHubUserDataDirIsolatedForTests(resolveDefaultArchloopUserDataDir()),
    ).toThrow(REAL_HUB_REGISTRY_TEST_GUARD_MESSAGE);
  });

  it("fails when a test resolves the real user registry path", () => {
    expect(() =>
      resolveHubProjectRegistryPath({
        env: {
          XDG_DATA_HOME: join(homedir(), ".local", "share"),
        },
      }),
    ).toThrowError(
      new HubProjectRegistryError({
        message: REAL_HUB_REGISTRY_TEST_GUARD_MESSAGE,
      }),
    );
  });
});
