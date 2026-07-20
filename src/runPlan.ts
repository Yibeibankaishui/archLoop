import type {
  SectionBlock,
  SectionFooterBlock,
  SectionHeaderBlock,
  SectionKvBlock,
} from "./section.js";

/** Debounce before an interactive Hub run starts after the plan section is shown. */
export const RUN_START_DEBOUNCE_MS = 3_000;

export interface RunPlanModel {
  readonly header: SectionHeaderBlock;
  readonly plan: SectionKvBlock;
  readonly footer: SectionFooterBlock;
}

export interface BuildRunPlanModelInput {
  readonly flowId: string;
  readonly repoRoot: string;
  readonly projectName?: string;
  readonly readyCount: number;
  readonly flowHint?: string;
  readonly flowInputSummary?: string;
  readonly legacyProjectTarget?: string;
}

type RunPlanKvRow = SectionKvBlock["rows"][number];

const RUN_PLAN_KV_GUTTER = 10;

const DEBOUNCE_TIP = "starting in 3s · Ctrl+C to cancel · e to edit flow";

const formatReadyCount = (count: number): string =>
  `${count} ${count === 1 ? "task" : "tasks"}`;

export const buildRunPlanModel = (
  input: BuildRunPlanModelInput,
): RunPlanModel => {
  const rows: RunPlanKvRow[] = [
    {
      key: "flow",
      value: input.flowId,
      ...(input.flowHint ? { secondary: input.flowHint } : {}),
    },
    input.projectName
      ? {
          key: "project",
          value: input.projectName,
          secondary: `← ${input.repoRoot}`,
        }
      : { key: "project", value: input.repoRoot },
  ];

  if (input.legacyProjectTarget) {
    rows.push({ key: "legacy", value: input.legacyProjectTarget });
  }

  rows.push({ key: "ready", value: formatReadyCount(input.readyCount) });

  if (input.flowInputSummary) {
    rows.push({ key: "input", value: input.flowInputSummary });
  }

  return {
    header: { kind: "header", title: "archLoop", subtitle: "run" },
    plan: { kind: "kv", gutter: RUN_PLAN_KV_GUTTER, rows },
    footer: { kind: "footer", label: "tip", commands: [DEBOUNCE_TIP] },
  };
};

export const runPlanModelToBlocks = (
  model: RunPlanModel,
): readonly SectionBlock[] => [model.header, model.plan, model.footer];
