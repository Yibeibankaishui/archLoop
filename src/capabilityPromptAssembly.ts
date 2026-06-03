import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MINIPROGRAM_CAPABILITY_PACK_ID,
  hasRuntimeDebugAddon,
  type CapabilityVerificationMetadata,
  type ResolvedCapabilityInit,
} from "./capabilityPacks.js";

/** Marker appended once to assembled capability prompts for idempotency. */
export const MINIPROGRAM_VERIFICATION_PROMPT_MARKER =
  "<!-- sandcastle:capability:miniprogram:verification -->";

/** Marker for runtime-debug add-on prompt guidance. */
export const MINIPROGRAM_RUNTIME_DEBUG_PROMPT_MARKER =
  "<!-- sandcastle:capability:miniprogram:runtime-debug -->";

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
let cachedMiniprogramRuntimeDebugSection: string | undefined;

function readMiniprogramPromptSection(
  marker: string,
  bundleFilename: string,
): string {
  const path = join(getCapabilityBundlesDir(), "miniprogram", bundleFilename);
  const body = readFileSync(path, "utf-8").trim();
  return `${marker}\n\n${body}\n`;
}

function appendMiniprogramPromptSection(
  content: string,
  marker: string,
  section: string,
): string {
  if (content.includes(marker)) {
    return content;
  }
  const trimmed = content.trimEnd();
  return trimmed.length === 0 ? section : `${trimmed}\n\n${section}`;
}

/** Shared Mini Program verification section appended to template prompts during init. */
export function getMiniprogramVerificationPromptSection(): string {
  if (cachedMiniprogramVerificationSection === undefined) {
    cachedMiniprogramVerificationSection = readMiniprogramPromptSection(
      MINIPROGRAM_VERIFICATION_PROMPT_MARKER,
      "prompt-verification.md",
    );
  }
  return cachedMiniprogramVerificationSection;
}

/** Runtime-debug add-on section appended to template prompts when selected. */
export function getMiniprogramRuntimeDebugPromptSection(): string {
  if (cachedMiniprogramRuntimeDebugSection === undefined) {
    cachedMiniprogramRuntimeDebugSection = readMiniprogramPromptSection(
      MINIPROGRAM_RUNTIME_DEBUG_PROMPT_MARKER,
      "prompt-runtime-debug.md",
    );
  }
  return cachedMiniprogramRuntimeDebugSection;
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
  return appendMiniprogramPromptSection(
    content,
    MINIPROGRAM_VERIFICATION_PROMPT_MARKER,
    getMiniprogramVerificationPromptSection(),
  );
}

export function appendMiniprogramRuntimeDebugToPrompt(content: string): string {
  return appendMiniprogramPromptSection(
    content,
    MINIPROGRAM_RUNTIME_DEBUG_PROMPT_MARKER,
    getMiniprogramRuntimeDebugPromptSection(),
  );
}

/** Whether init should assemble Mini Program verification guidance into template prompts. */
export function shouldAssembleMiniprogramPrompts(
  capabilityId: string,
  verification: CapabilityVerificationMetadata | undefined,
): boolean {
  return (
    capabilityId === MINIPROGRAM_CAPABILITY_PACK_ID &&
    verification !== undefined
  );
}

/** Whether init should assemble runtime-debug guidance into template prompts. */
export function shouldAssembleMiniprogramRuntimeDebugPrompts(
  capabilityInit: ResolvedCapabilityInit | undefined,
): boolean {
  if (capabilityInit === undefined) {
    return false;
  }
  if (
    !shouldAssembleMiniprogramPrompts(
      capabilityInit.capabilityId,
      capabilityInit.verification,
    )
  ) {
    return false;
  }
  return hasRuntimeDebugAddon(capabilityInit.addonIds);
}
