import { describe, expect, it } from "vitest";

import {
  enrichHubBatchPlannerCandidate,
  enrichHubBatchPlannerCandidates,
  type HubBatchPlannerCandidate,
  serializeHubBatchPlannerCandidates,
} from "./hubBatchPlannerCandidates.js";
import type { HubTaskProjection } from "./taskBoard.js";

const readyTask = (
  id: string,
  overrides: Partial<HubTaskProjection> = {},
): HubTaskProjection =>
  ({
    id,
    title: `Task ${id}`,
    hubStatus: "ready_for_agent",
    claimState: "none",
    labels: ["ready-for-agent"],
    metadata: {},
    remoteRefs: [],
    ...overrides,
  }) as HubTaskProjection;

const createTempHubTaskStoreRepo = async (input: {
  readonly depListRecords: readonly unknown[];
  readonly listRecords: readonly unknown[];
}): Promise<{ repoDir: string; env: NodeJS.ProcessEnv }> => {
  const { mkdtemp, writeFile, mkdir, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  const repoDir = await mkdtemp(
    join(tmpdir(), "hub-batch-planner-candidates-"),
  );
  await execAsync("git init -b main", { cwd: repoDir });
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "dep" && args[1] === "list" && args.includes("--json")) {
  process.stdout.write(JSON.stringify(${JSON.stringify(input.depListRecords)}));
  process.exit(0);
}
if (args[0] === "list" && args.includes("--json")) {
  process.stdout.write(JSON.stringify(${JSON.stringify(input.listRecords)}));
  process.exit(0);
}
process.exit(1);
`,
  );
  await chmod(bdPath, 0o755);
  await mkdir(join(repoDir, ".beads"), { recursive: true });
  await writeFile(
    join(repoDir, ".beads", "metadata.json"),
    JSON.stringify({ backend: "dolt" }),
  );

  return {
    repoDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCHLOOP_BD_PATH: bdPath,
    },
  };
};

describe("hubBatchPlannerCandidates", () => {
  it("parses github refs, issue urls, and beads ids from blocked-by prose", () => {
    const candidate = enrichHubBatchPlannerCandidate(
      readyTask("bd-child", {
        description: `## Blocked by - #152
- https://github.com/example/repo/issues/153
- bd-open
- bd-missing`,
      }),
    );

    expect(candidate.blockersDeclared).toEqual([
      "github#152",
      "github#153",
      "bd-open",
      "bd-missing",
    ]);
    expect(candidate.blockersResolved).toEqual([]);
    expect(candidate.openBlockers).toEqual([]);
    expect(candidate.unknownBlockers).toEqual([
      "github#152",
      "github#153",
      "bd-open",
      "bd-missing",
    ]);
    expect(candidate.blockerSource).toBe("description");
  });

  it("prefers structured beads dependency blockers over description parsing", () => {
    const candidate = enrichHubBatchPlannerCandidate(
      readyTask("bd-child", {
        description: "## Blocked by\n\n- bd-other",
        metadata: { blockers: ["bd-parent"] },
      }),
      { beadsDependencyBlockers: ["bd-parent"] },
    );

    expect(candidate.explicitBlockers).toEqual(["bd-parent"]);
    expect(candidate.blockersDeclared).toEqual(["bd-parent"]);
    expect(candidate.blockerSource).toBe("beads_dependency");
  });

  it("falls back to Blocked by parsing when structured dependency edges are unavailable", () => {
    const candidate = enrichHubBatchPlannerCandidate(
      readyTask("bd-child", {
        description: "## Blocked by\n\n- bd-parent\n- bd-second",
      }),
    );

    expect(candidate.explicitBlockers).toEqual([]);
    expect(candidate.blockersDeclared).toEqual(["bd-parent", "bd-second"]);
    expect(candidate.blockerSource).toBe("description");
  });

  it("loads beads dependency blockers for ready queue candidates", async () => {
    const { repoDir, env } = await createTempHubTaskStoreRepo({
      depListRecords: [
        { issue_id: "bd-child", depends_on_id: "bd-parent", type: "blocks" },
      ],
      listRecords: [
        {
          id: "bd-child",
          title: "Task bd-child",
          hub_status: "ready_for_agent",
        },
      ],
    });

    const enriched = enrichHubBatchPlannerCandidates({
      cwd: repoDir,
      candidates: [readyTask("bd-child")],
      env,
    });

    expect(enriched[0]?.explicitBlockers).toEqual(["bd-parent"]);
    expect(enriched[0]?.blockerSource).toBe("beads_dependency");
    expect(enriched[0]?.unknownBlockers).toEqual(["bd-parent"]);
  });

  it("resolves open, closed, and unknown blockers from live hub state", async () => {
    const { repoDir, env } = await createTempHubTaskStoreRepo({
      depListRecords: [],
      listRecords: [
        {
          id: "bd-github-open",
          title: "Open github blocker",
          hub_status: "implementing",
          remoteRefs: [{ url: "github#152" }],
        },
        {
          id: "bd-github-closed",
          title: "Closed github blocker",
          hub_status: "done",
          remoteRefs: [{ url: "github#153" }],
        },
        {
          id: "bd-open",
          title: "Open beads blocker",
          hub_status: "reviewing",
        },
      ],
    });

    const [candidate] = enrichHubBatchPlannerCandidates({
      cwd: repoDir,
      candidates: [
        readyTask("bd-child", {
          description: `## Blocked by - #152
- https://github.com/example/repo/issues/153
- bd-open
- bd-missing`,
        }),
      ],
      env,
    });

    expect(candidate?.blockersDeclared).toEqual([
      "github#152",
      "github#153",
      "bd-open",
      "bd-missing",
    ]);
    expect(
      candidate?.blockersResolved.map(({ ref, taskId, title, hubStatus }) => ({
        ref,
        taskId,
        title,
        hubStatus,
      })),
    ).toEqual([
      {
        ref: "github#152",
        taskId: "bd-github-open",
        title: "Open github blocker",
        hubStatus: "implementing",
      },
      {
        ref: "github#153",
        taskId: "bd-github-closed",
        title: "Closed github blocker",
        hubStatus: "done",
      },
      {
        ref: "bd-open",
        taskId: "bd-open",
        title: "Open beads blocker",
        hubStatus: "reviewing",
      },
    ]);
    expect(candidate?.openBlockers).toEqual(["github#152", "bd-open"]);
    expect(candidate?.unknownBlockers).toEqual(["bd-missing"]);
  });

  it("treats stale Blocked by #152 prose as unblocked when #152 is done", async () => {
    const { repoDir, env } = await createTempHubTaskStoreRepo({
      depListRecords: [],
      listRecords: [
        {
          id: "bd-github-152",
          title: "Closed github blocker",
          hub_status: "done",
          remoteRefs: [{ url: "github#152" }],
        },
      ],
    });

    const [candidate] = enrichHubBatchPlannerCandidates({
      cwd: repoDir,
      candidates: [
        readyTask("bd-child", {
          description: `## Blocked by

- #152`,
        }),
      ],
      env,
    });

    expect(candidate?.blockersDeclared).toEqual(["github#152"]);
    expect(candidate?.blockersResolved).toHaveLength(1);
    expect(candidate?.openBlockers).toEqual([]);
    expect(candidate?.unknownBlockers).toEqual([]);
  });

  it("strips stale blocker prose from the planner payload", () => {
    const candidate: HubBatchPlannerCandidate = {
      id: "bd-child",
      title: "Task bd-child",
      description: `## Blocked by

- #152
- bd-closed`,
      labels: [],
      hubStatus: "ready_for_agent",
      claimState: "none",
      metadata: {},
      remoteRefs: [],
      explicitBlockers: [],
      blockersDeclared: ["github#152", "bd-closed"],
      blockersResolved: [],
      openBlockers: [],
      unknownBlockers: [],
      blockerSource: "description",
    };
    const payload = serializeHubBatchPlannerCandidates([candidate]);

    expect(payload).not.toContain("Blocked by");
    expect(payload).not.toContain("blockersDeclared");
    expect(payload).not.toContain("description");

    const parsed = JSON.parse(payload) as Array<{
      openBlockers: string[];
      unknownBlockers: string[];
      explicitBlockers: string[];
    }>;
    expect(parsed[0]).toMatchObject({
      explicitBlockers: [],
      openBlockers: [],
      unknownBlockers: [],
    });
  });
});
