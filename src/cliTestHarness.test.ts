import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLI_TEST_XDG_CACHE_DIRNAME,
  CLI_TEST_XDG_CONFIG_DIRNAME,
  CLI_TEST_XDG_DATA_DIRNAME,
  withBdEnv,
} from "./cliTestHarness.js";
import {
  readHubProjectRegistry,
  resolveHubProjectRegistryPath,
} from "./hubProjectRegistry.js";
import { resolveArchloopUserDataDir } from "./projectStatus.js";

const execAsync = promisify(exec);

const realHubRegistryPath = () =>
  join(
    homedir(),
    ".local",
    "share",
    "archloop",
    "hub",
    "project-registry.json",
  );

const snapshotRealRegistry = (): string | undefined => {
  const path = realHubRegistryPath();
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
};

const restoreRealRegistry = (snapshot: string | undefined): void => {
  const path = realHubRegistryPath();
  if (snapshot === undefined || !existsSync(path)) {
    return;
  }
  if (readFileSync(path, "utf8") !== snapshot) {
    writeFileSync(path, snapshot);
  }
};

const initCommittedRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, "hello.txt"), "hello\n");
  await execAsync("git add hello.txt && git commit -m initial", { cwd: dir });
};

describe("withBdEnv isolation", () => {
  const originalXdg = {
    data: process.env.XDG_DATA_HOME,
    config: process.env.XDG_CONFIG_HOME,
    cache: process.env.XDG_CACHE_HOME,
  };

  afterEach(() => {
    const restore = (
      key: "XDG_DATA_HOME" | "XDG_CONFIG_HOME" | "XDG_CACHE_HOME",
      value: string | undefined,
    ) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("XDG_DATA_HOME", originalXdg.data);
    restore("XDG_CONFIG_HOME", originalXdg.config);
    restore("XDG_CACHE_HOME", originalXdg.cache);
  });

  it("uses test-owned XDG roots when callers omit an explicit environment", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initCommittedRepo(repoDir);
    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(bdPath, "#!/bin/sh\nexit 0\n");
    await chmod(bdPath, 0o755);

    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CACHE_HOME;

    const before = snapshotRealRegistry();
    try {
      const env = withBdEnv(bdPath, repoDir);

      expect(env.XDG_DATA_HOME).toBe(join(repoDir, CLI_TEST_XDG_DATA_DIRNAME));
      expect(env.XDG_CONFIG_HOME).toBe(
        join(repoDir, CLI_TEST_XDG_CONFIG_DIRNAME),
      );
      expect(env.XDG_CACHE_HOME).toBe(
        join(repoDir, CLI_TEST_XDG_CACHE_DIRNAME),
      );
      expect(resolve(resolveArchloopUserDataDir(env))).toBe(
        resolve(join(repoDir, CLI_TEST_XDG_DATA_DIRNAME, "archloop")),
      );
      expect(resolve(dirname(resolveHubProjectRegistryPath({ env })))).toBe(
        resolve(join(repoDir, CLI_TEST_XDG_DATA_DIRNAME, "archloop", "hub")),
      );

      const registered = readHubProjectRegistry({ env });
      expect(registered).toHaveLength(1);
      expect(registered[0]?.hubProjectDir.startsWith(env.XDG_DATA_HOME!)).toBe(
        true,
      );
      expect(snapshotRealRegistry()).toBe(before);
    } finally {
      restoreRealRegistry(before);
    }
  });

  it("keeps test-owned XDG roots when merged env leaves them empty", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initCommittedRepo(repoDir);
    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(bdPath, "#!/bin/sh\nexit 0\n");
    await chmod(bdPath, 0o755);

    const env = withBdEnv(bdPath, repoDir, {
      XDG_DATA_HOME: "",
      XDG_CONFIG_HOME: "   ",
      XDG_CACHE_HOME: "",
    });

    expect(env.XDG_DATA_HOME).toBe(join(repoDir, CLI_TEST_XDG_DATA_DIRNAME));
    expect(env.XDG_CONFIG_HOME).toBe(
      join(repoDir, CLI_TEST_XDG_CONFIG_DIRNAME),
    );
    expect(env.XDG_CACHE_HOME).toBe(join(repoDir, CLI_TEST_XDG_CACHE_DIRNAME));
  });
});
