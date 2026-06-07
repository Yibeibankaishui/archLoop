export interface TemplateMetadata {
  name: string;
  description: string;
}

export const SCAFFOLD_TEMPLATES: readonly TemplateMetadata[] = [
  {
    name: "blank",
    description: "Bare scaffold — write your own prompt and orchestration",
  },
  {
    name: "simple-loop",
    description: "Picks issues one by one and closes them",
  },
  {
    name: "sequential-reviewer",
    description:
      "Implements issues one by one, with a code review step after each",
  },
  {
    name: "parallel-planner",
    description:
      "Plans parallelizable issues, executes on separate branches, merges",
  },
  {
    name: "parallel-planner-with-review",
    description:
      "Plans parallelizable issues, executes with per-branch review, merges",
  },
] as const;

export const listTemplates = (): TemplateMetadata[] => [...SCAFFOLD_TEMPLATES];
