import { exec } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Output } from "./Output.js";
import { ProposalPromptCancelledError } from "./errors.js";
import {
  runProposalSession,
  type ProposalAgentInvokeInput,
  type ProposalAgentInvokeResult,
  type ProposalAgentInvoker,
} from "./hubProposalSession.js";

interface TestProposal {
  readonly title: string;
}

const testProposalSchema = (): StandardSchemaV1<unknown, TestProposal> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => {
      if (typeof value !== "object" || value === null) {
        return { issues: [{ message: "Expected an object" }] };
      }
      const title = (value as { title?: unknown }).title;
      if (typeof title !== "string" || title.trim().length === 0) {
        return { issues: [{ message: "title is required" }] };
      }
      return { value: { title } };
    },
  },
});

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const readJsonl = async (path: string): Promise<unknown[]> => {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
};

const createFakeInvoker = (
  responses: Partial<
    Record<ProposalAgentInvokeInput["phase"], ProposalAgentInvokeResult>
  >,
): { invoker: ProposalAgentInvoker; calls: ProposalAgentInvokeInput[] } => {
  const calls: ProposalAgentInvokeInput[] = [];
  const invoker: ProposalAgentInvoker = async (input) => {
    calls.push(input);
    const response = responses[input.phase];
    if (!response) {
      throw new Error(`No fake response configured for phase "${input.phase}"`);
    }
    return response;
  };
  return { invoker, calls };
};

