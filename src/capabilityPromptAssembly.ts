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

/** Marker for the Python project profile venv disclosure (issue #96). */
export const PYTHON_VENV_PROMPT_MARKER =
  "<!-- sandcastle:profile:python:venv -->";

/**
 * Brief prompt fragment telling agents that a Python venv is bootstrapped at
 * `.venv/` and that `.venv/bin` is on PATH, so they should call `python` /
 * `pytest` directly rather than reaching for the host system interpreter.
 *
 * See issue #96: without this hint agents can default to `python3` and pull in
 * unrelated globally-installed pytest plugins (e.g. ROS launch_testing) that
 * stall iteration.
 */
const PYTHON_VENV_PROMPT_BODY =
  "## Python environment\n" +
  "\n" +
  "A Python venv is bootstrapped at `.venv/`. Use `python` / `pytest` directly — `.venv/bin` is on PATH, so bare invocations resolve to the venv interpreter. Avoid `python3` from the host: it can pick up unrelated globally-installed packages (e.g. ROS `launch_testing` plugins) and hang.\n";

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

/**
 * Append the Python venv disclosure (issue #96) once per prompt file. Idempotent
 * via `PYTHON_VENV_PROMPT_MARKER`.
 */
export function appendPythonVenvNoteToPrompt(content: string): string {
  if (content.includes(PYTHON_VENV_PROMPT_MARKER)) {
    return content;
  }
  const section = `${PYTHON_VENV_PROMPT_MARKER}\n\n${PYTHON_VENV_PROMPT_BODY}`;
  const trimmed = content.trimEnd();
  return trimmed.length === 0 ? section : `${trimmed}\n\n${section}`;
}

/** Whether init should append the Python venv prompt fragment for this profile. */
export function shouldAppendPythonVenvNote(profileName: string): boolean {
  return profileName === "python";
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
