import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface HubFlowDefinition {
  readonly id: string;
  readonly description: string;
  readonly hasReviewer: boolean;
  readonly prompts: Readonly<Record<string, string>>;
}

export const HUB_FLOW_DEFINITIONS: readonly HubFlowDefinition[] = [
  {
    id: "no-review",
    description:
      "Claim ready tasks, run implementers with Hub-owned prompts, and advance successful work to waiting for merge",
    hasReviewer: false,
    prompts: {
      implement: "implement-prompt.md",
    },
  },
  {
    id: "with-review",
    description:
      "Claim ready tasks, run implementers and reviewers with Hub-owned prompts, and advance successful work to waiting for merge",
    hasReviewer: true,
    prompts: {
      implement: "implement-prompt.md",
      review: "review-prompt.md",
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

  const promptFile = flow.prompts[promptKey];
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
