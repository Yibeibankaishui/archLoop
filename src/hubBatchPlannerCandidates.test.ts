import { describe, expect, it } from "vitest";

import {
  enrichHubBatchPlannerCandidate,
  enrichHubBatchPlannerCandidates,
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

describe("hubBatchPlannerCandidates", () => {
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
    const { mkdtemp, writeFile, mkdir, chmod } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    const repoDir = await mkdtemp(join(tmpdir(), "hub-batch-planner-candidates-"));
    await execAsync("git init -b main", { cwd: repoDir });
    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "dep" && args[1] === "list" && args.includes("--json")) {
  process.stdout.write(JSON.stringify([
    { issue_id: "bd-child", depends_on_id: "bd-parent", type: "blocks" },
  ]));
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

    const enriched = enrichHubBatchPlannerCandidates({
      cwd: repoDir,
      candidates: [readyTask("bd-child")],
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: bdPath,
      },
    });

    expect(enriched[0]?.explicitBlockers).toEqual(["bd-parent"]);
    expect(enriched[0]?.blockerSource).toBe("beads_dependency");
  });
});
