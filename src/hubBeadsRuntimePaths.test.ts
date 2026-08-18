import { describe, expect, it } from "vitest";

import {
  HUB_BEADS_RUNTIME_EXPORT_DIRECTORIES,
  HUB_BEADS_RUNTIME_EXPORT_FILES,
  isAllowlistedBeadsRuntimePath,
} from "./hubBeadsRuntimePaths.js";

describe("Beads runtime/export allowlist", () => {
  it("matches only documented runtime/export files and directories", () => {
    for (const path of HUB_BEADS_RUNTIME_EXPORT_FILES) {
      expect(isAllowlistedBeadsRuntimePath(path)).toBe(true);
    }
    expect(
      isAllowlistedBeadsRuntimePath(".beads/embeddeddolt/data.db"),
    ).toBe(true);
    expect(isAllowlistedBeadsRuntimePath(".beads/dolt")).toBe(true);
    expect(
      isAllowlistedBeadsRuntimePath(".beads/backup/issues.jsonl"),
    ).toBe(true);
  });

  it("never treats Beads config, docs, hooks, redirect, or unknown paths as disposable", () => {
    expect(isAllowlistedBeadsRuntimePath(".beads")).toBe(false);
    expect(isAllowlistedBeadsRuntimePath(".beads/config.yaml")).toBe(false);
    expect(isAllowlistedBeadsRuntimePath(".beads/metadata.json")).toBe(false);
    expect(isAllowlistedBeadsRuntimePath(".beads/README.md")).toBe(false);
    expect(isAllowlistedBeadsRuntimePath(".beads/.gitignore")).toBe(false);
    expect(isAllowlistedBeadsRuntimePath(".beads/hooks/pre-commit")).toBe(false);
    expect(isAllowlistedBeadsRuntimePath(".beads/redirect")).toBe(false);
    expect(isAllowlistedBeadsRuntimePath(".beads/mystery.jsonl")).toBe(false);
    expect(HUB_BEADS_RUNTIME_EXPORT_DIRECTORIES).not.toContain(".beads");
  });
});
