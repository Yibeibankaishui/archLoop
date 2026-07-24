import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { HubTaskEvent } from "./hubExecution.js";

/**
 * Shared reader for the Hub run event log.
 *
 * This is the single event-log reader both `tasks doctor` and the recovery
 * wiring (`recoverStaleExecutionStatus`) call, so the two surfaces read the
 * exact same events. It does only the mechanical work — listing run dirs,
 * parsing the append-only `events/task.jsonl` lines, and validating that a
 * record carries a `type` and `taskId`. Selecting which of those events each
 * surface cares about (merge-ready for the doctor, phase-completion for the
 * recovery router) is the caller's job, via pure selection helpers, so this
 * module stays free of any routing or diagnostic policy.
 *
 * Extracted from `hubTaskStateDoctor.ts` (where it lived as the doctor's
 * private reader) so the recovery wiring can reuse it instead of re-implement
 * the run-dir traversal — the PRD requires no duplicated event-reading code.
 */
const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readJsonl = (path: string): unknown[] => {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
};

const listRunDirs = (hubProjectDir: string): readonly string[] => {
  const runsDir = join(hubProjectDir, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }

  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsDir, entry.name))
    .sort();
};

export const readTaskEvents = (
  hubProjectDir: string,
): readonly HubTaskEvent[] =>
  listRunDirs(hubProjectDir).flatMap((runDir) =>
    readJsonl(join(runDir, "events", "task.jsonl")).flatMap((event) => {
      const record = readObject(event);
      return typeof record.type === "string" &&
        typeof record.taskId === "string"
        ? [record as unknown as HubTaskEvent]
        : [];
    }),
  );
