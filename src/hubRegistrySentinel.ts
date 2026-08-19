import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveDefaultArchloopUserDataDir } from "./hubTestIsolation.js";

export interface HubRegistrySentinelSnapshot {
  readonly hubDir: string;
  readonly registryHash: string | null;
  readonly selectionHash: string | null;
  readonly projectDirNames: readonly string[];
}

const hashFile = (path: string): string | null => {
  if (!existsSync(path)) {
    return null;
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
};

const listProjectDirNames = (projectsDir: string): readonly string[] => {
  if (!existsSync(projectsDir)) {
    return [];
  }
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
};

export const resolveRealHubDir = (homeDir: string = homedir()): string =>
  join(resolveDefaultArchloopUserDataDir(homeDir), "hub");

export const snapshotHubRegistry = (
  hubDir: string,
): HubRegistrySentinelSnapshot => ({
  hubDir,
  registryHash: hashFile(join(hubDir, "project-registry.json")),
  selectionHash: hashFile(join(hubDir, "selected-project.json")),
  projectDirNames: listProjectDirNames(join(hubDir, "projects")),
});

export const snapshotRealHubRegistry = (
  homeDir: string = homedir(),
): HubRegistrySentinelSnapshot =>
  snapshotHubRegistry(resolveRealHubDir(homeDir));

export const describeHubRegistrySentinelMismatch = (
  before: HubRegistrySentinelSnapshot,
  after: HubRegistrySentinelSnapshot,
): string[] => {
  const lines: string[] = [];
  if (before.registryHash !== after.registryHash) {
    lines.push("project-registry.json changed");
  }
  if (before.selectionHash !== after.selectionHash) {
    lines.push("selected-project.json changed");
  }
  const beforeDirs = new Set(before.projectDirNames);
  const afterDirs = new Set(after.projectDirNames);
  for (const name of after.projectDirNames) {
    if (!beforeDirs.has(name)) {
      lines.push(`project directory added: ${name}`);
    }
  }
  for (const name of before.projectDirNames) {
    if (!afterDirs.has(name)) {
      lines.push(`project directory removed: ${name}`);
    }
  }
  return lines;
};

export const assertHubRegistryUnchanged = (
  before: HubRegistrySentinelSnapshot,
): void => {
  const after = snapshotHubRegistry(before.hubDir);
  const mismatches = describeHubRegistrySentinelMismatch(before, after);
  if (mismatches.length === 0) {
    return;
  }
  throw new Error(
    `Real Hub registry sentinel failed; tests must not mutate ${before.hubDir}.\n` +
      mismatches.map((line) => `- ${line}`).join("\n"),
  );
};
