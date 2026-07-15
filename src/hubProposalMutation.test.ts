import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Output } from "./Output.js";
import {
  captureProposalFlowStateSnapshot,
  detectProposalFlowMutations,
  formatProposalFlowMutationLines,
} from "./hubProposalMutation.js";
import {
  runProposalSession,
  type ProposalAgentInvokeInput,
  type ProposalAgentInvokeResult,
  type ProposalAgentInvoker,
} from "./hubProposalSession.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";

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

interface MockBeadsTask {
  id: string;
  title: string;
  status: string;
  labels: string[];
  metadata: Record<string, unknown>;
}

const writeMockBd = async (
  repoDir: string,
  stateFile: string,
  initialTasks: MockBeadsTask[],
) => {
  seedHubTaskStoreMetadata(repoDir);
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = (await execAsync("command -v git")).stdout.trim();
  await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));

  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const args = process.argv.slice(2);
const [command] = args;
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

if (command === "list" && args.includes("--json")) {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
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
      ARCHLOOP_BD_PATH: bdPath,
      BD_STATE_FILE: stateFile,
    },
    stateFile,
  };
};

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

const createFakeInvoker = (
  responses: Partial<
    Record<ProposalAgentInvokeInput["phase"], ProposalAgentInvokeResult>
  >,
  onInvoke?: (input: ProposalAgentInvokeInput) => Promise<void>,
): ProposalAgentInvoker => {
  return async (input) => {
    await onInvoke?.(input);
    const response = responses[input.phase];
    if (!response) {
      throw new Error(`No fake response configured for phase "${input.phase}"`);
    }
    return response;
  };
};

describe("captureProposalFlowStateSnapshot", () => {
  it("captures repository head and working tree state", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-mutation-repo-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    await writeFile(join(repoDir, "dirty.txt"), "dirty");

    const snapshot = captureProposalFlowStateSnapshot({ cwd: repoDir });

    expect(snapshot.repo.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.repo.statusLines).toContain("?? dirty.txt");
  });

  it("captures status without enumerating every nested untracked file", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "proposal-mutation-untracked-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const nestedDir = join(repoDir, "node_modules", "pkg");
    await mkdir(nestedDir, { recursive: true });
    for (let index = 0; index < 50; index += 1) {
      await writeFile(
        join(nestedDir, `file-${index}.js`),
        `export const v = ${index};`,
      );
    }

    const snapshot = captureProposalFlowStateSnapshot({ cwd: repoDir });

    expect(snapshot.repo.statusLines).toEqual(["?? node_modules/"]);
  });

  it("captures local task store state from Beads", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-mutation-beads-"));
    await initRepo(repoDir);
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-1",
        title: "Inbox task",
        status: "open",
        labels: [],
        metadata: {},
      },
    ]);

    const snapshot = captureProposalFlowStateSnapshot({ cwd: repoDir, env });

    expect(snapshot.taskStore.tasks).toEqual([
      {
        id: "bd-1",
        title: "Inbox task",
        status: "open",
        labels: [],
        metadata: {},
      },
    ]);
  });
});

describe("detectProposalFlowMutations", () => {
  it("reports no mutations for identical snapshots", () => {
    const snapshot = {
      repo: { head: "abc", statusLines: [] },
      taskStore: { tasks: [{ id: "bd-1", title: "Task" }] },
    };

    const report = detectProposalFlowMutations(snapshot, snapshot);

    expect(report.hasMutations).toBe(false);
    expect(formatProposalFlowMutationLines(report)).toEqual([]);
  });

  it("reports repository working tree changes", () => {
    const before = {
      repo: { head: "abc", statusLines: [] },
      taskStore: { tasks: [] },
    };
    const after = {
      repo: { head: "abc", statusLines: [" M README.md"] },
      taskStore: { tasks: [] },
    };

    const report = detectProposalFlowMutations(before, after);
    const lines = formatProposalFlowMutationLines(report);

    expect(report.hasMutations).toBe(true);
    expect(report.repoMutations).toHaveLength(1);
    expect(lines.join("\n")).toContain("Repository");
    expect(lines.join("\n")).toContain("README.md");
  });

  it("reports repository commit changes", () => {
    const before = {
      repo: { head: "abc", statusLines: [] },
      taskStore: { tasks: [] },
    };
    const after = {
      repo: { head: "def", statusLines: [] },
      taskStore: { tasks: [] },
    };

    const report = detectProposalFlowMutations(before, after);

    expect(report.hasMutations).toBe(true);
    expect(report.repoMutations[0]?.kind).toBe("head_changed");
    expect(formatProposalFlowMutationLines(report).join("\n")).toContain(
      "commit",
    );
  });

  it("reports local task store changes", () => {
    const before = {
      repo: { head: "abc", statusLines: [] },
      taskStore: {
        tasks: [{ id: "bd-1", title: "Task", status: "open" }],
      },
    };
    const after = {
      repo: { head: "abc", statusLines: [] },
      taskStore: {
        tasks: [
          { id: "bd-1", title: "Task", status: "open" },
          { id: "bd-2", title: "New task", status: "open" },
        ],
      },
    };

    const report = detectProposalFlowMutations(before, after);
    const lines = formatProposalFlowMutationLines(report);

    expect(report.hasMutations).toBe(true);
    expect(report.taskStoreMutations[0]?.addedTaskIds).toEqual(["bd-2"]);
    expect(lines.join("\n")).toContain("task store");
    expect(lines.join("\n")).toContain("bd-2");
  });
});

