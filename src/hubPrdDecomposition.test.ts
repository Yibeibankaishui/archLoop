import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyPrdDecompositionProposal,
  formatPrdDecompositionProposalLines,
  parsePrdProposalDependencyOverride,
  preparePrdDecompositionContext,
  prdDecompositionProposalOutput,
  runPrdDecompositionFlow,
  substitutePrdDecompositionDraftPrompt,
  validatePrdDecompositionProposal,
  type PrdDecompositionProposal,
} from "./hubPrdDecomposition.js";
import { readHubFlowPrompt } from "./hubFlows.js";
import type { ValidatedPrdFileFlowInput } from "./hubFlowInput.js";
import type {
  ProposalAgentInvokeInput,
  ProposalAgentInvoker,
} from "./hubProposalSession.js";

const sampleProposal = (): PrdDecompositionProposal => ({
  prdRef: "docs/prd/feature.md",
  prdTitle: "Feature Slice",
  summary: "Three tracer-bullet slices with one human checkpoint.",
  slices: [
    {
      tempId: "slice-1",
      title: "Implement feature core path",
      description: "Deliver the end-to-end core feature path.",
      sliceType: "AFK",
      acceptanceCriteria: [
        "Core path works from CLI",
        "Tests cover the happy path",
      ],
      rationale: "Tracer-bullet vertical slice for the main user journey.",
    },
    {
      tempId: "slice-2",
      title: "Confirm rollout checklist with maintainer",
      description: "Review rollout risks and confirm the release checklist.",
      sliceType: "HITL",
      acceptanceCriteria: ["Maintainer confirms rollout checklist"],
      rationale: "Human-owned release decision before broad rollout.",
    },
    {
      tempId: "slice-3",
      title: "Add verification coverage for feature core path",
      description: "Expand verification around the core path.",
      sliceType: "AFK",
      acceptanceCriteria: ["Regression tests cover the core path"],
      rationale: "Hardens the first slice without widening scope.",
    },
  ],
  dependencies: [
    { dependentTempId: "slice-2", blockerTempId: "slice-1" },
    { dependentTempId: "slice-3", blockerTempId: "slice-2" },
  ],
  warnings: [],
});

describe("validatePrdDecompositionProposal", () => {
  it("accepts a well-formed proposal", () => {
    expect(() =>
      validatePrdDecompositionProposal(sampleProposal()),
    ).not.toThrow();
  });

  it("rejects duplicate temp ids", () => {
    const proposal = {
      ...sampleProposal(),
      slices: [
        sampleProposal().slices[0]!,
        { ...sampleProposal().slices[1]!, tempId: "slice-1" },
      ],
      dependencies: [],
      warnings: [],
    };

    expect(() => validatePrdDecompositionProposal(proposal)).toThrow(
      /duplicate slice temp ids/i,
    );
  });

  it("rejects unknown dependency temp ids", () => {
    const proposal = {
      ...sampleProposal(),
      dependencies: [{ dependentTempId: "slice-9", blockerTempId: "slice-1" }],
    };

    expect(() => validatePrdDecompositionProposal(proposal)).toThrow(
      /unknown temp id/i,
    );
  });

  it("rejects dependency cycles", () => {
    const proposal = {
      ...sampleProposal(),
      dependencies: [
        { dependentTempId: "slice-2", blockerTempId: "slice-1" },
        { dependentTempId: "slice-1", blockerTempId: "slice-2" },
      ],
    };

    expect(() => validatePrdDecompositionProposal(proposal)).toThrow(/cycle/i);
  });

  it("rejects missing acceptance criteria", () => {
    const proposal = {
      ...sampleProposal(),
      slices: [
        {
          ...sampleProposal().slices[0]!,
          acceptanceCriteria: [],
        },
      ],
      dependencies: [],
      warnings: [],
    };

    expect(() => validatePrdDecompositionProposal(proposal)).toThrow(
      /acceptanceCriteria must be a non-empty array/i,
    );
  });

  it("rejects invalid slice types", () => {
    const proposal = {
      ...sampleProposal(),
      slices: [
        {
          ...sampleProposal().slices[0]!,
          sliceType: "MANUAL" as "AFK",
        },
      ],
      dependencies: [],
      warnings: [],
    };

    expect(() => validatePrdDecompositionProposal(proposal)).toThrow(
      /sliceType must be AFK or HITL/i,
    );
  });

  it("blocks unattended ready-state creation when high-severity warnings exist", () => {
    const proposal = {
      ...sampleProposal(),
      warnings: [
        {
          tempId: "slice-2",
          severity: "high" as const,
          message: "Rollout criteria are unclear.",
        },
      ],
    };

    expect(() =>
      validatePrdDecompositionProposal(proposal, {
        unattendedReadyStates: true,
      }),
    ).toThrow(/high-severity PRD warnings/i);
  });
});

