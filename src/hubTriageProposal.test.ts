import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readHubFlowPrompt } from "./hubFlows.js";
import {
  applyTriageProposal,
  classifyTriageDecisionAutoApply,
  formatTriageProposalLines,
  prepareTriageContext,
  runTriageProposalFlow,
  substituteTriageDraftPrompt,
  triageDecisionConfirmationReason,
  triageProposalOutput,
  validateTriageProposal,
  type TriageProposal,
  type TriageProposalDecision,
} from "./hubTriageProposal.js";
import { HUB_TRIAGE_COMMENT_PREFIX } from "./hubTriage.js";
import type {
  ProposalAgentInvokeInput,
  ProposalAgentInvoker,
} from "./hubProposalSession.js";
import { resolveProposalSessionApproval } from "./hubPrdDecomposition.js";

const sampleDecision = (
  overrides: Partial<TriageProposalDecision> = {},
): TriageProposalDecision => ({
  taskId: "bd-1",
  outcome: "ready_for_agent",
  category: "enhancement",
  confidence: "high",
  rationale: "Fully specified AFK-safe work.",
  comment: "Implement retry with backoff in sync-out.",
  ...overrides,
});

const sampleProposal = (
  overrides: Partial<TriageProposal> = {},
): TriageProposal => ({
  summary: "Two inbox tasks reviewed; one ready for agent.",
  decisions: [
    sampleDecision(),
    sampleDecision({
      taskId: "bd-2",
      outcome: "needs_info",
      confidence: "medium",
      comment: "Which auth provider failed?",
    }),
  ],
  ...overrides,
});

describe("triageProposalOutput", () => {
  const schema = triageProposalOutput().schema;

  it("parses a valid triage proposal", () => {
    const result = schema["~standard"].validate(sampleProposal());
    expect(result).toEqual({ value: sampleProposal() });
  });

  it("rejects missing decisions", () => {
    const result = schema["~standard"].validate({
      summary: "No decisions",
      decisions: [],
    });
    expect(result).toHaveProperty("issues");
  });

  it("rejects unknown outcomes", () => {
    const result = schema["~standard"].validate({
      summary: "Bad outcome",
      decisions: [{ ...sampleDecision(), outcome: "blocked" }],
    });
    expect(result).toHaveProperty("issues");
  });

  it("rejects invalid confidence", () => {
    const result = schema["~standard"].validate({
      summary: "Bad confidence",
      decisions: [{ ...sampleDecision(), confidence: "certain" }],
    });
    expect(result).toHaveProperty("issues");
  });

  it("rejects missing taskId", () => {
    const result = schema["~standard"].validate({
      summary: "Missing id",
      decisions: [{ ...sampleDecision(), taskId: "" }],
    });
    expect(result).toHaveProperty("issues");
  });
});

describe("validateTriageProposal", () => {
  it("accepts a well-formed proposal", () => {
    expect(() =>
      validateTriageProposal(sampleProposal(), {
        knownTaskIds: ["bd-1", "bd-2"],
      }),
    ).not.toThrow();
  });

  it("rejects unknown task ids", () => {
    expect(() =>
      validateTriageProposal(sampleProposal(), {
        knownTaskIds: ["bd-1"],
      }),
    ).toThrow(/unknown task id/i);
  });

  it("rejects duplicate task ids", () => {
    expect(() =>
      validateTriageProposal(
        {
          ...sampleProposal(),
          decisions: [sampleDecision(), sampleDecision()],
        },
        { knownTaskIds: ["bd-1"] },
      ),
    ).toThrow(/duplicate decision task ids/i);
  });

  it("rejects self-edge dependency suggestions", () => {
    expect(() =>
      validateTriageProposal(
        {
          ...sampleProposal(),
          decisions: [
            sampleDecision({
              dependencySuggestions: [
                {
                  dependentTaskId: "bd-1",
                  blockerTaskId: "bd-1",
                  rationale: "Self edge",
                },
              ],
            }),
          ],
        },
        { knownTaskIds: ["bd-1"], boardTaskIds: ["bd-1"] },
      ),
    ).toThrow(/self-edge/i);
  });

  it("rejects dependency cycles within proposed edges", () => {
    expect(() =>
      validateTriageProposal(
        {
          summary: "Cycle",
          decisions: [
            sampleDecision({
              taskId: "bd-1",
              dependencySuggestions: [
                {
                  dependentTaskId: "bd-1",
                  blockerTaskId: "bd-2",
                  rationale: "bd-1 blocked by bd-2",
                },
              ],
            }),
            sampleDecision({
              taskId: "bd-2",
              dependencySuggestions: [
                {
                  dependentTaskId: "bd-2",
                  blockerTaskId: "bd-1",
                  rationale: "bd-2 blocked by bd-1",
                },
              ],
            }),
          ],
        },
        { knownTaskIds: ["bd-1", "bd-2"], boardTaskIds: ["bd-1", "bd-2"] },
      ),
    ).toThrow(/cycle/i);
  });
});

