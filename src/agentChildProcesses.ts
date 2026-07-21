import { readFileSync, readdirSync } from "node:fs";

/**
 * List direct child PIDs of parentPid.
 *
 * Prefers Linux /proc/pid/task/pid/children, then falls back to scanning
 * /proc entries' stat files for matching ppid. Returns an empty list when the
 * process is gone or the platform cannot enumerate children.
 */
export const listDirectChildPids = (parentPid: number): number[] => {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return [];
  }

  try {
    const childrenPath = `/proc/${parentPid}/task/${parentPid}/children`;
    const content = readFileSync(childrenPath, "utf8").trim();
    if (content.length === 0) {
      return [];
    }
    return content
      .split(/\s+/)
      .map((token) => Number.parseInt(token, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // Fall through to /proc scan.
  }

  try {
    const children: number[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(")");
        if (closeParen < 0) {
          continue;
        }
        const fields = stat.slice(closeParen + 2).split(" ");
        const ppid = Number.parseInt(fields[1] ?? "", 10);
        if (ppid === parentPid) {
          children.push(Number.parseInt(entry, 10));
        }
      } catch {
        // Process exited mid-scan.
      }
    }
    return children;
  } catch {
    return [];
  }
};

/**
 * True when the agent process tree under rootPid has an active child of the
 * agent itself (a grandchild of the sandbox exec root).
 *
 * Hub no-sandbox execs spawn `sh -c <agent>`, so an idle agent is
 * sh -> agent (no further children). A long-running shell tool is
 * sh -> agent -> bash/npm/.... Counting only agent-spawned children avoids
 * treating the agent process itself as "activity" that would disable idle
 * detection forever.
 */
export const hasActiveAgentChildProcesses = (rootPid: number): boolean => {
  for (const child of listDirectChildPids(rootPid)) {
    if (listDirectChildPids(child).length > 0) {
      return true;
    }
  }
  return false;
};
