import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityVerificationMetadata } from "./capabilityPacks.js";

/** Marker appended once to assembled capability prompts for idempotency. */
export const MINIPROGRAM_VERIFICATION_PROMPT_MARKER =
  "<!-- sandcastle:capability:miniprogram:verification -->";

const PROMPT_FILES_BY_TEMPLATE: Readonly<Record<string, readonly string[]>> = {
  blank: ["prompt.md"],
  "simple-loop": ["prompt.md"],
  "sequential-reviewer": ["implement-prompt.md", "review-prompt.md"],
  "parallel-planner": [
    "plan-prompt.md",
    "implement-prompt.md",
    "merge-prompt.md",
  ],
  "parallel-planner-with-review": [
    "plan-prompt.md",
    "implement-prompt.md",
    "review-prompt.md",
    "merge-prompt.md",
  ],
};

function getCapabilityBundlesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "capability-bundles");
}

let cachedMiniprogramVerificationSection: string | undefined;

/** Shared Mini Program verification section appended to template prompts during init. */
export function getMiniprogramVerificationPromptSection(): string {
  if (cachedMiniprogramVerificationSection === undefined) {
    const path = join(
      getCapabilityBundlesDir(),
      "miniprogram",
      "prompt-verification.md",
    );
    const body = readFileSync(path, "utf-8").trim();
    cachedMiniprogramVerificationSection = `${MINIPROGRAM_VERIFICATION_PROMPT_MARKER}\n\n${body}\n`;
  }
  return cachedMiniprogramVerificationSection;
}

/** Prompt filenames in a template directory that receive capability verification guidance. */
export function listTemplatePromptFiles(
  templateName: string,
): readonly string[] {
  const files = PROMPT_FILES_BY_TEMPLATE[templateName];
  if (!files) {
    throw new Error(
      `Unknown template for capability prompt assembly: "${templateName}"`,
    );
  }
  return files;
}

export function appendMiniprogramVerificationToPrompt(content: string): string {
  const section = getMiniprogramVerificationPromptSection();
  if (content.includes(MINIPROGRAM_VERIFICATION_PROMPT_MARKER)) {
    return content;
  }
  const trimmed = content.trimEnd();
  return trimmed.length === 0 ? section : `${trimmed}\n\n${section}`;
}

/** Whether init should assemble Mini Program verification guidance into template prompts. */
export function shouldAssembleMiniprogramPrompts(
  capabilityId: string,
  verification: CapabilityVerificationMetadata | undefined,
): boolean {
  return capabilityId === "miniprogram" && verification !== undefined;
}