describe("classifyTriageDecisionAutoApply", () => {
  it("auto-applies high-confidence ready_for_agent without dependencies", () => {
    expect(classifyTriageDecisionAutoApply(sampleDecision())).toBe("auto");
  });

  it("requires confirmation for wontfix", () => {
    expect(
      classifyTriageDecisionAutoApply(
        sampleDecision({ outcome: "wontfix", confidence: "high" }),
      ),
    ).toBe("needs_confirmation");
    expect(
      triageDecisionConfirmationReason(
        sampleDecision({ outcome: "wontfix", confidence: "high" }),
      ),
    ).toBe("wontfix");
  });

  it("requires confirmation when dependency suggestions exist", () => {
    expect(
      classifyTriageDecisionAutoApply(
        sampleDecision({
          dependencySuggestions: [
            {
              dependentTaskId: "bd-1",
              blockerTaskId: "bd-9",
              rationale: "Depends on bd-9",
            },
          ],
        }),
      ),
    ).toBe("needs_confirmation");
  });

  it("requires confirmation for medium confidence with medium_confidence reason", () => {
    const decision = sampleDecision({ confidence: "medium" });
    expect(classifyTriageDecisionAutoApply(decision)).toBe(
      "needs_confirmation",
    );
    expect(triageDecisionConfirmationReason(decision)).toBe(
      "medium_confidence",
    );
  });

  it("requires confirmation for low confidence with low_confidence reason", () => {
    const decision = sampleDecision({ confidence: "low" });
    expect(classifyTriageDecisionAutoApply(decision)).toBe(
      "needs_confirmation",
    );
    expect(triageDecisionConfirmationReason(decision)).toBe("low_confidence");
  });
});

const createBdScript = (input: {
  readonly stateFile: string;
  readonly updateArgsFile: string;
  readonly commentArgsFile: string;
  readonly depArgsFile: string;
}): string => `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const updateArgsFile = process.env.BD_UPDATE_ARGS_FILE;
const commentArgsFile = process.env.BD_COMMENT_ARGS_FILE;
const depArgsFile = process.env.BD_DEP_ARGS_FILE;
const args = process.argv.slice(2);
const [command, id] = args;

if (command === "list") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}

if (command === "show") {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.find((entry) => entry.id === id);
  if (!task) {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([task], null, 2));
  process.exit(0);
}

if (command === "update") {
  fs.appendFileSync(updateArgsFile, args.join(" ") + "\\n");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.find((entry) => entry.id === id);
  if (!task) {
    process.exit(1);
  }
  const statusIndex = args.indexOf("--status");
  if (statusIndex >= 0) {
    task.status = args[statusIndex + 1];
  }
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = JSON.parse(args[metadataIndex + 1]);
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--add-label") {
      const label = args[index + 1];
      task.labels = [...new Set([...(task.labels ?? []), label])];
    }
    if (args[index] === "--remove-label") {
      const label = args[index + 1];
      task.labels = (task.labels ?? []).filter((entry) => entry !== label);
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
}

if (command === "comments" && args[1] === "add") {
  fs.appendFileSync(commentArgsFile, args.join(" ") + "\\n");
  const taskId = args[2];
  const body = args.slice(3).join(" ");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.find((entry) => entry.id === taskId);
  if (!task) {
    process.exit(1);
  }
  task.comments = [...(task.comments ?? []), { author: "triage", body }];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
}

if (command === "dep" && args[1] === "add") {
  fs.appendFileSync(depArgsFile, args.join(" ") + "\\n");
  process.exit(0);
}

process.exit(1);
`;

