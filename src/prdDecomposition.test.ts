import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  draftPrdSlices,
  formatPrdDraftPlan,
  parseDependencySpec,
  publishPrdDraftPlan,
  resolvePrdPath,
} from "./prdDecomposition.js";

const samplePrd = `# PRD: Sample Hub Feature

## Deliverables

- Horizontal database layer only
- Horizontal API layer only

### Tasks

- [ ] Implement sandcastle tasks from-prd command with Beads output
- [ ] Confirm dependency graph with the user before creating tasks
- [ ] Add tests for PRD slice creation with dependency output
`;

describe("prdDecomposition", () => {
  it("drafts vertical slices from Tasks checkboxes instead of horizontal Deliverables", () => {
    const plan = draftPrdSlices(samplePrd, "docs/prd/sample.md");

    expect(plan.prdTitle).toBe("Sample Hub Feature");
    expect(plan.slices).toHaveLength(3);
    expect(plan.slices.map((slice) => slice.title)).toEqual([
      "Implement sandcastle tasks from-prd command with Beads output",
      "Confirm dependency graph with the user before creating tasks",
      "Add tests for PRD slice creation with dependency output",
    ]);
    expect(plan.slices[0]?.sliceType).toBe("AFK");
    expect(plan.slices[1]?.sliceType).toBe("HITL");
    expect(plan.slices[2]?.sliceType).toBe("AFK");
  });

  it("parses dependency specs by slice index", () => {
    expect(parseDependencySpec("2:1, 3:1", 3)).toEqual([
      { dependentIndex: 1, blockerIndex: 0 },
      { dependentIndex: 2, blockerIndex: 0 },
    ]);
  });

  it("formats a draft plan with slice types and dependency hints", () => {
    const plan = draftPrdSlices(samplePrd, "docs/prd/sample.md");
    const lines = formatPrdDraftPlan(plan, [
      { dependentIndex: 2, blockerIndex: 0 },
    ]);

    expect(lines.join("\n")).toContain("slice-1");
    expect(lines.join("\n")).toContain("AFK");
    expect(lines.join("\n")).toContain("HITL");
    expect(lines.join("\n")).toContain("slice-3 depends on slice-1");
  });

  it("resolves local PRD paths relative to the repo root", () => {
    expect(resolvePrdPath("/repo", "docs/prd/sample.md")).toBe(
      "/repo/docs/prd/sample.md",
    );
    expect(resolvePrdPath("/repo", "./docs/prd/sample.md")).toBe(
      "/repo/docs/prd/sample.md",
    );
  });

  it("creates Beads tasks and dependency edges from an approved PRD draft", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "prd-decomposition-"));
    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });

    const createArgsFile = join(hostDir, "create-args.txt");
    const depArgsFile = join(hostDir, "dep-args.txt");
    const createCountFile = join(hostDir, "create-count.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "create" ]; then
  n=0
  if [ -f "${createCountFile}" ]; then
    n=$(cat "${createCountFile}")
  fi
  n=$((n + 1))
  printf '%s' "$n" > "${createCountFile}"
  printf '%s\\n' "$@" >> "${createArgsFile}"
  printf '[{"id":"bd-%s","title":"%s"}]\\n' "$n" "$2"
  exit 0
fi
if [ "$1" = "dep" ] && [ "$2" = "add" ]; then
  printf '%s\\n' "$@" >> "${depArgsFile}"
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const plan = draftPrdSlices(samplePrd, "docs/prd/sample.md");
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;

    try {
      const result = publishPrdDraftPlan({
        cwd: hostDir,
        plan,
        hubStatus: "inbox",
        dependencies: parseDependencySpec("2:1,3:2", plan.slices.length),
      });

      expect(result.tasks).toHaveLength(3);
      expect(result.tasks.map((task) => task.id)).toEqual([
        "bd-1",
        "bd-2",
        "bd-3",
      ]);
      expect(result.dependencies).toEqual([
        { dependentId: "bd-2", blockerId: "bd-1" },
        { dependentId: "bd-3", blockerId: "bd-2" },
      ]);
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