const createHubProjectDir = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe("runProposalSession mutation detection", () => {
  it("allows clean proposal sessions with no repo or task store mutations", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-clean-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, []);
    const hubProjectDir = await createHubProjectDir("proposal-clean-hub-");

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      env,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: createFakeInvoker({
        draft: { assistantMessage: "Draft proposal" },
        finalization: {
          assistantMessage:
            '<task-proposal>{"title":"Slice one"}</task-proposal>',
        },
      }),
      oneShot: true,
      approve: true,
    });

    expect(result.outcome).toBe("completed");
  });

  it("fails before apply when the repository is mutated and leaves changes in place", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-repo-mutation-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, []);
    const hubProjectDir = await createHubProjectDir(
      "proposal-repo-mutation-hub-",
    );
    const mutatedPath = join(repoDir, "agent-write.txt");
    const presentationEvents: Array<{ phase: string; status: string }> = [];

    const result = await runProposalSession({
      flowId: "prd-decomposition",
      cwd: repoDir,
      hubProjectDir,
      env,
      preparedContext: { prdRef: "docs/prd.md" },
      draftPrompt: "Draft a PRD decomposition proposal.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: createFakeInvoker(
        {
          draft: { assistantMessage: "Draft proposal" },
          finalization: {
            assistantMessage:
              '<task-proposal>{"title":"Slice one"}</task-proposal>',
          },
        },
        async () => {
          await writeFile(mutatedPath, "agent wrote this");
        },
      ),
      oneShot: true,
      approve: true,
      onPresentationEvent: (event) => presentationEvents.push(event),
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") {
      throw new Error("expected failed proposal session");
    }
    expect(result.reason).toContain("mutation");
    expect(result.reason).toContain("agent-write.txt");
    await expect(readFile(mutatedPath, "utf8")).resolves.toBe(
      "agent wrote this",
    );

    const applyResult = JSON.parse(
      await readFile(
        join(result.runDir, "artifacts", "apply-result.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(applyResult.status).toBe("blocked_mutations");
    expect(
      presentationEvents.map(({ phase, status }) => [phase, status]),
    ).toContainEqual(["mutation_detection", "failed"]);
    expect(
      presentationEvents
        .filter(({ phase }) => phase === "finalization")
        .map(({ status }) => status),
    ).toEqual(["started", "completed"]);
  });

  it("fails before apply when the local task store is mutated and leaves changes in place", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "proposal-beads-mutation-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, []);
    const hubProjectDir = await createHubProjectDir(
      "proposal-beads-mutation-hub-",
    );

    const result = await runProposalSession({
      flowId: "triage",
      cwd: repoDir,
      hubProjectDir,
      env,
      preparedContext: { query: "inbox" },
      draftPrompt: "Draft triage recommendations.",
      finalizationPrompt: "Emit the final task proposal.",
      output: Output.object({
        tag: "task-proposal",
        schema: testProposalSchema(),
      }),
      agentInvoker: createFakeInvoker(
        {
          draft: { assistantMessage: "Draft proposal" },
          finalization: {
            assistantMessage:
              '<task-proposal>{"title":"Triage one"}</task-proposal>',
          },
        },
        async () => {
          await writeFile(
            stateFile,
            JSON.stringify(
              [
                {
                  id: "bd-new",
                  title: "Agent created task",
                  status: "open",
                  labels: [],
                  metadata: {},
                },
              ],
              null,
              2,
            ),
          );
        },
      ),
      oneShot: true,
      approve: true,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") {
      throw new Error("expected failed proposal session");
    }
    expect(result.reason).toContain("mutation");
    expect(result.reason).toContain("bd-new");

    const finalState = JSON.parse(await readFile(stateFile, "utf8")) as Array<{
      id: string;
    }>;
    expect(finalState.map((task) => task.id)).toEqual(["bd-new"]);

    const applyResult = JSON.parse(
      await readFile(
        join(result.runDir, "artifacts", "apply-result.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(applyResult.status).toBe("blocked_mutations");
  });
});