describe("applyTriageProposal", () => {
  it("applies status transitions, comments, labels, dependencies, and wontfix closure", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "triage-proposal-apply-"));
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    await execAsync("git init -b main", { cwd: repoDir });
    await execAsync('git config user.email "test@test.com"', { cwd: repoDir });
    await execAsync('git config user.name "Test"', { cwd: repoDir });

    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const stateFile = join(repoDir, "bd-state.json");
    const updateArgsFile = join(repoDir, "bd-update-args.txt");
    const commentArgsFile = join(repoDir, "bd-comment-args.txt");
    const depArgsFile = join(repoDir, "bd-dep-args.txt");

    await writeFile(
      stateFile,
      JSON.stringify(
        [
          {
            id: "bd-1",
            title: "Ready task",
            status: "open",
            labels: ["needs-triage"],
            metadata: { hubStatus: "inbox" },
            description: "Ready for AFK implementation.",
          },
          {
            id: "bd-2",
            title: "Needs info task",
            status: "open",
            labels: ["needs-info"],
            metadata: { hubStatus: "needs_info" },
            description: "Missing details.",
          },
          {
            id: "bd-3",
            title: "Duplicate",
            status: "open",
            labels: ["needs-triage"],
            metadata: { hubStatus: "inbox" },
            description: "Duplicate report.",
          },
          {
            id: "bd-9",
            title: "Blocker",
            status: "open",
            labels: ["ready-for-agent"],
            metadata: { hubStatus: "ready_for_agent" },
            description: "Existing blocker.",
          },
        ],
        null,
        2,
      ),
    );
    await writeFile(updateArgsFile, "");
    await writeFile(commentArgsFile, "");
    await writeFile(depArgsFile, "");

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      createBdScript({
        stateFile,
        updateArgsFile,
        commentArgsFile,
        depArgsFile,
      }),
    );
    await chmod(bdPath, 0o755);

    const proposal: TriageProposal = {
      summary: "Batch triage",
      decisions: [
        sampleDecision({
          labels: ["area/sync"],
          dependencySuggestions: [
            {
              dependentTaskId: "bd-1",
              blockerTaskId: "bd-9",
              rationale: "Retry depends on error classification.",
            },
          ],
        }),
        sampleDecision({
          taskId: "bd-2",
          outcome: "needs_info",
          confidence: "medium",
          comment: "Which provider failed?",
        }),
        sampleDecision({
          taskId: "bd-3",
          outcome: "wontfix",
          confidence: "high",
          comment: "Duplicate of bd-12.",
        }),
      ],
    };

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;
    process.env.BD_STATE_FILE = stateFile;
    process.env.BD_UPDATE_ARGS_FILE = updateArgsFile;
    process.env.BD_COMMENT_ARGS_FILE = commentArgsFile;
    process.env.BD_DEP_ARGS_FILE = depArgsFile;

    try {
      const result = applyTriageProposal({
        cwd: repoDir,
        proposal,
        decisionsToApply: new Set(["bd-1", "bd-2", "bd-3"]),
        proposalRunId: "run-triage-apply",
      });

      expect([...result.appliedDecisions].sort()).toEqual([
        "bd-1",
        "bd-2",
        "bd-3",
      ]);
      expect(result.dependencies).toEqual([
        { dependentId: "bd-1", blockerId: "bd-9" },
      ]);

      const updateArgs = await import("node:fs/promises").then((fs) =>
        fs.readFile(updateArgsFile, "utf8"),
      );
      const commentArgs = await import("node:fs/promises").then((fs) =>
        fs.readFile(commentArgsFile, "utf8"),
      );
      const depArgs = await import("node:fs/promises").then((fs) =>
        fs.readFile(depArgsFile, "utf8"),
      );

      expect(updateArgs).toContain("bd-1");
      expect(updateArgs).toContain("ready-for-agent");
      expect(updateArgs).toContain("area/sync");
      expect(updateArgs).toContain("bd-2");
      expect(updateArgs).toContain("needs-info");
      expect(updateArgs).toContain("bd-3");
      expect(updateArgs).toContain("--status closed");
      expect(updateArgs).toContain("wontfix");
      expect(commentArgs).toContain(HUB_TRIAGE_COMMENT_PREFIX);
      expect(depArgs).toContain("bd-1");
      expect(depArgs).toContain("bd-9");
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
      delete process.env.BD_STATE_FILE;
      delete process.env.BD_UPDATE_ARGS_FILE;
      delete process.env.BD_COMMENT_ARGS_FILE;
      delete process.env.BD_DEP_ARGS_FILE;
    }
  });

  it("applies ready_for_human outcome with hub status and label", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "triage-proposal-human-"));
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { readFile: readFileAsync } = await import("node:fs/promises");
    const execAsync = promisify(exec);
    await execAsync("git init -b main", { cwd: repoDir });
    await execAsync('git config user.email "test@test.com"', { cwd: repoDir });
    await execAsync('git config user.name "Test"', { cwd: repoDir });

    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const stateFile = join(repoDir, "bd-state.json");
    const updateArgsFile = join(repoDir, "bd-update-args.txt");
    const commentArgsFile = join(repoDir, "bd-comment-args.txt");
    const depArgsFile = join(repoDir, "bd-dep-args.txt");

    await writeFile(
      stateFile,
      JSON.stringify(
        [
          {
            id: "bd-42",
            title: "Choose auth provider",
            status: "open",
            labels: ["needs-triage"],
            metadata: { hubStatus: "inbox" },
            description:
              "Pick OAuth vs API keys before implementation can proceed.",
          },
        ],
        null,
        2,
      ),
    );
    await writeFile(updateArgsFile, "");
    await writeFile(commentArgsFile, "");
    await writeFile(depArgsFile, "");

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      createBdScript({
        stateFile,
        updateArgsFile,
        commentArgsFile,
        depArgsFile,
      }),
    );
    await chmod(bdPath, 0o755);

    const proposal: TriageProposal = {
      summary: "One human-owned task.",
      decisions: [
        sampleDecision({
          taskId: "bd-42",
          outcome: "ready_for_human",
          confidence: "high",
          comment: "Needs an architectural decision before agent work.",
        }),
      ],
    };

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;
    process.env.BD_STATE_FILE = stateFile;
    process.env.BD_UPDATE_ARGS_FILE = updateArgsFile;
    process.env.BD_COMMENT_ARGS_FILE = commentArgsFile;
    process.env.BD_DEP_ARGS_FILE = depArgsFile;

    try {
      const result = applyTriageProposal({
        cwd: repoDir,
        proposal,
        decisionsToApply: new Set(["bd-42"]),
        proposalRunId: "run-triage-human",
      });

      expect(result.appliedDecisions).toEqual(["bd-42"]);

      const state = JSON.parse(
        await readFileAsync(stateFile, "utf8"),
      ) as Array<{
        id: string;
        labels?: string[];
        metadata?: { hubStatus?: string };
      }>;
      const task = state.find((entry) => entry.id === "bd-42");
      expect(task?.metadata?.hubStatus).toBe("ready_for_human");
      expect(task?.labels).toContain("ready-for-human");

      const updateArgs = await readFileAsync(updateArgsFile, "utf8");
      expect(updateArgs).toContain("bd-42");
      expect(updateArgs).toContain("--add-label ready-for-human");
      expect(updateArgs).not.toMatch(/--add-label ready-for-agent/);
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
      delete process.env.BD_STATE_FILE;
      delete process.env.BD_UPDATE_ARGS_FILE;
      delete process.env.BD_COMMENT_ARGS_FILE;
      delete process.env.BD_DEP_ARGS_FILE;
    }
  });
});