describe("applyPrdDecompositionProposal", () => {
  it("creates Beads tasks with PRD metadata, acceptance criteria, and dependencies", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "prd-proposal-apply-"));
    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });

    const createArgsFile = join(hostDir, "create-args.txt");
    const depArgsFile = join(hostDir, "dep-args.txt");
    const createCountFile = join(hostDir, "create-count.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "create" ]; then
  n=0
  if [ -f "${createCountFile}" ]; then
    n=$(cat "${createCountFile}")
  fi
  n=$((n + 1))
  printf '%s' "$n" > "${createCountFile}"
  printf '%s\\n' "$@" >> "${createArgsFile}"
  printf '[{"id":"bd-%s","title":"%s"}]\\n' "$n" "$2"
  exit 0
fi
if [ "$1" = "dep" ] && [ "$2" = "add" ]; then
  printf '%s\\n' "$@" >> "${depArgsFile}"
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;

    try {
      const result = applyPrdDecompositionProposal({
        cwd: hostDir,
        proposal: sampleProposal(),
        hubStatusMode: "inbox",
        proposalRunId: "run-proposal-1",
      });

      expect(result.tasks).toHaveLength(3);
      expect(result.dependencies).toEqual([
        { dependentId: "bd-2", blockerId: "bd-1" },
        { dependentId: "bd-3", blockerId: "bd-2" },
      ]);

      const createArgs = await import("node:fs/promises").then((fs) =>
        fs.readFile(createArgsFile, "utf8"),
      );
      expect(createArgs).toContain('"origin":"prd-decomposition"');
      expect(createArgs).toContain('"prd_ref":"docs/prd/feature.md"');
      expect(createArgs).toContain('"proposal_run_id":"run-proposal-1"');
      expect(createArgs).toContain("needs-triage");
      expect(createArgs).toContain("Acceptance criteria");
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
    }
  });

  it("includes userStoriesCovered in task body when present", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "prd-proposal-stories-"));
    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });

    const createArgsFile = join(hostDir, "create-args.txt");
    const createCountFile = join(hostDir, "create-count.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "create" ]; then
  n=0
  if [ -f "${createCountFile}" ]; then
    n=$(cat "${createCountFile}")
  fi
  n=$((n + 1))
  printf '%s' "$n" > "${createCountFile}"
  printf '%s\\n' "$@" >> "${createArgsFile}"
  printf '[{"id":"bd-%s","title":"%s"}]\\n' "$n" "$2"
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;

    try {
      const proposal: PrdDecompositionProposal = {
        ...sampleProposal(),
        slices: [
          {
            ...sampleProposal().slices[0]!,
            userStoriesCovered: ["US-1", "US-2"],
          },
        ],
        dependencies: [],
        warnings: [],
      };

      applyPrdDecompositionProposal({
        cwd: hostDir,
        proposal,
        hubStatusMode: "inbox",
        proposalRunId: "run-proposal-stories",
      });

      const createArgs = await import("node:fs/promises").then((fs) =>
        fs.readFile(createArgsFile, "utf8"),
      );
      expect(createArgs).toContain("User stories: US-1, US-2");
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
    }
  });

  it("maps AFK and HITL slices to ready states in classified mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "prd-proposal-ready-"));
    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });

    const createArgsFile = join(hostDir, "create-args.txt");
    const createCountFile = join(hostDir, "create-count.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "create" ]; then
  n=0
  if [ -f "${createCountFile}" ]; then
    n=$(cat "${createCountFile}")
  fi
  n=$((n + 1))
  printf '%s' "$n" > "${createCountFile}"
  printf '%s\\n' "$@" >> "${createArgsFile}"
  printf '[{"id":"bd-%s","title":"%s"}]\\n' "$n" "$2"
  exit 0
fi
if [ "$1" = "dep" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;

    try {
      applyPrdDecompositionProposal({
        cwd: hostDir,
        proposal: sampleProposal(),
        hubStatusMode: "classified_ready",
        proposalRunId: "run-proposal-2",
      });

      const createArgs = await import("node:fs/promises").then((fs) =>
        fs.readFile(createArgsFile, "utf8"),
      );
      expect(createArgs).toContain('"slice_type":"AFK"');
      expect(createArgs).toContain('"slice_type":"HITL"');
      expect(createArgs).toContain("ready-for-agent");
      expect(createArgs).toContain("ready-for-human");
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
    }
  });
});

