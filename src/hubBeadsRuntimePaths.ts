/**
 * Exact allowlist of Beads runtime/export paths that Hub may strip from a
 * landing candidate. Candidate construction must not drop every path under
 * `.beads/`: configuration, documentation, hooks, `.beads/redirect`, and any
 * unknown path remain ordinary source changes.
 */
export const HUB_BEADS_RUNTIME_EXPORT_FILES = [
  ".beads/issues.jsonl",
  ".beads/interactions.jsonl",
  ".beads/events.jsonl",
  ".beads/export-state.json",
  ".beads/sync-state.json",
  ".beads/last-touched",
  ".beads/bd.sock",
  ".beads/bd.sock.startlock",
  ".beads/.exclusive-lock",
] as const;

export const HUB_BEADS_RUNTIME_EXPORT_DIRECTORIES = [
  ".beads/embeddeddolt",
  ".beads/dolt",
  ".beads/backup",
  ".beads/export-state",
] as const;

export const normalizeHubGitPath = (path: string): string =>
  path.replace(/\\/g, "/");

export const isAllowlistedBeadsRuntimePath = (path: string): boolean => {
  const normalized = normalizeHubGitPath(path);
  if (
    (HUB_BEADS_RUNTIME_EXPORT_FILES as readonly string[]).includes(normalized)
  ) {
    return true;
  }
  return HUB_BEADS_RUNTIME_EXPORT_DIRECTORIES.some(
    (directory) =>
      normalized === directory || normalized.startsWith(`${directory}/`),
  );
};
