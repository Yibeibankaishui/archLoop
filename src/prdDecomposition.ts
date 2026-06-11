import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  addHubTaskDependency,
  createHubTask,
  type CreateHubTaskResult,
} from "./taskBoard.js";

export type SliceType = "AFK" | "HITL";

export type PrdHubStatus = "inbox" | "ready_for_agent" | "ready_for_human";

export interface PrdDraftSlice {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly sliceType: SliceType;
}

export interface PrdDraftPlan {
  readonly prdRef: string;
  readonly prdTitle: string;
  readonly slices: readonly PrdDraftSlice[];
}

export interface PrdDependencyPair {
  readonly dependentIndex: number;
  readonly blockerIndex: number;
}

const HITL_PATTERN =
  /\b(human|confirm|confirmation|design|decide|triage|onboarding|approval|maintainer wants|user wants|asks the user|ask the user|manual review|reviewer)\b/i;

const TASKS_SECTION_PATTERN = /^#{2,3}\s+Tasks\b/im;
const DELIVERABLES_SECTION_PATTERN = /^##\s+Deliverables\b/im;
const USER_STORIES_SECTION_PATTERN = /^##\s+User Stories\b/im;
const NEXT_SECTION_PATTERN = /^#{1,3}\s+/m;

const extractPrdTitle = (content: string): string => {
  const prdMatch = content.match(/^#\s+PRD:\s*(.+)$/m);
  if (prdMatch?.[1]) {
    return prdMatch[1].trim();
  }

  const headingMatch = content.match(/^#\s+(.+)$/m);
  return headingMatch?.[1]?.trim() ?? "Untitled PRD";
};

const extractSection = (
  content: string,
  sectionPattern: RegExp,
): string | undefined => {
  const match = sectionPattern.exec(content);
  if (!match || match.index === undefined) {
    return undefined;
  }

  const sectionStart = match.index + match[0].length;
  const remainder = content.slice(sectionStart);
  const nextSection = NEXT_SECTION_PATTERN.exec(remainder);
  const sectionEnd =
    nextSection && nextSection.index !== undefined
      ? sectionStart + nextSection.index
      : content.length;

  return content.slice(sectionStart, sectionEnd).trim();
};

const normalizeItemText = (value: string): string =>
  value
    .replace(/^[-*]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();

const classifySliceType = (text: string): SliceType =>
  HITL_PATTERN.test(text) ? "HITL" : "AFK";

const extractCheckboxItems = (section: string): string[] =>
  section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[ \]\s+/.test(line))
    .map((line) => normalizeItemText(line))
    .filter((text) => text.length > 0);

const extractBulletItems = (section: string): string[] =>
  section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+(?!\[[ xX]\])/.test(line))
    .map((line) => normalizeItemText(line))
    .filter((text) => text.length > 0);

const extractNumberedItems = (section: string): string[] =>
  section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => normalizeItemText(line))
    .filter((text) => text.length > 0);

const toSliceTitle = (text: string): string => {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  if (firstSentence.length <= 96) {
    return firstSentence;
  }
  return `${firstSentence.slice(0, 93).trimEnd()}...`;
};

const buildSlices = (items: readonly string[]): PrdDraftSlice[] =>
  items.map((description, index) => ({
    key: `slice-${index + 1}`,
    title: toSliceTitle(description),
    description,
    sliceType: classifySliceType(description),
  }));

export const resolvePrdPath = (cwd: string, prdRef: string): string =>
  isAbsolute(prdRef) ? prdRef : resolve(cwd, prdRef);

