import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveDefaultArchloopUserDataDir } from "./hubTestIsolation.js";

export interface HubRegistrySentinelSnapshot {
  readonly hubDir: string;
  readonly registryHash: string | null;
  readonly selectionHash: string | null;
  readonly projectDirNames: readonly string[];
  readonly projectTreeHash: string | null;
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

const hashDirectoryTree = (root: string): string | null => {
  if (!existsSync(root)) {
    return null;
  }
  const hash = createHash("sha256");
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      hash.update(`l\0${relativePath}\0${readlinkSync(path)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`d\0${relativePath}\0`);
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relativePath ? join(relativePath, name) : name);
      }
      return;
    }
    if (stat.isFile()) {
      hash.update(`f\0${relativePath}\0${stat.size}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
      return;
    }
    hash.update(`o\0${relativePath}\0${stat.mode}\0${stat.size}\0`);
  };
  visit(root, "");
  return hash.digest("hex");
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
  projectTreeHash: hashDirectoryTree(join(hubDir, "projects")),
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
  if (
    before.projectTreeHash !== after.projectTreeHash &&
    lines.every((line) => !line.startsWith("project directory "))
  ) {
    lines.push("project directory contents changed");
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