const createHubProjectDir = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe("runProposalSession", () => {
  it("emits canonical presentation phases without exposing agent prose", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-session-events-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-session-events-hub-",
    );
    const events: Array<{
      phase: string;
      status: string;
      assistantMessage?: string;
    }> = [];
    const { invoker } = createFakeInvoker({
      draft: { assistantMessage: "Private draft prose" },
      finalization: {
        assistantMessage:
          '<task-proposal>{"title":"Slice one"}</task-proposal>',
      },
    });

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a proposal.",
      finalizationPrompt: "Finalize the proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invoker,
      oneShot: true,
      approve: true,
      onPresentationEvent: (event) => events.push(event),
    });

    expect(result.outcome).toBe("completed");
    expect(events.map(({ phase, status }) => [phase, status])).toEqual([
      ["input_preparation", "completed"],
      ["draft", "started"],
      ["draft", "completed"],
      ["finalization", "started"],
      ["finalization", "completed"],
      ["mutation_detection", "started"],
      ["mutation_detection", "completed"],
      ["approval", "started"],
      ["approval", "completed"],
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ assistantMessage: expect.anything() }),
    );
  });

  it("runs an initial draft turn from prepared context and persists artifacts", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-session-draft-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-session-draft-hub-",
    );

    const { invoker, calls } = createFakeInvoker({
      draft: { assistantMessage: "Draft proposal summary" },
      finalization: {
        assistantMessage:
          'Approved.\n<task-proposal>{"title":"Slice one"}</task-proposal>',
      },
    });

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { prdRef: "docs/prd.md", summary: "Build feature" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invoker,
      oneShot: true,
      approve: true,
    });

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") {
      throw new Error("expected completed proposal session");
    }
    expect(result.finalProposal).toEqual({ title: "Slice one" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.phase).toBe("draft");
    expect(calls[0]?.preparedContext).toEqual({
      prdRef: "docs/prd.md",
      summary: "Build feature",
    });

    const preparedContext = await readJson<Record<string, unknown>>(
      join(result.runDir, "artifacts", "prepared-context.json"),
    );
    const transcript = await readJson<
      Array<{ role: string; content: string; phase?: string }>
    >(join(result.runDir, "artifacts", "transcript.json"));
    const finalProposal = await readJson<TestProposal>(
      join(result.runDir, "artifacts", "final-proposal.json"),
    );
    const applyResult = await readJson<{ status: string }>(
      join(result.runDir, "artifacts", "apply-result.json"),
    );
    const events = await readJsonl(
      join(result.runDir, "events", "proposal.jsonl"),
    );

    expect(preparedContext).toEqual({
      prdRef: "docs/prd.md",
      summary: "Build feature",
    });
    expect(transcript.map((turn) => turn.role)).toEqual(["assistant"]);
    expect(transcript[0]?.phase).toBe("draft");
    expect(finalProposal).toEqual({ title: "Slice one" });
    expect(applyResult).toEqual({ status: "pending" });
    expect(
      events.some(
        (event) => (event as { type?: string }).type === "session_started",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => (event as { type?: string }).type === "draft_succeeded",
      ),
    ).toBe(true);
  });

  it("appends user refinement turns and invokes the agent with transcript context", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-session-refine-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-session-refine-hub-",
    );

    const { invoker, calls } = createFakeInvoker({
      draft: { assistantMessage: "Initial draft" },
      refinement: { assistantMessage: "Refined draft after split" },
      finalization: {
        assistantMessage:
          '<task-proposal>{"title":"Split slice"}</task-proposal>',
      },
    });

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invoker,
      refinements: ["Please split slice two into smaller tasks"],
      approve: true,
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toHaveLength(3);
    expect(calls[1]?.phase).toBe("refinement");
    expect(calls[1]?.transcript.at(-2)).toMatchObject({
      role: "user",
      content: "Please split slice two into smaller tasks",
      phase: "refinement",
    });
    expect(calls[1]?.prompt).toContain(
      "Please split slice two into smaller tasks",
    );
    expect(calls[1]?.prompt).toContain("Initial draft");

    const transcript = await readJson<
      Array<{ role: string; content: string; phase?: string }>
    >(join(result.runDir, "artifacts", "transcript.json"));
    expect(transcript.map((turn) => [turn.role, turn.phase])).toEqual([
      ["assistant", "draft"],
      ["user", "refinement"],
      ["assistant", "refinement"],
    ]);
  });

  it("notifies interaction hooks after draft and refinement turns", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-session-notify-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-session-notify-hub-",
    );
    const notifications: string[] = [];

    const { invoker } = createFakeInvoker({
      draft: { assistantMessage: "Initial draft" },
      refinement: { assistantMessage: "Refined draft" },
      finalization: {
        assistantMessage:
          '<task-proposal>{"title":"Slice one"}</task-proposal>',
      },
    });

    await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invoker,
      refinements: ["Split slice two"],
      interaction: {
        onAssistantMessage: async (input) => {
          notifications.push(`${input.phase}:${input.message}`);
        },
      },
      approve: true,
    });

    expect(notifications).toEqual([
      "draft:Initial draft",
      "refinement:Refined draft",
    ]);
  });

  it("continues to approval when refinement is skipped", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-session-skip-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-session-skip-hub-",
    );

    const { invoker, calls } = createFakeInvoker({
      draft: { assistantMessage: "Initial draft" },
      finalization: {
        assistantMessage:
          '<task-proposal>{"title":"Slice one"}</task-proposal>',
      },
    });

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invoker,
      interaction: {
        requestRefinement: async () => null,
        requestApproval: async (_proposal) => true,
      },
    });

    expect(result.outcome).toBe("completed");
    expect(calls.map((call) => call.phase)).toEqual(["draft", "finalization"]);
  });

  it("fails when final structured output is missing or invalid", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-session-invalid-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-session-invalid-hub-",
    );

    const missingTagInvoker = createFakeInvoker({
      draft: { assistantMessage: "Draft only" },
      finalization: { assistantMessage: "No structured tag here" },
    }).invoker;

    const missingTagResult = await runProposalSession({
      flowId: "triage",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { query: "inbox" },
      draftPrompt: "Draft triage recommendations.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: missingTagInvoker,
      oneShot: true,
      approve: true,
    });

    expect(missingTagResult.outcome).toBe("failed");
    if (missingTagResult.outcome !== "failed") {
      throw new Error("expected failed proposal session");
    }
    expect(missingTagResult.reason).toContain("task-proposal");

    const invalidJsonInvoker = createFakeInvoker({
      draft: { assistantMessage: "Draft only" },
      finalization: {
        assistantMessage: "<task-proposal>not-json</task-proposal>",
      },
    }).invoker;

    const invalidJsonResult = await runProposalSession({
      flowId: "triage",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { query: "inbox" },
      draftPrompt: "Draft triage recommendations.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invalidJsonInvoker,
      oneShot: true,
      approve: true,
    });

    expect(invalidJsonResult.outcome).toBe("failed");
    if (invalidJsonResult.outcome !== "failed") {
      throw new Error("expected failed proposal session");
    }
    expect(invalidJsonResult.reason).toContain("invalid JSON");

    await expect(
      readFile(
        join(missingTagResult.runDir, "artifacts", "final-proposal.json"),
        "utf8",
      ),
    ).rejects.toThrow();
    await expect(
      readFile(
        join(missingTagResult.runDir, "artifacts", "apply-result.json"),
        "utf8",
      ),
    ).rejects.toThrow();

    const events = await readJsonl(
      join(missingTagResult.runDir, "events", "proposal.jsonl"),
    );
    expect(
      events.some(
        (event) => (event as { type?: string }).type === "finalization_failed",
      ),
    ).toBe(true);
  });

  it("cancels the session when approval is rejected", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-session-cancel-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-session-cancel-hub-",
    );

    const { invoker, calls } = createFakeInvoker({
      draft: { assistantMessage: "Draft proposal" },
      finalization: {
        assistantMessage:
          '<task-proposal>{"title":"Slice one"}</task-proposal>',
      },
    });

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invoker,
      oneShot: true,
      approve: false,
    });

    expect(result.outcome).toBe("cancelled");
    expect(calls.map((call) => call.phase)).toEqual(["draft", "finalization"]);
    const finalProposal = await readFile(
      join(result.runDir, "artifacts", "final-proposal.json"),
      "utf8",
    );
    expect(finalProposal).toContain("Slice one");

    const events = await readJsonl(
      join(result.runDir, "events", "proposal.jsonl"),
    );
    expect(
      events.some(
        (event) => (event as { type?: string }).type === "session_cancelled",
      ),
    ).toBe(true);
  });

  it("turns refinement prompt cancellation into a canonical cancelled session", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-refine-cancel-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-refine-cancel-hub-",
    );
    const presentationEvents: Array<{ phase: string; status: string }> = [];
    const { invoker } = createFakeInvoker({
      draft: { assistantMessage: "Draft proposal" },
    });

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invoker,
      interaction: {
        requestRefinement: async () => {
          throw new ProposalPromptCancelledError({
            message: "Refinement cancelled.",
          });
        },
      },
      onPresentationEvent: (event) => presentationEvents.push(event),
    });

    expect(result).toMatchObject({
      outcome: "cancelled",
      phase: "refinement",
    });
    expect(presentationEvents.at(-1)).toEqual(
      expect.objectContaining({ phase: "refinement", status: "cancelled" }),
    );
  });

  it("turns approval prompt cancellation into exit-safe cancellation", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-approval-cancel-"));
    await initRepo(repoDir);
    const hubProjectDir = await createHubProjectDir(
      "proposal-approval-cancel-hub-",
    );
    const presentationEvents: Array<{ phase: string; status: string }> = [];
    const { invoker } = createFakeInvoker({
      draft: { assistantMessage: "Draft proposal" },
      finalization: {
        assistantMessage:
          '<task-proposal>{"title":"Slice one"}</task-proposal>',
      },
    });

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: invoker,
      interaction: {
        requestRefinement: async () => null,
        requestApproval: async () => {
          throw new ProposalPromptCancelledError({
            message: "Approval cancelled.",
          });
        },
      },
      onPresentationEvent: (event) => presentationEvents.push(event),
    });

    expect(result).toMatchObject({
      outcome: "cancelled",
      phase: "approval",
    });
    expect(presentationEvents.at(-1)).toEqual(
      expect.objectContaining({ phase: "approval", status: "cancelled" }),
    );
  });
});