export const readPrdFile = (cwd: string, prdRef: string): string => {
  const path = resolvePrdPath(cwd, prdRef);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read PRD at ${path}: ${message}`);
  }
};

export const draftPrdSlices = (
  content: string,
  prdRef: string,
): PrdDraftPlan => {
  const tasksSection = extractSection(content, TASKS_SECTION_PATTERN);
  const deliverablesSection = extractSection(
    content,
    DELIVERABLES_SECTION_PATTERN,
  );
  const userStoriesSection = extractSection(
    content,
    USER_STORIES_SECTION_PATTERN,
  );

  const items =
    (tasksSection ? extractCheckboxItems(tasksSection) : undefined) ??
    (deliverablesSection
      ? extractBulletItems(deliverablesSection)
      : undefined) ??
    (userStoriesSection
      ? extractNumberedItems(userStoriesSection)
      : undefined) ??
    [];

  return {
    prdRef,
    prdTitle: extractPrdTitle(content),
    slices: buildSlices(items),
  };
};

export const parseDependencySpec = (
  spec: string,
  sliceCount: number,
): PrdDependencyPair[] => {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return [];
  }

  return trimmed.split(",").flatMap((entry) => {
    const match = entry.trim().match(/^(\d+)\s*:\s*(\d+)$/);
    if (!match) {
      throw new Error(
        `Invalid dependency pair "${entry.trim()}". Use childIndex:parentIndex, e.g. 2:1.`,
      );
    }

    const dependentIndex = Number(match[1]) - 1;
    const blockerIndex = Number(match[2]) - 1;
    if (
      dependentIndex < 0 ||
      blockerIndex < 0 ||
      dependentIndex >= sliceCount ||
      blockerIndex >= sliceCount ||
      dependentIndex === blockerIndex
    ) {
      throw new Error(
        `Dependency pair "${entry.trim()}" is out of range for ${sliceCount} drafted slices.`,
      );
    }

    return [{ dependentIndex, blockerIndex }];
  });
};

export const formatPrdDraftPlan = (
  plan: PrdDraftPlan,
  dependencies: readonly PrdDependencyPair[] = [],
): readonly string[] => {
  const lines = [
    `PRD: ${plan.prdTitle}`,
    `Reference: ${plan.prdRef}`,
    `Drafted vertical slices: ${plan.slices.length}`,
  ];

  if (plan.slices.length === 0) {
    lines.push("No unchecked Tasks, Deliverables, or User Stories were found.");
    return lines;
  }

  lines.push("");
  for (const [index, slice] of plan.slices.entries()) {
    lines.push(
      `${index + 1}. [${slice.key}] ${slice.title} (${slice.sliceType})`,
    );
    lines.push(`   ${slice.description}`);
  }

  if (dependencies.length > 0) {
    lines.push("");
    lines.push("Dependencies:");
    for (const dependency of dependencies) {
      const dependent = plan.slices[dependency.dependentIndex];
      const blocker = plan.slices[dependency.blockerIndex];
      if (dependent && blocker) {
        lines.push(`  - ${dependent.key} depends on ${blocker.key}`);
      }
    }
  }

  return lines;
};

export interface PublishPrdDraftInput {
  readonly cwd: string;
  readonly plan: PrdDraftPlan;
  readonly hubStatus: PrdHubStatus;
  readonly dependencies?: readonly PrdDependencyPair[];
}

export interface PublishPrdDraftResult {
  readonly tasks: readonly CreateHubTaskResult[];
  readonly dependencies: readonly {
    readonly dependentId: string;
    readonly blockerId: string;
  }[];
}

export const publishPrdDraftPlan = (
  input: PublishPrdDraftInput,
): PublishPrdDraftResult => {
  if (input.plan.slices.length === 0) {
    throw new Error("Cannot publish an empty PRD draft plan.");
  }

  const tasks = input.plan.slices.map((slice) =>
    createHubTask(input.cwd, {
      title: slice.title,
      description: slice.description,
      origin: "prd-decomposition",
      sliceType: slice.sliceType,
      prdRef: input.plan.prdRef,
      hubStatus: input.hubStatus,
    }),
  );

  const dependencies = (input.dependencies ?? []).flatMap((dependency) => {
    const dependent = tasks[dependency.dependentIndex];
    const blocker = tasks[dependency.blockerIndex];
    if (!dependent || !blocker) {
      return [];
    }

    addHubTaskDependency(input.cwd, dependent.id, blocker.id);
    return [{ dependentId: dependent.id, blockerId: blocker.id }];
  });

  return { tasks, dependencies };
};