const createFakeInvoker = (
  finalProposal: PrdDecompositionProposal,
): ProposalAgentInvoker => {
  const tag = prdDecompositionProposalOutput().tag;
  return async (input: ProposalAgentInvokeInput) => {
    if (input.phase === "finalization") {
      return {
        assistantMessage: `Approved.\n<${tag}>${JSON.stringify(finalProposal)}</${tag}>`,
      };
    }
    return {
      assistantMessage: `Draft proposal for ${String(input.preparedContext.prdRef)}.`,
    };
  };
};

const emptyBdScript = `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
exit 1
`;

describe("prd decomposition helpers", () => {
  it("prepares PRD and Hub context for the proposal session", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "prd-proposal-context-"));
    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(bdPath, emptyBdScript);
    await chmod(bdPath, 0o755);

    await mkdir(join(hostDir, "docs", "prd"), { recursive: true });
    await writeFile(
      join(hostDir, "docs", "prd", "feature.md"),
      "# PRD: Feature Slice\n\nBody",
    );

    const validatedInput: ValidatedPrdFileFlowInput = {
      flowId: "prd-decomposition",
      kind: "prd-file",
      ref: "docs/prd/feature.md",
      path: join(hostDir, "docs", "prd", "feature.md"),
      content: "# PRD: Feature Slice\n\nBody",
    };

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;

    try {
      const context = preparePrdDecompositionContext(validatedInput, hostDir);
      expect(context.prdRef).toBe("docs/prd/feature.md");
      expect(context.prdTitle).toBe("Feature Slice");
      expect(context.prdContent).toContain("Feature Slice");
      expect(context.hubTaskSummary).toEqual({
        totalTasks: 0,
        inboxCount: 0,
        needsInfoCount: 0,
      });
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
    }
  });

  it("substitutes prepared context placeholders into the draft prompt", () => {
    const context = {
      prdRef: "docs/prd/feature.md",
      prdPath: "/tmp/docs/prd/feature.md",
      prdTitle: "Feature Slice",
      prdContent: "# PRD: Feature Slice\n\nBody text",
      hubTaskSummary: {
        totalTasks: 0,
        inboxCount: 0,
        needsInfoCount: 0,
      },
    };
    const template = readHubFlowPrompt("prd-decomposition", "draft");
    const prompt = substitutePrdDecompositionDraftPrompt(template, context);

    expect(prompt).toContain("docs/prd/feature.md");
    expect(prompt).toContain("Feature Slice");
    expect(prompt).toContain("Body text");
    expect(prompt).toContain("Total tasks: 0");
    expect(prompt).not.toContain("{{PRD_REF}}");
    expect(prompt).not.toContain("{{PRD_CONTENT}}");
  });

  it("formats proposal summaries and parses dependency overrides", () => {
    const lines = formatPrdDecompositionProposalLines(sampleProposal());
    expect(lines.join("\n")).toContain("slice-1");
    expect(lines.join("\n")).toContain("AFK");
    expect(lines.join("\n")).toContain("slice-3 depends on slice-2");

    expect(
      parsePrdProposalDependencyOverride("2:1,3:2", sampleProposal()),
    ).toEqual([
      { dependentTempId: "slice-2", blockerTempId: "slice-1" },
      { dependentTempId: "slice-3", blockerTempId: "slice-2" },
    ]);
  });
});

