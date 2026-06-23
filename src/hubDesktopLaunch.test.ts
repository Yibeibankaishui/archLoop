import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HUB_RUNTIME_BRIDGE_CHANNELS } from "./hubRuntimeBridge.js";
import { createHubRuntimeBridgeService } from "./hubRuntimeBridgeService.js";

const hubDesktopDir = join(process.cwd(), "hub-desktop");

describe("hub desktop launch", () => {
  it("defines an independent hub-desktop package entrypoint and bridge channel", () => {
    const packageJson = JSON.parse(
      readFileSync(join(hubDesktopDir, "package.json"), "utf8"),
    ) as {
      main: string;
      scripts: Record<string, string>;
    };

    expect(packageJson.main).toBe("dist-electron/main.js");
    expect(packageJson.scripts.dev).toContain("electron");
    expect(packageJson.scripts.build).toContain("vite build");
    expect(HUB_RUNTIME_BRIDGE_CHANNELS.invoke).toBe("hub-runtime:invoke");
  });

  it("ships a committed lockfile and patched Electron for reproducible critical-clean installs", () => {
    const lockfilePath = join(hubDesktopDir, "package-lock.json");
    expect(existsSync(lockfilePath)).toBe(true);

    const packageJson = JSON.parse(
      readFileSync(join(hubDesktopDir, "package.json"), "utf8"),
    ) as {
      devDependencies: { electron: string };
      scripts: Record<string, string>;
    };
    const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8")) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string; dev?: boolean }>;
    };

    expect(packageJson.scripts["install:ci"]).toBe("npm ci");
    expect(packageJson.scripts["audit:critical"]).toBe(
      "npm audit --audit-level=critical",
    );
    expect(packageJson.devDependencies.electron).toMatch(/^(\^|~)?4[1-9]\./);
    expect(lockfile.lockfileVersion).toBeGreaterThanOrEqual(3);
    expect(lockfile.packages["node_modules/electron"]?.version).toMatch(
      /^4[1-9]\./,
    );
    expect(lockfile.packages["node_modules/vitest"]).toBeUndefined();
  });

  it("can initialize the runtime bridge service used by the desktop main process", () => {
    const bridge = createHubRuntimeBridgeService({ useFixtures: true });
    expect(typeof bridge.invoke).toBe("function");
  });
});
