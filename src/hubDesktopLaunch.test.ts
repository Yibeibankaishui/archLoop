import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HUB_RUNTIME_BRIDGE_CHANNELS } from "./hubRuntimeBridge.js";
import { createHubRuntimeBridgeService } from "./hubRuntimeBridgeService.js";

describe("hub desktop launch", () => {
  it("defines an independent hub-desktop package entrypoint and bridge channel", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "hub-desktop/package.json"), "utf8"),
    ) as {
      main: string;
      scripts: Record<string, string>;
    };

    expect(packageJson.main).toBe("dist-electron/main.js");
    expect(packageJson.scripts.dev).toContain("electron");
    expect(packageJson.scripts.build).toContain("vite build");
    expect(HUB_RUNTIME_BRIDGE_CHANNELS.invoke).toBe("hub-runtime:invoke");
  });

  it("can initialize the runtime bridge service used by the desktop main process", () => {
    const bridge = createHubRuntimeBridgeService({ useFixtures: true });
    expect(typeof bridge.invoke).toBe("function");
  });

  it("passes hub-desktop typecheck against the runtime contract exports", () => {
    const hubDesktopDir = join(process.cwd(), "hub-desktop");
    const hubDesktopTypeScript = join(
      hubDesktopDir,
      "node_modules",
      "typescript",
    );
    if (!existsSync(hubDesktopTypeScript)) {
      execSync("npm install", { cwd: hubDesktopDir, stdio: "pipe" });
    }

    execSync("npm run typecheck", { cwd: hubDesktopDir, stdio: "pipe" });
  }, 120_000);

  it("passes the hub-desktop production build", () => {
    const hubDesktopDir = join(process.cwd(), "hub-desktop");
    const hubDesktopTypeScript = join(
      hubDesktopDir,
      "node_modules",
      "typescript",
    );
    if (!existsSync(hubDesktopTypeScript)) {
      execSync("npm install", { cwd: hubDesktopDir, stdio: "pipe" });
    }

    execSync("npm run build", { cwd: hubDesktopDir, stdio: "pipe" });
  }, 240_000);
});
