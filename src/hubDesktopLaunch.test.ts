import { readFileSync } from "node:fs";
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
});
