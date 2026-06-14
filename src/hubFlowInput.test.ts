import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HubFlowError } from "./errors.js";
import {
  HUB_TRIAGE_DEFAULT_TASK_QUERY,
  formatValidatedHubFlowInputSummary,
  mapFromPrdArgToFlowInput,
  mapTriageToFlowInput,
  resolveHubFlowRawInput,
  validateHubFlowInput,
} from "./hubFlowInput.js";
import { getHubFlowDefinition } from "./hubFlows.js";

describe("hub flow input schemas", () => {
  it("declares prd-decomposition and triage input schemas on proposal flows", () => {
    const prdFlow = getHubFlowDefinition("prd-decomposition");
    const triageFlow = getHubFlowDefinition("triage");

    expect(prdFlow?.kind).toBe("proposal");
    expect(prdFlow?.input).toEqual({
      kind: "prd-file",
      label: "PRD file path",
      required: true,
    });
    expect(triageFlow?.kind).toBe("proposal");
    expect(triageFlow?.prompts).toEqual({
      draft: "draft-prompt.md",
      finalization: "finalization-prompt.md",
    });
    expect(triageFlow?.input).toEqual({
      kind: "task-query",
      label: "Hub task query",
      required: false,
      defaultValue: HUB_TRIAGE_DEFAULT_TASK_QUERY,
    });
  });

  it("validates readable PRD file input for prd-decomposition", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-input-"));
    const prdPath = join(cwd, "docs", "feature.md");
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(prdPath, "# PRD: Feature\n\n## Tasks\n\n- [ ] Build it\n");

    const validated = validateHubFlowInput("prd-decomposition", {
      cwd,
      rawInput: "docs/feature.md",
    });

    expect(validated).toEqual({
      flowId: "prd-decomposition",
      kind: "prd-file",
      ref: "docs/feature.md",
      path: prdPath,
      content: "# PRD: Feature\n\n## Tasks\n\n- [ ] Build it\n",
    });
  });

  it("rejects missing required PRD input before flow execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-input-"));

    expect(() =>
      validateHubFlowInput("prd-decomposition", { cwd }),
    ).toThrowError(HubFlowError);
    expect(() => validateHubFlowInput("prd-decomposition", { cwd })).toThrow(
      /PRD file path is required/,
    );
  });

  it("rejects unreadable PRD paths before flow execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-input-"));

    expect(() =>
      validateHubFlowInput("prd-decomposition", {
        cwd,
        rawInput: "docs/missing.md",
      }),
    ).toThrow(/Unable to read PRD/);
  });

  it("defaults triage task query to inbox and needs_info", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-input-"));

    const validated = validateHubFlowInput("triage", { cwd });

    expect(validated).toEqual({
      flowId: "triage",
      kind: "task-query",
      query: HUB_TRIAGE_DEFAULT_TASK_QUERY,
    });
    expect(resolveHubFlowRawInput("triage", undefined)).toBe(
      HUB_TRIAGE_DEFAULT_TASK_QUERY,
    );
  });

  it("accepts explicit triage task queries with known Hub statuses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-input-"));

    const validated = validateHubFlowInput("triage", {
      cwd,
      rawInput: " inbox , needs_info ",
    });

    expect(validated).toMatchObject({
      flowId: "triage",
      kind: "task-query",
      query: "inbox,needs_info",
    });
  });

  it("rejects unsupported task query statuses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-input-"));

    expect(() =>
      validateHubFlowInput("triage", {
        cwd,
        rawInput: "ready_for_agent",
      }),
    ).toThrow(/Unsupported Hub task query status/);
  });

  it("rejects unknown flow input kinds in the registry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-input-"));

    expect(() =>
      validateHubFlowInput("no-review", {
        cwd,
        rawInput: "anything",
      }),
    ).toThrow(/does not accept flow input/);
  });

  it("maps task shortcut arguments onto the shared flow input model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-input-"));
    const prdPath = join(cwd, "feature.md");
    await writeFile(prdPath, "# PRD: Shortcut\n");

    expect(mapFromPrdArgToFlowInput(cwd, "feature.md").ref).toBe("feature.md");
    expect(mapTriageToFlowInput(cwd).query).toBe(HUB_TRIAGE_DEFAULT_TASK_QUERY);
    expect(
      formatValidatedHubFlowInputSummary(mapTriageToFlowInput(cwd)),
    ).toContain("inbox,needs_info");
  });
});
