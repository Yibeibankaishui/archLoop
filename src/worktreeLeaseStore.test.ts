import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  branchToWorktreeName,
  listWorktreeLeases,
  parseWorktreeLeaseFile,
  resolveWorktreeLeaseLockPath,
} from "./worktreeLeaseStore.js";

describe("worktreeLeaseStore", () => {
  it("maps branch names to worktree lock names", () => {
    expect(branchToWorktreeName("archloop/bd-1-task")).toBe(
      "archloop-bd-1-task",
    );
  });

  it("parses active and stale lease metadata", () => {
    const active = parseWorktreeLeaseFile(
      "archloop-bd-1-task.lock",
      JSON.stringify({
        pid: process.pid,
        branch: "archloop/bd-1-task",
        acquiredAt: "2026-06-22T10:00:00.000Z",
        owner: {
          kind: "hub",
          taskId: "bd-1",
          flowId: "no-review",
          batchId: "batch-1",
          runId: "run-1",
        },
      }),
      () => true,
    );
    expect(active.state).toBe("active");
    expect(active.owner).toEqual(
      expect.objectContaining({
        kind: "hub",
        taskId: "bd-1",
      }),
    );

    const stale = parseWorktreeLeaseFile(
      "archloop-bd-1-task.lock",
      JSON.stringify({
        pid: 999999,
        branch: "archloop/bd-1-task",
        acquiredAt: "2026-06-22T10:00:00.000Z",
      }),
      () => false,
    );
    expect(stale.state).toBe("stale");
  });

  it("lists lease files from the config directory", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "worktree-lease-"));
    const locksDir = join(repoDir, ".archloop", "locks");
    mkdirSync(locksDir, { recursive: true });
    const lockPath = resolveWorktreeLeaseLockPath(
      repoDir,
      branchToWorktreeName("archloop/bd-1-task"),
    );
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        branch: "archloop/bd-1-task",
        acquiredAt: "2026-06-22T10:00:00.000Z",
        owner: { kind: "hub", taskId: "bd-1" },
      }),
    );

    const leases = listWorktreeLeases(repoDir, () => true);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toEqual(
      expect.objectContaining({
        branch: "archloop/bd-1-task",
        state: "active",
      }),
    );
  });
});