const createFakeInvoker = (
  finalProposal: TriageProposal,
): ProposalAgentInvoker => {
  const tag = triageProposalOutput().tag;
  return async (input: ProposalAgentInvokeInput) => {
    if (input.phase === "finalization") {
      return {
        assistantMessage: `Approved.\n<${tag}>${JSON.stringify(finalProposal)}</${tag}>`,
      };
    }
    return {
      assistantMessage: "Draft triage recommendations for the selected tasks.",
    };
  };
};

const initRepo = async (dir: string) => {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

describe("runTriageProposalFlow", () => {
  it("auto-applies high-confidence decisions under yes and skips wontfix without confirmation", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "triage-proposal-flow-"));
    await initRepo(hostDir);

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const stateFile = join(hostDir, "bd-state.json");
    const updateArgsFile = join(hostDir, "bd-update-args.txt");
    const commentArgsFile = join(hostDir, "bd-comment-args.txt");
    const depArgsFile = join(hostDir, "bd-dep-args.txt");

    await writeFile(
      stateFile,
      JSON.stringify(
        [
          {
            id: "bd-1",
            title: "Ready task",
            status: "open",
            labels: ["needs-triage"],
            metadata: { hubStatus: "inbox" },
            description: "Ready for AFK implementation.",
          },
          {
            id: "bd-2",
            title: "Duplicate",
            status: "open",
            labels: ["needs-triage"],
            metadata: { hubStatus: "inbox" },
            description: "Duplicate report.",
          },
        ],
        null,
        2,
      ),
    );
    await writeFile(updateArgsFile, "");
    await writeFile(commentArgsFile, "");
    await writeFile(depArgsFile, "");

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      createBdScript({
        stateFile,
        updateArgsFile,
        commentArgsFile,
        depArgsFile,
      }),
    );
    await chmod(bdPath, 0o755);

    const proposal = sampleProposal({
      decisions: [
        sampleDecision({ taskId: "bd-1", confidence: "high" }),
        sampleDecision({
          taskId: "bd-2",
          outcome: "wontfix",
          confidence: "high",
          comment: "Duplicate.",
        }),
      ],
    });

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;
    process.env.BD_STATE_FILE = stateFile;
    process.env.BD_UPDATE_ARGS_FILE = updateArgsFile;
    process.env.BD_COMMENT_ARGS_FILE = commentArgsFile;
    process.env.BD_DEP_ARGS_FILE = depArgsFile;

    try {
      const result = await runTriageProposalFlow({
        cwd: hostDir,
        taskIds: ["bd-1", "bd-2"],
        yes: true,
        agentInvoker: createFakeInvoker(proposal),
        hubAgentConfig: {
          roles: {
            triage: { provider: "cursor", model: "auto" },
          },
        },
      });

      expect(result.outcome).toBe("applied");
      if (result.outcome !== "applied") {
        throw new Error("expected applied triage flow");
      }
      expect(result.appliedDecisions).toEqual(["bd-1"]);
      expect(result.skippedDecisions).toEqual([
        { taskId: "bd-2", reason: "unconfirmed" },
      ]);
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
      delete process.env.BD_STATE_FILE;
      delete process.env.BD_UPDATE_ARGS_FILE;
      delete process.env.BD_COMMENT_ARGS_FILE;
      delete process.env.BD_DEP_ARGS_FILE;
    }
  });

  it("returns cancelled when approval is rejected", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "triage-proposal-cancel-"));
    await initRepo(hostDir);

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify(
        [
          {
            id: "bd-1",
            title: "Ready task",
            status: "open",
            labels: ["needs-triage"],
            metadata: { hubStatus: "inbox" },
            description: "Ready for AFK implementation.",
          },
        ],
        null,
        2,
      ),
    );

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      createBdScript({
        stateFile,
        updateArgsFile: join(hostDir, "update.txt"),
        commentArgsFile: join(hostDir, "comment.txt"),
        depArgsFile: join(hostDir, "dep.txt"),
      }),
    );
    await chmod(bdPath, 0o755);

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;
    process.env.BD_STATE_FILE = stateFile;

    try {
      const result = await runTriageProposalFlow({
        cwd: hostDir,
        taskIds: ["bd-1"],
        approve: false,
        agentInvoker: createFakeInvoker(
          sampleProposal({ decisions: [sampleDecision()] }),
        ),
        hubAgentConfig: {
          roles: {
            triage: { provider: "cursor", model: "auto" },
          },
        },
      });

      expect(result.outcome).toBe("cancelled");
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
      delete process.env.BD_STATE_FILE;
    }
  });

  it("fails validation when finalization references unknown task ids", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "triage-proposal-invalid-"));
    await initRepo(hostDir);

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify(
        [
          {
            id: "bd-1",
            title: "Ready task",
            status: "open",
            labels: ["needs-triage"],
            metadata: { hubStatus: "inbox" },
            description: "Ready for AFK implementation.",
          },
        ],
        null,
        2,
      ),
    );

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      createBdScript({
        stateFile,
        updateArgsFile: join(hostDir, "update.txt"),
        commentArgsFile: join(hostDir, "comment.txt"),
        depArgsFile: join(hostDir, "dep.txt"),
      }),
    );
    await chmod(bdPath, 0o755);

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;
    process.env.BD_STATE_FILE = stateFile;

    try {
      const result = await runTriageProposalFlow({
        cwd: hostDir,
        taskIds: ["bd-1"],
        yes: true,
        agentInvoker: createFakeInvoker(
          sampleProposal({
            decisions: [sampleDecision({ taskId: "bd-999" })],
          }),
        ),
        hubAgentConfig: {
          roles: {
            triage: { provider: "cursor", model: "auto" },
          },
        },
      });

      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") {
        expect(result.reason).toMatch(/unknown task id/i);
      }
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
      delete process.env.BD_STATE_FILE;
    }
  });
});

