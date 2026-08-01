import { describe, expect, it } from "vitest";

import {
  RUN_START_DEBOUNCE_MS,
  buildRunPlanModel,
  runPlanModelToBlocks,
} from "./runPlan.js";

describe("RUN_START_DEBOUNCE_MS", () => {
  it("exports a 3-second debounce constant", () => {
    expect(RUN_START_DEBOUNCE_MS).toBe(3000);
  });
});

describe("buildRunPlanModel", () => {
  it("builds flow / project / ready kv rows with a debounce tip footer", () => {
    const model = buildRunPlanModel({
      flowId: "with-review",
      projectName: "autotuneagent",
      repoRoot: "/home/bai/code/AutoTuneAgent",
      readyCount: 1,
    });

    expect(model.header).toEqual({
      kind: "header",
      title: "archLoop",
      subtitle: "run",
    });
    expect(model.plan).toEqual({
      kind: "kv",
      gutter: 10,
      rows: [
        {
          key: "flow",
          value: "with-review",
        },
        {
          key: "project",
          value: "autotuneagent",
          secondary: "← /home/bai/code/AutoTuneAgent",
        },
        {
          key: "ready",
          value: "1 task",
        },
      ],
    });
    expect(model.footer).toEqual({
      kind: "footer",
      label: "tip",
      commands: ["starting in 3s · Ctrl+C to cancel · e to edit flow"],
    });
  });

  it("pluralizes ready tasks and includes optional flow hint / flow input", () => {
    const model = buildRunPlanModel({
      flowId: "prd-decomposition",
      projectName: "beta",
      repoRoot: "/tmp/beta",
      readyCount: 0,
      flowHint: "last used",
      flowInputSummary: "docs/prd/example.md",
    });

    expect(model.plan.rows).toEqual([
      {
        key: "flow",
        value: "prd-decomposition",
        secondary: "last used",
      },
      {
        key: "project",
        value: "beta",
        secondary: "← /tmp/beta",
      },
      {
        key: "ready",
        value: "0 tasks",
      },
      {
        key: "input",
        value: "docs/prd/example.md",
      },
    ]);
  });

  it("omits project name when only a repo root is available", () => {
    const model = buildRunPlanModel({
      flowId: "no-review",
      repoRoot: "/tmp/repo",
      readyCount: 2,
    });

    expect(model.plan.rows.find((row) => row.key === "project")).toEqual({
      key: "project",
      value: "/tmp/repo",
    });
  });

  it("flattens to header + plan + footer blocks", () => {
    const model = buildRunPlanModel({
      flowId: "spike",
      projectName: "demo",
      repoRoot: "/tmp/demo",
      readyCount: 3,
    });
    const blocks = runPlanModelToBlocks(model);
    expect(blocks).toEqual([model.header, model.plan, model.footer]);
  });
});
