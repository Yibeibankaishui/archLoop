import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HUB_RUNTIME_BRIDGE_CHANNELS } from "./hubRuntimeBridge.js";
import { createHubRuntimeBridgeService } from "./hubRuntimeBridgeService.js";

type HubDesktopPackageJson = {
  main: string;
  scripts: Record<string, string>;
  devDependencies: {
    electron: string;
  };
};

type HubDesktopLockfile = {
  lockfileVersion: number;
  packages: Record<string, { version?: string }>;
};

const hubDesktopDir = join(process.cwd(), "hub-desktop");
const deterministicInstallCommand = "npm ci";
const criticalAuditCommand = "npm audit --audit-level=critical";
const minimumPatchedElectronVersion = {
  major: 41,
  minor: 7,
  patch: 2,
} as const;

const readHubDesktopJson = <T>(fileName: string): T =>
  JSON.parse(readFileSync(join(hubDesktopDir, fileName), "utf8")) as T;

const readHubDesktopPackageJson = () =>
  readHubDesktopJson<HubDesktopPackageJson>("package.json");

const readHubDesktopLockfile = () =>
  readHubDesktopJson<HubDesktopLockfile>("package-lock.json");

const parseVersionMajor = (versionRange: string) => {
  const match = versionRange.match(/(\d+)\./);
  if (!match) {
    throw new Error(
      `Expected a semver-like version string, got ${versionRange}`,
    );
  }

  return Number(match[1]);
};

const parseVersionComponents = (versionRange: string) => {
  const match = versionRange.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(
      `Expected a semver-like version string, got ${versionRange}`,
    );
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};

const isAtLeastVersion = (versionRange: string) => {
  const version = parseVersionComponents(versionRange);

  if (version.major !== minimumPatchedElectronVersion.major) {
    return version.major > minimumPatchedElectronVersion.major;
  }

  if (version.minor !== minimumPatchedElectronVersion.minor) {
    return version.minor > minimumPatchedElectronVersion.minor;
  }

  return version.patch >= minimumPatchedElectronVersion.patch;
};

const ensureHubDesktopDependencies = (): void => {
  const hubDesktopTypeScript = join(
    hubDesktopDir,
    "node_modules",
    "typescript",
  );
  if (!existsSync(hubDesktopTypeScript)) {
    execSync("npm run install:ci", { cwd: hubDesktopDir, stdio: "pipe" });
  }
};

describe("hub desktop launch", () => {
  it("defines an independent hub-desktop package entrypoint and bridge channel", () => {
    const packageJson = readHubDesktopPackageJson();

    expect(packageJson.main).toBe("dist-electron/main.js");
    expect(packageJson.scripts.dev).toContain("electron");
    expect(packageJson.scripts.build).toContain("vite build");
    expect(HUB_RUNTIME_BRIDGE_CHANNELS.invoke).toBe("hub-runtime:invoke");
  });

  it("ships a committed lockfile and patched Electron for reproducible critical-clean installs", () => {
    const lockfilePath = join(hubDesktopDir, "package-lock.json");
    expect(existsSync(lockfilePath)).toBe(true);

    const packageJson = readHubDesktopPackageJson();
    const lockfile = readHubDesktopLockfile();
    const resolvedElectronVersion =
      lockfile.packages["node_modules/electron"]?.version;

    if (!resolvedElectronVersion) {
      throw new Error("Expected hub-desktop lockfile to include Electron");
    }

    expect(packageJson.scripts["install:ci"]).toBe(deterministicInstallCommand);
    expect(packageJson.scripts["audit:critical"]).toBe(criticalAuditCommand);
    expect(
      parseVersionMajor(packageJson.devDependencies.electron),
    ).toBeGreaterThanOrEqual(minimumPatchedElectronVersion.major);
    expect(lockfile.lockfileVersion).toBeGreaterThanOrEqual(3);
    expect(isAtLeastVersion(resolvedElectronVersion)).toBe(true);
    expect(lockfile.packages["node_modules/vitest"]).toBeUndefined();
  });

  it("can initialize the runtime bridge service used by the desktop main process", () => {
    const bridge = createHubRuntimeBridgeService({ useFixtures: true });
    expect(typeof bridge.invoke).toBe("function");
  });

  it("passes hub-desktop typecheck against the runtime contract exports", () => {
    ensureHubDesktopDependencies();
    execSync("npm run typecheck", { cwd: hubDesktopDir, stdio: "pipe" });
  }, 120_000);

  it("passes the hub-desktop production build", () => {
    ensureHubDesktopDependencies();
    execSync("npm run build", { cwd: hubDesktopDir, stdio: "pipe" });
  }, 240_000);
});
