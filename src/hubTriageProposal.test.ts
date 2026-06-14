import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { extractStructuredOutput } from "./extractStructuredOutput.js";
import {
  HUB_TRIAGE_COMMENT_PREFIX,
  HUB_TRIAGE_DEFAULT_TASK_QUERY,
} from "./hubTriage.js";
import type {
  ProposalAgentInvokeInput,
  ProposalAgentInvokeResult,
  ProposalAgentInvoker,
} from "./hubProposalSession.js";
import {
  applyTriageProposal,
  createTriageProposalOutput,
  filterTriageProposalForYes,
  formatBlockedTriageReason,
  isSafeTriageDecisionForYes,
  prepareTriageProposalContext,
  validateTriageProposalAgainstContext,
  type TriageProposal,
  type TriageTaskRecommendation,
} from "./hubTriageProposal.js";
import { runTriageProposalFlow } from "./hubTriageProposalFlow.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const recommendation = (
  overrides: Partial<TriageTaskRecommendation> &
    Pick<TriageTaskRecommendation, "taskId" | "outcome">,
): TriageTaskRecommendation => ({
  confidence: "high",
  rationale: "Ready for AFK implementation.",
  comment: "Ready for agent implementation.",
  ...overrides,
});

const sampleProposal = (
  recommendations: readonly TriageTaskRecommendation[],
): TriageProposal => ({
  taskQuery: HUB_TRIAGE_DEFAULT_TASK_QUERY,
  recommendations,
});

const createFakeInvoker = (
  finalProposal: TriageProposal,
): ProposalAgentInvoker => {
  const payload = JSON.stringify(finalProposal);
  return async (
    input: ProposalAgentInvokeInput,
  ): Promise<ProposalAgentInvokeResult> => {
    if (input.phase === "draft") {
      return { assistantMessage: "Draft triage recommendations." };
    }
    return {
      assistantMessage: `<triage-proposal>${payload}</triage-proposal>`,
    };
  };
};

