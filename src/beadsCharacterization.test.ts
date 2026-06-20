import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { resolveBundledBdExecutable } from "./resolveBdExecutable.js";
import { loadHubTaskBoard } from "./taskBoard.js";

const execFileAsync = promisify(execFile);

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface RealBeadsRepo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runBd: (args: readonly string[]) => Promise<CommandResult>;
  readonly runGit: (args: readonly string[]) => Promise<CommandResult>;
  readonly createTask: (
    title: string,
    args?: readonly string[],
  ) => Promise<Record<string, unknown>>;
  readonly showTask: (id: string) => Promise<Record<string, unknown>>;
}

const createRealBeadsRepo = async (): Promise<RealBeadsRepo> => {
  const bdPath = resolveBundledBdExecutable();
  expect(bdPath).toBeDefined();

  const cwd = await mkdtemp(join(tmpdir(), "sandcastle-beads-char-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], {
    cwd,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
  const env = {
    ...process.env,
    BEADS_ACTOR: "sandcastle-test",
    SANDCASTLE_BD_PATH: bdPath!,
  };

  const runBd = async (args: readonly string[]): Promise<CommandResult> =>
    execFileAsync(bdPath!, [...args], {
      cwd,
      env,
      maxBuffer: 1024 * 1024 * 10,
    });
  const runGit = async (args: readonly string[]): Promise<CommandResult> =>
    execFileAsync("git", [...args], {
      cwd,
      env,
      maxBuffer: 1024 * 1024 * 10,
    });

  await runBd(["init", "--non-interactive"]);

  const createTask = async (
    title: string,
    args: readonly string[] = [],
  ): Promise<Record<string, unknown>> => {
    const { stdout } = await runBd([
      "create",
      title,
      "--type",
      "task",
      "--json",
      ...args,
    ]);
    return JSON.parse(stdout) as Record<string, unknown>;
  };

  const showTask = async (id: string): Promise<Record<string, unknown>> => {
    const { stdout } = await runBd(["show", id, "--json", "--long"]);
    const [task] = JSON.parse(stdout) as Record<string, unknown>[];
    expect(task).toBeDefined();
    return task!;
  };

  return { cwd, env, runBd, runGit, createTask, showTask };
};

const readId = (task: Record<string, unknown>): string => {
  expect(task.id).toEqual(expect.any(String));
  return task.id as string;
};

const expectBdFailure = async (
  repo: RealBeadsRepo,
  args: readonly string[],
): Promise<string> => {
  try {
    await repo.runBd(args);
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    return failure.stderr ?? failure.message ?? "";
  }

  throw new Error(`Expected bd ${args.join(" ")} to fail`);
};

describe("Beads 1.0.4 Hub task state-write characterization", () => {
  it("contract: bd update --set-labels stores only the full replacement label list Sandcastle supplies", async () => {
    const repo = await createRealBeadsRepo();
    const task = await repo.createTask("Label replacement", [
      "--label",
      "ready-for-agent",
      "--label",
      "user-owned",
      "--label",
      "blocked",
    ]);
    const taskId = readId(task);

    await repo.runBd([
      "update",
      taskId,
      "--set-labels",
      "user-owned",
      "--set-labels",
      "waiting-for-merge",
      "--json",
    ]);

    const updated = await repo.showTask(taskId);
    expect(updated.labels).toEqual(["user-owned", "waiting-for-merge"]);
    expect(updated.labels).not.toContain("ready-for-agent");
    expect(updated.labels).not.toContain("blocked");
  }, 90_000);

  it("contract: bd update --metadata merges structured Hub metadata without stringifying objects or arrays", async () => {
    const repo = await createRealBeadsRepo();
    const task = await repo.createTask("Structured metadata", [
      "--metadata",
      '{"existing":true}',
    ]);
    const taskId = readId(task);

    await repo.runBd([
      "update",
      taskId,
      "--metadata",
      '{"hubStatus":"reviewing","claim":{"batchId":"batch-1"},"runRefs":["run-1"]}',
      "--json",
    ]);

    const updated = await repo.showTask(taskId);
    expect(updated.metadata).toMatchObject({
      existing: true,
      hubStatus: "reviewing",
      claim: { batchId: "batch-1" },
      runRefs: ["run-1"],
    });
  }, 90_000);

  it("contract: bd update --set-metadata is field-level string metadata and --unset-metadata removes fields", async () => {
    const repo = await createRealBeadsRepo();
    const task = await repo.createTask("Field metadata", [
      "--metadata",
      '{"removeMe":"stale"}',
    ]);
    const taskId = readId(task);

    await repo.runBd([
      "update",
      taskId,
      "--set-metadata",
      'claim={"batchId":"batch-1"}',
      "--set-metadata",
      'runRefs=["run-1"]',
      "--unset-metadata",
      "removeMe",
      "--json",
    ]);

    const updated = await repo.showTask(taskId);
    expect(updated.metadata).toMatchObject({
      claim: '{"batchId":"batch-1"}',
      runRefs: '["run-1"]',
    });
    expect((updated.metadata as Record<string, unknown>).removeMe).toBe(
      undefined,
    );
  }, 90_000);

  it("contract: bd show supports --json --long --thread --refs; diagnostic: --include-comments is rejected", async () => {
    const repo = await createRealBeadsRepo();
    const task = await repo.createTask("Detailed read");
    const taskId = readId(task);

    const { stdout } = await repo.runBd([
      "show",
      taskId,
      "--json",
      "--long",
      "--thread",
      "--refs",
    ]);
    const [details] = JSON.parse(stdout) as Record<string, unknown>[];

    expect(details).toMatchObject({
      id: taskId,
      title: "Detailed read",
    });

    const stderr = await expectBdFailure(repo, [
      "show",
      taskId,
      "--json",
      "--include-comments",
    ]);
    expect(stderr).toContain("unknown flag: --include-comments");
  }, 90_000);

  it("contract: Sandcastle Hub task board projection uses bd list --json --all --limit 0 so closed tasks remain visible", async () => {
    const repo = await createRealBeadsRepo();
    const openTask = await repo.createTask("Open projection", [
      "--label",
      "ready-for-agent",
    ]);
    const closedTask = await repo.createTask("Closed projection");
    const closedTaskId = readId(closedTask);
    await repo.runBd(["close", closedTaskId, "--reason", "Done", "--json"]);

    const board = loadHubTaskBoard(repo.cwd, repo.env);

    expect(board.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([readId(openTask), closedTaskId]),
    );
    expect(board.tasks.find((task) => task.id === closedTaskId)).toMatchObject({
      title: "Closed projection",
      beadsStatus: "closed",
      hubStatus: "done",
    });
  }, 90_000);

  it("diagnostic: bd --readonly --sandbox read commands leave a clean exported task store unchanged", async () => {
    const repo = await createRealBeadsRepo();
    const task = await repo.createTask("Readonly read");
    const taskId = readId(task);
    await repo.runGit(["add", ".beads/issues.jsonl"]);
    await repo.runGit(["commit", "-m", "export task state"]);

    const show = await repo.runBd([
      "--readonly",
      "--sandbox",
      "show",
      taskId,
      "--json",
      "--long",
    ]);
    const list = await repo.runBd([
      "--readonly",
      "--sandbox",
      "list",
      "--json",
      "--all",
      "--limit",
      "0",
    ]);
    const status = await repo.runGit(["status", "--short"]);

    expect(JSON.parse(show.stdout)).toEqual([
      expect.objectContaining({ id: taskId }),
    ]);
    expect(JSON.parse(list.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: taskId })]),
    );
    expect(status.stdout).toBe("");
  }, 90_000);
});
