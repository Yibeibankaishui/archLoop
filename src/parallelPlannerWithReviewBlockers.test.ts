import { describe, expect, it, vi } from "vitest";
import {
  enrichReadyIssuesWithBlockers,
  parseDeclaredBlockers,
  parseGithubBlockerNumbers,
  sectionDeclaresNoBlockers,
} from "./templates/parallel-planner-with-review/blockerResolution.js";

describe("parallel-planner-with-review blockerResolution", () => {
  it("parses github blocker refs from a Blocked by section", () => {
    const body = `## Problem

Needs auth from #44.

## Blocked by

- https://github.com/example/repo/issues/44
- #46
`;

    expect(parseDeclaredBlockers(body, "github")).toEqual([44, 46]);
  });

  it("treats explicit none markers as zero declared blockers", () => {
    expect(parseGithubBlockerNumbers("None - can start immediately")).toEqual(
      [],
    );
    expect(sectionDeclaresNoBlockers("none")).toBe(true);
    expect(parseDeclaredBlockers("## Blocked by\n\nNone", "github")).toEqual(
      [],
    );
  });

  it("treats a ready issue with closed blockers as unblocked", async () => {
    const resolveBlocker = vi.fn(async (ref: number | string) => ({
      ref,
      state: "CLOSED",
      title: `Issue ${ref}`,
    }));

    const enriched = await enrichReadyIssuesWithBlockers(
      [
        {
          number: 47,
          title: "Interactive scenario register",
          body: "## Blocked by\n\nBlocked by: #44, #46",
        },
      ],
      { mode: "github", resolveBlocker },
    );

    expect(enriched[0]).toMatchObject({
      number: 47,
      blockersDeclared: [44, 46],
      openBlockers: [],
    });
    expect(resolveBlocker).toHaveBeenCalledTimes(2);
  });

  it("keeps a ready issue blocked when a declared blocker is still open", async () => {
    const resolveBlocker = vi.fn(async (ref: number | string) => ({
      ref,
      state: ref === 50 ? "OPEN" : "CLOSED",
      title: `Issue ${ref}`,
    }));

    const enriched = await enrichReadyIssuesWithBlockers(
      [
        {
          number: 51,
          title: "Resource usage metrics",
          body: "## Blocked by\n\n#50",
        },
      ],
      { mode: "github", resolveBlocker },
    );

    expect(enriched[0]).toMatchObject({
      number: 51,
      blockersDeclared: [50],
      openBlockers: [50],
    });
  });

  it("warns when declared blockers are all closed", async () => {
    const warnings: string[] = [];
    await enrichReadyIssuesWithBlockers(
      [
        {
          number: 47,
          title: "Stale body",
          body: "## Blocked by\n\n#44",
        },
      ],
      {
        mode: "github",
        resolveBlocker: async (ref) => ({
          ref,
          state: "CLOSED",
          title: "Closed blocker",
        }),
        warn: (message) => warnings.push(message),
      },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("issue body may be stale");
  });
});
