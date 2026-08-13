import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { createHubFlowRunImplementer } from "./hubFlowExecution.js";
import { resolveHubProjectDevelopmentContractState } from "./hubProjectDevelopmentContract.js";
import * as runModule from "./run.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";
import { loadHubTask } from "./taskBoard.js";
import { HUB_TASK_NOTES_TAG } from "./hubTaskSnapshot.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const writeMockBd = async (
  repoDir: string,
  stateFile: string,
  initialTasks: readonly Record<string, unknown>[],
) => {
  seedHubTaskStoreMetadata(repoDir);
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));
  const commentsFile = join(repoDir, ".beads", "bd-comments.txt");
  await writeFile(commentsFile, "");
  const bdPath = join(binDir, "bd");
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const commentsFile = process.env.BD_COMMENT_ARGS_FILE;
const args = process.argv.slice(2);
const [command, id] = args;
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const findTask = (state, taskId) => state.find((task) => task.id === taskId);

if (command === "show" && id) {
  const task = findTask(readState(), id);
  if (!task) process.exit(1);
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "dep") {
  process.stdout.write("[]");
  process.exit(0);
}

if (command === "update" && id) {
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = { ...task.metadata, ...JSON.parse(args[metadataIndex + 1]) };
  }
  writeState(state);
  process.exit(0);
}

if (command === "comments" && id === "add") {
  const taskId = args[2];
  const body = args.slice(3).join(" ");
  fs.appendFileSync(commentsFile, body + "\\n");
  const state = readState();
  const task = findTask(state, taskId);
  if (task) {
    task.comments = task.comments ?? [];
    task.comments.push({ body });
    writeState(state);
  }
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
      BD_COMMENT_ARGS_FILE: commentsFile,
    },
  };
};

describe("Hub flow snapshot notes", () => {
  it("applies implementer task notes after the attempt and ignores invalid notes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hub-flow-snapshot-notes-"));
    await initRepo(cwd);
    const stateFile = join(cwd, "bd-state.json");
    const { env } = await writeMockBd(cwd, stateFile, [
      {
        id: "bd-1",
        title: "Snapshot notes",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {},
        comments: [],
      },
    ]);
    const runDir = join(cwd, "run");
    await mkdir(join(runDir, "logs"), { recursive: true });
    const projectDevelopmentContract =
      resolveHubProjectDevelopmentContractState({
        repoRoot: cwd,
        hubProjectDir: join(cwd, "hub-project"),
        now: new Date("2026-08-13T12:00:00.000Z"),
      });

    const runSpy = vi.spyOn(runModule, "run").mockResolvedValue({
      completionSignal: "<promise>COMPLETE</promise>",
      commits: [{ sha: "abc123" }],
      branch: "archloop/bd-1-snapshot-notes",
      iterations: [],
      stdout: `<${HUB_TASK_NOTES_TAG}>{"schemaVersion":1,"taskId":"bd-1","comments":["left a note"]}</${HUB_TASK_NOTES_TAG}>`,
    });
    const implementer = createHubFlowRunImplementer({
      cwd,
      env: { ...env, OPENAI_KEY: "test-openai-key" },
      roleEntry: { provider: "codex", model: "gpt-5.4-mini" },
    });

    vi.stubEnv("OPENAI_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      const result = await implementer({
        flowId: "no-review",
        batchId: "batch-test",
        taskId: "bd-1",
        title: "Snapshot notes",
        branch: "archloop/bd-1-snapshot-notes",
        promptFile: "/tmp/prompt.md",
        cwd,
        runDir,
        projectDevelopmentContract,
      });
      expect(result.outcome).toBe("success");
      expect(runSpy.mock.calls[0]?.[0].promptArgs?.TASK_SNAPSHOT).toContain(
        "Snapshot notes",
      );
      expect(runSpy.mock.calls[0]?.[0].promptArgs).not.toHaveProperty(
        "VIEW_TASK_COMMAND",
      );

      const task = loadHubTask(cwd, "bd-1", env);
      expect(task.comments.map((comment) => comment.body)).toContain(
        "left a note",
      );
    } finally {
      runSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
