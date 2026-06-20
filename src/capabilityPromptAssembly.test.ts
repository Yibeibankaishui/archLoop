import { describe, expect, it } from "vitest";
import {
  appendPythonVenvNoteToPrompt,
  PYTHON_VENV_PROMPT_MARKER,
  shouldAppendPythonVenvNote,
} from "./capabilityPromptAssembly.js";

/**
 * Tests for the prompt-side half of issue #96: when the Python project
 * profile is active, the agent's system prompt gets a short note saying
 * a venv is bootstrapped and `.venv/bin` is on PATH so bare `python` /
 * `pytest` invocations resolve to the venv interpreter.
 */
describe("Python venv prompt disclosure (issue #96)", () => {
  it("appends the venv note with the idempotency marker", () => {
    const result = appendPythonVenvNoteToPrompt("# Existing prompt\n");
    expect(result).toContain(PYTHON_VENV_PROMPT_MARKER);
    expect(result).toContain("Python venv is bootstrapped");
    expect(result).toContain(".venv/bin");
    expect(result).toContain("PATH");
  });

  it("appends to an empty prompt by emitting just the section", () => {
    const result = appendPythonVenvNoteToPrompt("");
    expect(result).toContain(PYTHON_VENV_PROMPT_MARKER);
    expect(result).toContain("Python venv is bootstrapped");
  });

  it("is idempotent — running twice does not duplicate the section", () => {
    const once = appendPythonVenvNoteToPrompt("# Prompt\n");
    const twice = appendPythonVenvNoteToPrompt(once);
    expect(twice).toBe(once);
    // Marker appears exactly once.
    const occurrences = twice.split(PYTHON_VENV_PROMPT_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves the existing prompt body before the appended section", () => {
    const original = "# Existing prompt\n\nBody text.\n";
    const result = appendPythonVenvNoteToPrompt(original);
    expect(result.startsWith("# Existing prompt")).toBe(true);
    expect(result.indexOf("Body text.")).toBeLessThan(
      result.indexOf(PYTHON_VENV_PROMPT_MARKER),
    );
  });

  it("shouldAppendPythonVenvNote returns true only for the python profile", () => {
    expect(shouldAppendPythonVenvNote("python")).toBe(true);
    expect(shouldAppendPythonVenvNote("node")).toBe(false);
    expect(shouldAppendPythonVenvNote("generic")).toBe(false);
    expect(shouldAppendPythonVenvNote("cpp")).toBe(false);
  });
});