describe("triage proposal helpers", () => {
  it("prepares context and substitutes draft prompt placeholders", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "triage-proposal-context-"));
    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify(
        [
          {
            id: "bd-1",
            title: "Inbox task",
            status: "open",
            labels: ["needs-triage"],
            metadata: { hubStatus: "inbox", kind: "enhancement" },
            description: "Unique task body marker",
            comments: [{ author: "alice", body: "Needs scope" }],
          },
        ],
        null,
        2,
      ),
    );

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      createBdScript({
        stateFile,
        updateArgsFile: join(hostDir, "update.txt"),
        commentArgsFile: join(hostDir, "comment.txt"),
        depArgsFile: join(hostDir, "dep.txt"),
      }),
    );
    await chmod(bdPath, 0o755);

    const previousPath = process.env.PATH;
    const previousBdPath = process.env.SANDCASTLE_BD_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.SANDCASTLE_BD_PATH = bdPath;
    process.env.BD_STATE_FILE = stateFile;

    try {
      const context = prepareTriageContext({
        cwd: hostDir,
        taskIds: ["bd-1"],
      });
      expect(context.taskQuery).toBe("bd-1");
      expect(context.taskCount).toBe(1);
      expect(context.taskDetails).toContain("Unique task body marker");
      expect(context.hubTaskSummary.totalTasks).toBe(1);

      const prompt = substituteTriageDraftPrompt(
        readHubFlowPrompt("triage", "draft"),
        context,
      );
      expect(prompt).toContain("bd-1");
      expect(prompt).not.toContain("{{TASK_DETAILS}}");
    } finally {
      process.env.PATH = previousPath;
      process.env.SANDCASTLE_BD_PATH = previousBdPath;
      delete process.env.BD_STATE_FILE;
    }
  });

  it("formats proposal lines for display", () => {
    const lines = formatTriageProposalLines(sampleProposal());
    expect(lines.join("\n")).toContain("bd-1");
    expect(lines.join("\n")).toContain("ready_for_agent");
  });
});

describe("resolveProposalSessionApproval", () => {
  it("auto-approves only when yes is true", () => {
    expect(resolveProposalSessionApproval({ yes: true })).toBe(true);
    expect(resolveProposalSessionApproval({ yes: false })).toBeUndefined();
  });
});
