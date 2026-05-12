import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface PresetSkillDefinition {
  readonly id: string;
}

export interface PresetAgentDefinition {
  readonly id: string;
  readonly description: string;
  /** Source filename under preset-bundles/agents/ */
  readonly promptFile: string;
  readonly recommendedAgentName: string;
  readonly recommendedModel: string;
  readonly recommendedEffort?: string;
  readonly skillIds: readonly string[];
}

export const PRESET_SKILL_DEFINITIONS: readonly PresetSkillDefinition[] = [
  { id: "role-guidance" },
  { id: "merge-playbook" },
  { id: "miniprogram-context" },
] as const;

export const PRESET_AGENT_DEFINITIONS: readonly PresetAgentDefinition[] = [
  {
    id: "reviewer",
    description: "Code review: findings, severity, and actionable follow-ups",
    promptFile: "reviewer.prompt.md",
    recommendedAgentName: "claude-code",
    recommendedModel: "claude-opus-4-6",
    recommendedEffort: "high",
    skillIds: ["role-guidance"],
  },
  {
    id: "planner",
    description: "Planning: decompose goals into verifiable vertical slices",
    promptFile: "planner.prompt.md",
    recommendedAgentName: "claude-code",
    recommendedModel: "claude-opus-4-6",
    recommendedEffort: "high",
    skillIds: ["role-guidance"],
  },
  {
    id: "merger",
    description: "Merges: integrate branches and resolve conflicts carefully",
    promptFile: "merger.prompt.md",
    recommendedAgentName: "claude-code",
    recommendedModel: "claude-opus-4-6",
    skillIds: ["merge-playbook"],
  },
  {
    id: "miniprogram",
    description: "WeChat Mini Program development and CloudBase-aware flows",
    promptFile: "miniprogram.prompt.md",
    recommendedAgentName: "codex",
    recommendedModel: "gpt-5.4-mini",
    skillIds: ["miniprogram-context"],
  },
] as const;

export function getPresetBundlesRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "preset-bundles");
}

export function listPresetAgentsForInit(): {
  value: string;
  label: string;
  hint: string;
}[] {
  return PRESET_AGENT_DEFINITIONS.map((a) => ({
    value: a.id,
    label: a.id,
    hint: a.description,
  }));
}

export function getPresetAgentDefinition(
  id: string,
): PresetAgentDefinition | undefined {
  return PRESET_AGENT_DEFINITIONS.find((a) => a.id === id);
}

export function getPresetSkillDefinition(
  id: string,
): PresetSkillDefinition | undefined {
  return PRESET_SKILL_DEFINITIONS.find((s) => s.id === id);
}

/**
 * Validates registries and on-disk bundle layout. Throws on invalid data
 * so tests and init fail fast instead of shipping broken presets.
 */
export function validatePresetRegistries(): void {
  const skillIds = new Set<string>();
  for (const s of PRESET_SKILL_DEFINITIONS) {
    if (!ID_PATTERN.test(s.id)) {
      throw new Error(`Invalid preset skill id: "${s.id}"`);
    }
    if (skillIds.has(s.id)) {
      throw new Error(`Duplicate preset skill id: "${s.id}"`);
    }
    skillIds.add(s.id);
    const dir = join(getPresetBundlesRoot(), "skills", s.id);
    if (!existsSync(dir)) {
      throw new Error(`Missing preset skill directory: ${dir}`);
    }
  }

  const agentIds = new Set<string>();
  for (const a of PRESET_AGENT_DEFINITIONS) {
    if (!ID_PATTERN.test(a.id)) {
      throw new Error(`Invalid preset agent id: "${a.id}"`);
    }
    if (agentIds.has(a.id)) {
      throw new Error(`Duplicate preset agent id: "${a.id}"`);
    }
    agentIds.add(a.id);

    const promptPath = join(getPresetBundlesRoot(), "agents", a.promptFile);
    if (!existsSync(promptPath)) {
      throw new Error(`Missing preset agent prompt: ${promptPath}`);
    }

    for (const sid of a.skillIds) {
      if (!skillIds.has(sid)) {
        throw new Error(
          `Preset agent "${a.id}" references unknown skill "${sid}"`,
        );
      }
    }
  }
}