const setupBdMock = async (repoDir: string) => {
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  const stateFile = join(repoDir, "bd-state.json");
  await writeFile(
    stateFile,
    JSON.stringify(
      [
        {
          id: "bd-inbox",
          title: "Add retry to sync",
          status: "open",
          labels: ["needs-triage"],
          metadata: { origin: "manual" },
          description:
            "When sync-out fails with ECONNRESET, retry up to three times before surfacing an error.",
        },
        {
          id: "bd-needs-info",
          title: "Clarify API shape",
          status: "open",
          labels: ["needs-info"],
          metadata: {},
          description:
            "Add pagination to the tasks list endpoint with cursor support and stable ordering.",
        },
        {
          id: "bd-wontfix",
          title: "Duplicate of issue 12",
          status: "open",
          labels: ["needs-triage"],
          metadata: {},
          description: "Duplicate report; mark wontfix.",
        },
        {
          id: "bd-ready",
          title: "Already ready",
          status: "open",
          labels: ["ready-for-agent"],
          metadata: {},
          description: "Already triaged.",
        },
      ],
      null,
      2,
    ),
  );

  const updateArgsFile = join(repoDir, "bd-update-args.txt");
  const commentArgsFile = join(repoDir, "bd-comment-args.txt");
  const depArgsFile = join(repoDir, "bd-dep-args.txt");
  await writeFile(updateArgsFile, "");
  await writeFile(commentArgsFile, "");
  await writeFile(depArgsFile, "");

  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
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
  const metadataIndex = args.indexOf("--set-metadata");
  if (metadataIndex >= 0) {
    task.metadata = JSON.parse(args[metadataIndex + 1]);
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--add-labels") {
      const label = args[index + 1];
      task.labels = [...new Set([...(task.labels ?? []), label])];
    }
    if (args[index] === "--remove-labels") {
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

if (command === "dep") {
  fs.appendFileSync(depArgsFile, args.join(" ") + "\\n");
  process.exit(0);
}

process.exit(1);
`,
  );
  await chmod(bdPath, 0o755);

  return {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      BD_STATE_FILE: stateFile,
      BD_UPDATE_ARGS_FILE: updateArgsFile,
      BD_COMMENT_ARGS_FILE: commentArgsFile,
      BD_DEP_ARGS_FILE: depArgsFile,
    },
    updateArgsFile,
    commentArgsFile,
    depArgsFile,
  };
};

describe("triage proposal schema", () => {
  it("validates structured triage proposals", async () => {
    const proposal = sampleProposal([
      recommendation({
        taskId: "bd-inbox",
        outcome: "ready_for_agent",
      }),
    ]);

    const parsed = await extractStructuredOutput(
      `<triage-proposal>${JSON.stringify(proposal)}</triage-proposal>`,
      createTriageProposalOutput(),
      { commits: [], branch: "proposal/triage" },
    );

    expect(parsed).toEqual(proposal);
  });

  it("rejects proposals with unknown task ids against prepared context", () => {
    expect(() =>
      validateTriageProposalAgainstContext(
        sampleProposal([
          recommendation({ taskId: "missing", outcome: "ready_for_agent" }),
        ]),
        {
          flowId: "triage",
          taskQuery: HUB_TRIAGE_DEFAULT_TASK_QUERY,
          tasks: [],
        },
      ),
    ).toThrow(/unknown task/i);
  });
});

describe("triage proposal yes filtering", () => {
  it("allows only high-confidence non-closing low-risk decisions", () => {
    expect(
      isSafeTriageDecisionForYes(
        recommendation({
          taskId: "bd-1",
          outcome: "ready_for_agent",
          confidence: "high",
        }),
      ),
    ).toBe(true);
    expect(
      isSafeTriageDecisionForYes(
        recommendation({
          taskId: "bd-2",
          outcome: "needs_info",
          confidence: "high",
        }),
      ),
    ).toBe(true);
    expect(
      isSafeTriageDecisionForYes(
        recommendation({
          taskId: "bd-3",
          outcome: "wontfix",
          confidence: "high",
        }),
      ),
    ).toBe(false);
    expect(
      isSafeTriageDecisionForYes(
        recommendation({
          taskId: "bd-4",
          outcome: "ready_for_human",
          confidence: "high",
        }),
      ),
    ).toBe(false);
    expect(
      isSafeTriageDecisionForYes(
        recommendation({
          taskId: "bd-5",
          outcome: "ready_for_agent",
          confidence: "medium",
        }),
      ),
    ).toBe(false);
    expect(
      isSafeTriageDecisionForYes(
        recommendation({
          taskId: "bd-6",
          outcome: "ready_for_agent",
          confidence: "high",
          dependencyChanges: [
            {
              action: "add",
              dependentTaskId: "bd-6",
              blockerTaskId: "bd-1",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("blocks wontfix, dependency, and medium-confidence decisions for --yes", () => {
    const filtered = filterTriageProposalForYes(
      sampleProposal([
        recommendation({ taskId: "bd-safe", outcome: "ready_for_agent" }),
        recommendation({ taskId: "bd-wontfix", outcome: "wontfix" }),
        recommendation({
          taskId: "bd-medium",
          outcome: "needs_info",
          confidence: "medium",
        }),
      ]),
    );

    expect(
      filtered.proposal.recommendations.map((entry) => entry.taskId),
    ).toEqual(["bd-safe"]);
    expect(filtered.blocked).toEqual([
      {
        taskId: "bd-wontfix",
        reason: formatBlockedTriageReason(
          recommendation({ taskId: "bd-wontfix", outcome: "wontfix" }),
        ),
      },
      {
        taskId: "bd-medium",
        reason: formatBlockedTriageReason(
          recommendation({
            taskId: "bd-medium",
            outcome: "needs_info",
            confidence: "medium",
          }),
        ),
      },
    ]);
  });
});

describe("applyTriageProposal", () => {
  it("applies status transitions, labels, comments with disclaimer, and dependencies", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "triage-proposal-apply-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { env, updateArgsFile, commentArgsFile, depArgsFile } =
      await setupBdMock(repoDir);

    const result = applyTriageProposal({
      cwd: repoDir,
      runId: "run-123",
      env,
      allowRiskyDecisions: true,
      proposal: sampleProposal([
        recommendation({
          taskId: "bd-inbox",
          outcome: "ready_for_agent",
          labels: ["enhancement"],
          comment: "Ready for AFK agent implementation.",
        }),
        recommendation({
          taskId: "bd-needs-info",
          outcome: "needs_info",
          comment: "Need the expected response schema.",
        }),
        recommendation({
          taskId: "bd-wontfix",
          outcome: "wontfix",
          comment: "Duplicate report.",
          dependencyChanges: [
            {
              action: "add",
              dependentTaskId: "bd-inbox",
              blockerTaskId: "bd-needs-info",
            },
          ],
        }),
      ]),
    });

    expect(result.applied.map((entry) => entry.taskId).sort()).toEqual([
      "bd-inbox",
      "bd-needs-info",
      "bd-wontfix",
    ]);

    const updateArgs = await readFile(updateArgsFile, "utf-8");
    expect(updateArgs).toContain("bd-inbox");
    expect(updateArgs).toContain("--add-labels ready-for-agent");
    expect(updateArgs).toContain("--add-labels enhancement");
    expect(updateArgs).toContain("bd-wontfix");
    expect(updateArgs).toContain("--status closed");

    const commentArgs = await readFile(commentArgsFile, "utf-8");
    expect(commentArgs).toContain(HUB_TRIAGE_COMMENT_PREFIX);
    expect(
      (commentArgs.match(/This was generated by AI during triage/g) ?? [])
        .length,
    ).toBe(3);

    const depArgs = await readFile(depArgsFile, "utf-8");
    expect(depArgs).toContain("add bd-inbox bd-needs-info");
  });

  it("applies only safe recommendations in --yes mode and reports blocked decisions", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "triage-proposal-yes-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { env, updateArgsFile } = await setupBdMock(repoDir);

    const result = applyTriageProposal({
      cwd: repoDir,
      runId: "run-yes",
      env,
      yesMode: true,
      proposal: sampleProposal([
        recommendation({ taskId: "bd-inbox", outcome: "ready_for_agent" }),
        recommendation({ taskId: "bd-wontfix", outcome: "wontfix" }),
      ]),
    });

    expect(result.applied).toEqual([
      { taskId: "bd-inbox", outcome: "ready_for_agent" },
    ]);
    expect(result.blocked).toEqual([
      {
        taskId: "bd-wontfix",
        reason: "wontfix requires explicit confirmation",
      },
    ]);

    const updateArgs = await readFile(updateArgsFile, "utf-8");
    expect(updateArgs).toContain("bd-inbox");
    expect(updateArgs).not.toContain("bd-wontfix");
  });
});

describe("runTriageProposalFlow", () => {
  it("runs a proposal session with fake agent output and applies approved recommendations", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "triage-proposal-flow-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { env, updateArgsFile, commentArgsFile } = await setupBdMock(repoDir);

    const finalProposal = sampleProposal([
      recommendation({ taskId: "bd-inbox", outcome: "ready_for_agent" }),
      recommendation({ taskId: "bd-needs-info", outcome: "needs_info" }),
    ]);

    const result = await runTriageProposalFlow({
      cwd: repoDir,
      taskQuery: HUB_TRIAGE_DEFAULT_TASK_QUERY,
      env,
      agentInvoker: createFakeInvoker(finalProposal),
      approve: true,
      oneShot: true,
      allowRiskyDecisions: true,
    });

    expect(result.session.outcome).toBe("completed");
    expect(result.apply?.applied).toHaveLength(2);
    expect(result.preparedContext.tasks.map((task) => task.id).sort()).toEqual([
      "bd-inbox",
      "bd-needs-info",
      "bd-wontfix",
    ]);

    const updateArgs = await readFile(updateArgsFile, "utf-8");
    const commentArgs = await readFile(commentArgsFile, "utf-8");
    expect(updateArgs).toContain("bd-inbox");
    expect(updateArgs).toContain("bd-needs-info");
    expect(commentArgs).toContain(HUB_TRIAGE_COMMENT_PREFIX);
  });
});
