import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HUB_TRIAGE_DEFAULT_TASK_QUERY } from "./hubTriage.js";

export type HubFlowKind = "task-board" | "proposal";

export type HubFlowInputKind = "prd-file" | "task-query";

export interface HubFlowInputSchema {
  readonly kind: HubFlowInputKind;
  readonly label: string;
  readonly required?: boolean;
  readonly defaultValue?: string;
}

export interface HubFlowDefinition {
  readonly id: string;
  readonly description: string;
  readonly kind: HubFlowKind;
  readonly hasReviewer?: boolean;
  readonly prompts?: Readonly<Record<string, string>>;
  readonly input?: HubFlowInputSchema;
}

export const HUB_FLOW_DEFINITIONS: readonly HubFlowDefinition[] = [
  {
    id: "no-review",
    description:
      "Claim ready tasks, run implementers with Hub-owned prompts, and advance successful work to waiting for merge",
    kind: "task-board",
    hasReviewer: false,
    prompts: {
      implement: "implement-prompt.md",
    },
  },
  {
    id: "with-review",
    description:
      "Claim ready tasks, run implementers and reviewers with Hub-owned prompts, and advance successful work to waiting for merge",
    kind: "task-board",
    hasReviewer: true,
    prompts: {
      implement: "implement-prompt.md",
      review: "review-prompt.md",
    },
  },
  {
    id: "prd-decomposition",
    description:
      "Read a PRD, propose vertical slices with AFK/HITL classification, and create Beads tasks after approval",
    kind: "proposal",
    input: {
      kind: "prd-file",
      label: "PRD file path",
      required: true,
    },
  },
  {
    id: "triage",
    description:
      "Review inbox and needs-info tasks, propose collaboration-state updates, and apply approved changes locally",
    kind: "proposal",
    prompts: {
      draft: "draft-prompt.md",
      finalization: "finalization-prompt.md",
    },
    input: {
      kind: "task-query",
      label: "Hub task query",
      required: false,
      defaultValue: HUB_TRIAGE_DEFAULT_TASK_QUERY,
    },
  },
] as const;

export const getHubFlowsRoot = (): string => {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "hub-flows");
};

export const getHubFlowDefinition = (
  flowId: string,
): HubFlowDefinition | undefined =>
  HUB_FLOW_DEFINITIONS.find((flow) => flow.id === flowId);

export const resolveHubFlowDirectory = (flowId: string): string =>
  join(getHubFlowsRoot(), flowId);

export const resolveHubFlowPromptPath = (
  flowId: string,
  promptKey: string,
): string => {
  const flow = getHubFlowDefinition(flowId);
  if (!flow) {
    throw new Error(`Unknown Hub flow: "${flowId}"`);
  }

  const promptFile = flow.prompts?.[promptKey];
  if (!promptFile) {
    throw new Error(
      `Hub flow "${flowId}" does not define prompt "${promptKey}"`,
    );
  }

  const promptPath = join(resolveHubFlowDirectory(flowId), promptFile);
  if (!existsSync(promptPath)) {
    throw new Error(`Missing Hub flow prompt: ${promptPath}`);
  }

  return promptPath;
};

export const readHubFlowPrompt = (flowId: string, promptKey: string): string =>
  readFileSync(resolveHubFlowPromptPath(flowId, promptKey), "utf8");

export const listHubFlows = (): readonly HubFlowDefinition[] =>
  HUB_FLOW_DEFINITIONS;

export const validateHubFlowRegistries = (): void => {
  for (const flow of HUB_FLOW_DEFINITIONS) {
    if (!flow.prompts) {
      continue;
    }

    const flowDir = resolveHubFlowDirectory(flow.id);
    if (!existsSync(flowDir)) {
      throw new Error(`Missing Hub flow directory: ${flowDir}`);
    }

    for (const promptFile of Object.values(flow.prompts)) {
      const promptPath = join(flowDir, promptFile);
      if (!existsSync(promptPath)) {
        throw new Error(`Missing Hub flow prompt: ${promptPath}`);
      }
    }
  }
};
