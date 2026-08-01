import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  hasActiveAgentChildProcesses,
  listDirectChildPids,
} from "./agentChildProcesses.js";

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for process tree condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("listDirectChildPids", () => {
  it("returns an empty list for invalid PIDs", () => {
    expect(listDirectChildPids(0)).toEqual([]);
    expect(listDirectChildPids(-1)).toEqual([]);
  });
});

describe("hasActiveAgentChildProcesses", () => {
  it("returns false when the root process has only a leaf child (idle agent shape)", async () => {
    const proc = spawn("sh", ["-c", "sleep 5"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      expect(proc.pid).toBeDefined();
      await waitFor(() => listDirectChildPids(proc.pid!).length > 0);
      expect(hasActiveAgentChildProcesses(proc.pid!)).toBe(false);
    } finally {
      if (proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  }, 10_000);

  it("returns true when the agent process has spawned a child (tool-running shape)", async () => {
    // Mimic no-sandbox: sh → agent-like shell → sleep (tool child).
    const proc = spawn("sh", ["-c", "sh -c 'sleep 5'"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      expect(proc.pid).toBeDefined();
      await waitFor(() => hasActiveAgentChildProcesses(proc.pid!) === true);
      expect(hasActiveAgentChildProcesses(proc.pid!)).toBe(true);
    } finally {
      if (proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  }, 10_000);

  it("returns false for a non-existent PID", () => {
    expect(hasActiveAgentChildProcesses(2_147_483_646)).toBe(false);
  });
});