describe("runPrdDecompositionFlow", () => {
  it("runs a one-shot proposal session and applies inbox tasks by default", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "prd-proposal-flow-"));
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    await execAsync("git init -b main", { cwd: hostDir });
    await execAsync('git config user.email "test@test.com"', { cwd: hostDir });
    await execAsync('git config user.name "Test"', { cwd: hostDir });

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(join(hostDir, "docs", "prd"), { recursive: true });
    await writeFile(
      join(hostDir, "docs", "prd", "feature.md"),
      `# PRD: Feature Slice

### Tasks

- [ ] Implement feature core path
`,
    );

    const createArgsFile = join(hostDir, "create-args.txt");
    const createCountFile = join(hostDir, "create-count.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "create" ]; then
  n=0
  if [ -f "${createCountFile}" ]; then
    n=$(cat "${createCountFile}")
  fi
  n=$((n + 1))
  printf '%s' "$n" > "${createCountFile}"
  printf '%s\\n' "$@" >> "${createArgsFile}"
  printf '[{"id":"bd-%s","title":"%s"}]\\n' "$n" "$2"
  exit 0
fi
if [ "$1" = "dep" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;

    try {
      const result = await runPrdDecompositionFlow({
        cwd: hostDir,
        prdRef: "docs/prd/feature.md",
        yes: true,
        agentInvoker: createFakeInvoker(sampleProposal()),
        hubAgentConfig: {
          roles: {
            planning: { provider: "cursor", model: "auto" },
          },
        },
      });

      expect(result.outcome).toBe("applied");
      if (result.outcome !== "applied") {
        throw new Error("expected applied PRD decomposition flow");
      }
      expect(result.tasks).toHaveLength(3);
      expect(result.hubStatusMode).toBe("inbox");
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
    }
  });

  it("passes a draft prompt with substituted prepared context to the agent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "prd-proposal-draft-"));
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    await execAsync("git init -b main", { cwd: hostDir });
    await execAsync('git config user.email "test@test.com"', { cwd: hostDir });
    await execAsync('git config user.name "Test"', { cwd: hostDir });

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(join(hostDir, "docs", "prd"), { recursive: true });
    await writeFile(
      join(hostDir, "docs", "prd", "feature.md"),
      "# PRD: Feature Slice\n\nUnique PRD body marker",
    );
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "create" ]; then
  printf '[{"id":"bd-1","title":"%s"}]\\n' "$2"
  exit 0
fi
if [ "$1" = "dep" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const calls: ProposalAgentInvokeInput[] = [];
    const invoker: ProposalAgentInvoker = async (input) => {
      calls.push(input);
      if (input.phase === "finalization") {
        const tag = prdDecompositionProposalOutput().tag;
        return {
          assistantMessage: `Approved.\n<${tag}>${JSON.stringify(sampleProposal())}</${tag}>`,
        };
      }
      return { assistantMessage: "Draft" };
    };

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;

    try {
      await runPrdDecompositionFlow({
        cwd: hostDir,
        prdRef: "docs/prd/feature.md",
        yes: true,
        agentInvoker: invoker,
        hubAgentConfig: {
          roles: {
            planning: { provider: "cursor", model: "auto" },
          },
        },
      });

      expect(calls[0]?.prompt).toContain("Unique PRD body marker");
      expect(calls[0]?.prompt).toContain("Feature Slice");
      expect(calls[0]?.prompt).not.toContain("{{PRD_CONTENT}}");
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
    }
  });
});
