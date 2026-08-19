import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertHubRegistryUnchanged,
  snapshotHubRegistry,
} from "./hubRegistrySentinel.js";

describe("Hub registry sentinel", () => {
  it("passes when registry files and project dirs are unchanged", async () => {
    const hubDir = await mkdtemp(join(tmpdir(), "hub-sentinel-"));
    mkdirSync(join(hubDir, "projects"), { recursive: true });
    writeFileSync(
      join(hubDir, "project-registry.json"),
      '{"version":1,"projects":[]}\n',
    );
    const snapshot = snapshotHubRegistry(hubDir);
    expect(() => assertHubRegistryUnchanged(snapshot)).not.toThrow();
  });

  it("fails when the registry file changes", async () => {
    const hubDir = await mkdtemp(join(tmpdir(), "hub-sentinel-"));
    mkdirSync(join(hubDir, "projects"), { recursive: true });
    const registryPath = join(hubDir, "project-registry.json");
    writeFileSync(registryPath, '{"version":1,"projects":[]}\n');
    const snapshot = snapshotHubRegistry(hubDir);
    writeFileSync(registryPath, '{"version":1,"projects":[{"id":"x"}]}\n');
    expect(() => assertHubRegistryUnchanged(snapshot)).toThrow(
      /project-registry\.json changed/,
    );
  });
});
