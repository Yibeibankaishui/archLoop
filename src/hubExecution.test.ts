import { exec } from "node:child_process";
import { readFile, mkdir, mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { claimHubTask } from "./taskBoard.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";
import { createHubRunContext, resolveHubRunDirectory } from "./hubExecution.js";

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

const readJsonl = async (path: string): Promise<unknown[]> => {
  const content = await readFile(path, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
};

describe("Hub run storage", () => {
  it("creates run and batch event records in the Hub run directory", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-run-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "abc",
    );
    const context = createHubRunContext({
      cwd: repoDir,
      hubProjectDir,
      branch: "feature/issue-69",
    });

    expect(context.runId).toMatch(/^run-/);
    expect(context.batchId).toMatch(/^batch-/);
    expect(resolveHubRunDirectory(hubProjectDir, context.runId)).toBe(
      context.runDir,
    );

    const runEvents = await readJsonl(join(context.eventsDir, "run.jsonl"));
    const batchEvents = await readJsonl(join(context.eventsDir, "batch.jsonl"));

    expect(runEvents[0]).toMatchObject({
      type: "run_started",
      branch: "feature/issue-69",
      runId: context.runId,
    });
    expect(batchEvents[0]).toMatchObject({
      type: "batch_started",
      branch: "feature/issue-69",
      runId: context.runId,
      batchId: context.batchId,
    });
  });
});

describe("task claims", () => {
  it("claims a ready task, writes claim metadata, and records task events", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-claim-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { stdout: baseHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });
    seedHubTaskStoreMetadata(repoDir);

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
            id: "bd-69",
            title: "Claim me",
            status: "open",
            labels: ["ready-for-agent"],
            metadata: {},
          },
        ],
        null,
        2,
      ),
    );

    const argsFile = join(repoDir, "bd-args.txt");
    await writeFile(argsFile, "");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const argsFile = process.env.BD_ARGS_FILE;
const args = process.argv.slice(2);
const [command, id] = args;
if (command === "show" && id === "bd-69") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
if (command === "update" && id === "bd-69") {
  fs.writeFileSync(argsFile, args.join("\\n"));
  const metadataIndex = args.indexOf("--metadata");
  const statusIndex = args.indexOf("--status");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state[0].status = args[statusIndex + 1];
  state[0].metadata = {
    ...state[0].metadata,
    ...JSON.parse(args[metadataIndex + 1]),
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      state[0].labels = [];
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      const label = args[index + 1];
      if (!state[0].labels.includes(label)) state[0].labels.push(label);
    }
    if (args[index] === "--unset-metadata") {
      delete state[0].metadata[args[index + 1]];
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "abc",
    );
    const result = await claimHubTask({
      cwd: repoDir,
      taskId: "bd-69",
      branch: "feature/issue-69",
      hubProjectDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: bdPath,
        BD_STATE_FILE: stateFile,
        BD_ARGS_FILE: argsFile,
      },
    });

    const args = await readFile(argsFile, "utf-8");
    expect(args).toContain("update");
    expect(args).toContain("bd-69");
    expect(args).toContain("--status");
    expect(args).toContain("in_progress");
    expect(args).toContain("--metadata");
    expect(result.outcome).toBe("claimed");
    expect(result.task.hubStatus).toBe("implementing");
    expect(result.task.claimState).toBe("active");
    expect(result.task.claim).toMatchObject({
      runId: result.runId,
      batchId: result.batchId,
      taskId: "bd-69",
      branch: "feature/issue-69",
      baseHead: baseHead.trim(),
      branchExistedBeforeClaim: false,
    });

    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents[0]).toMatchObject({
      type: "task_claimed",
      taskId: "bd-69",
      runId: result.runId,
      batchId: result.batchId,
      claim: {
        taskId: "bd-69",
        runId: result.runId,
        batchId: result.batchId,
        branch: "feature/issue-69",
        baseHead: baseHead.trim(),
        branchExistedBeforeClaim: false,
      },
    });
  });

  it("records when the branch already existed before claim", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-claim-existing-branch-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { stdout: baseHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });
    await execAsync("git branch feature/existing-branch", { cwd: repoDir });
    seedHubTaskStoreMetadata(repoDir);

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
            id: "bd-71",
            title: "Claim existing branch",
            status: "open",
            labels: ["ready-for-agent"],
            metadata: {},
          },
        ],
        null,
        2,
      ),
    );

    const argsFile = join(repoDir, "bd-args-existing.txt");
    await writeFile(argsFile, "");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const args = process.argv.slice(2);
const [command, id] = args;
if (command === "show" && id === "bd-71") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
if (command === "update" && id === "bd-71") {
  const metadataIndex = args.indexOf("--metadata");
  const statusIndex = args.indexOf("--status");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state[0].status = args[statusIndex + 1];
  state[0].metadata = {
    ...state[0].metadata,
    ...JSON.parse(args[metadataIndex + 1]),
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      state[0].labels = [];
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      const label = args[index + 1];
      if (!state[0].labels.includes(label)) state[0].labels.push(label);
    }
    if (args[index] === "--unset-metadata") {
      delete state[0].metadata[args[index + 1]];
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "abc",
    );
    const result = await claimHubTask({
      cwd: repoDir,
      taskId: "bd-71",
      branch: "feature/existing-branch",
      hubProjectDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: bdPath,
        BD_STATE_FILE: stateFile,
      },
    });

    expect(result.outcome).toBe("claimed");
    expect(result.task.claim).toMatchObject({
      taskId: "bd-71",
      baseHead: baseHead.trim(),
      branchExistedBeforeClaim: true,
    });
    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents[0]).toMatchObject({
      type: "task_claimed",
      taskId: "bd-71",
      claim: {
        taskId: "bd-71",
        baseHead: baseHead.trim(),
        branchExistedBeforeClaim: true,
      },
    });
  });

  it("skips tasks with an active claim and records the skip event", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-claim-skip-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    seedHubTaskStoreMetadata(repoDir);

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
            id: "bd-70",
            title: "Already claimed",
            status: "in_progress",
            labels: ["implementing"],
            metadata: {
              claim: {
                runId: "run-existing",
                batchId: "batch-existing",
                branch: "feature/other",
                claimedAt: "2026-06-11T15:30:00Z",
              },
            },
          },
        ],
        null,
        2,
      ),
    );

    const argsFile = join(repoDir, "bd-args-skip.txt");
    await writeFile(argsFile, "");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const argsFile = process.env.BD_ARGS_FILE;
const args = process.argv.slice(2);
const [command, id] = args;
if (command === "show" && id === "bd-70") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
if (command === "update" && id === "bd-70") {
  fs.writeFileSync(argsFile, args.join("\\n"));
  process.exit(1);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const hubProjectDir = join(
      repoDir,
      "data",
      "archloop",
      "hub",
      "projects",
      "abc",
    );
    const result = await claimHubTask({
      cwd: repoDir,
      taskId: "bd-70",
      branch: "feature/issue-69",
      hubProjectDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: bdPath,
        BD_STATE_FILE: stateFile,
        BD_ARGS_FILE: argsFile,
      },
    });

    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("active_claim");
    expect(await readFile(argsFile, "utf-8")).toBe("");
    const taskEvents = await readJsonl(
      join(result.runDir, "events", "task.jsonl"),
    );
    expect(taskEvents[0]).toMatchObject({
      type: "task_claim_skipped",
      taskId: "bd-70",
      reason: "active_claim",
    });
  });
});
