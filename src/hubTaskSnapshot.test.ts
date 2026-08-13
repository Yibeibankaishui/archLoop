import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  applyHubTaskNotes,
  cleanupHubTaskSnapshot,
  createHubTaskSnapshot,
  HUB_TASK_NOTES_TAG,
} from "./hubTaskSnapshot.js";
import { initHubTaskStore, runBdTextForHubTaskStore } from "./hubTaskStore.js";
import {
  addHubTaskDependency,
  appendHubTaskComment,
  createHubTask,
  loadHubTask,
} from "./taskBoard.js";
import { resolveBundledBdExecutable } from "./resolveBdExecutable.js";

const execFileAsync = promisify(execFile);

const initRepo = async (dir: string) => {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "hello.txt"), "hello\n");
  await execFileAsync("git", ["add", "hello.txt"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
};

const createSnapshotFixture = async () => {
  const bundledBd = resolveBundledBdExecutable();
  expect(bundledBd).toBeDefined();

  const root = await mkdtemp(join(tmpdir(), "hub-task-snapshot-"));
  const repoDir = join(root, "repo");
  const hubProjectDir = join(root, "hub-project");
  await mkdir(repoDir);
  await initRepo(repoDir);

  const env = {
    ...process.env,
    ARCHLOOP_BD_PATH: bundledBd!,
    BEADS_ACTOR: "archloop-test",
  };

  initHubTaskStore(repoDir, env, {
    hubProjectDir,
    projectName: "snapshot",
  });

  const parent = createHubTask(
    repoDir,
    {
      title: "PRD: Fully automatic Hub landing",
      description: "Parent PRD for landing work.",
    },
    env,
  );
  const selected = createHubTask(
    repoDir,
    {
      title: "Run Hub Agents from immutable snapshots",
      description: "Acceptance: agents receive a task snapshot, not live bd.",
      prdRef: parent.id,
    },
    env,
  );
  const blocker = createHubTask(
    repoDir,
    {
      title: "Initialize managed Beads store",
      description: "Required dependency for snapshots.",
    },
    env,
  );
  const unrelated = createHubTask(
    repoDir,
    {
      title: "Unrelated secret task",
      description: "Must never appear in the agent snapshot.",
    },
    env,
  );

  addHubTaskDependency(repoDir, selected.id, blocker.id, env);
  appendHubTaskComment(repoDir, selected.id, "Selected-task comment", env);
  appendHubTaskComment(
    repoDir,
    unrelated.id,
    "Unrelated-task comment must stay out",
    env,
  );

  runBdTextForHubTaskStore(
    repoDir,
    [
      "update",
      selected.id,
      "--metadata",
      JSON.stringify({
        api_token: "sk-live-secret",
        hubStatus: "ready_for_agent",
      }),
    ],
    "seed snapshot credentials",
    env,
  );

  const runDir = join(hubProjectDir, "runs", "run-snapshot");
  await mkdir(runDir, { recursive: true });

  return {
    root,
    repoDir,
    hubProjectDir,
    runDir,
    env,
    bundledBd: bundledBd!,
    parent,
    selected,
    blocker,
    unrelated,
  };
};

describe("immutable Hub task snapshots", () => {
  it("captures only the selected task, parent PRD, dependencies, comments, and remote refs", async () => {
    const fixture = await createSnapshotFixture();
    const snapshot = createHubTaskSnapshot({
      cwd: fixture.repoDir,
      taskId: fixture.selected.id,
      runDir: fixture.runDir,
      role: "implement",
      env: fixture.env,
    });

    expect(snapshot.taskId).toBe(fixture.selected.id);
    expect(snapshot.promptContent).toContain(fixture.selected.title);
    expect(snapshot.promptContent).toContain("Acceptance: agents receive");
    expect(snapshot.promptContent).toContain("Selected-task comment");
    expect(snapshot.promptContent).toContain(fixture.parent.title);
    expect(snapshot.promptContent).toContain(fixture.blocker.title);
    expect(snapshot.promptContent).not.toContain(fixture.unrelated.title);
    expect(snapshot.promptContent).not.toContain("Unrelated-task comment");
    expect(snapshot.promptContent).not.toContain("sk-live-secret");
    expect(snapshot.promptContent).not.toContain("embeddeddolt");
    expect(snapshot.promptContent).not.toContain("issues.jsonl");

    const snapshotJson = JSON.parse(
      await readFile(join(snapshot.snapshotDir, "snapshot.json"), "utf8"),
    ) as {
      readonly task: { readonly id: string; readonly title: string };
      readonly parentPrd?: { readonly id: string };
      readonly dependencies: readonly { readonly id: string }[];
    };
    expect(snapshotJson.task.id).toBe(fixture.selected.id);
    expect(snapshotJson.parentPrd?.id).toBe(fixture.parent.id);
    expect(snapshotJson.dependencies.map((dep) => dep.id)).toEqual([
      fixture.blocker.id,
    ]);

    cleanupHubTaskSnapshot(snapshot);
    expect(existsSync(snapshot.snapshotDir)).toBe(false);
  }, 90_000);

  it("uses restrictive permissions, rejects symlink replacement, and cleans up idempotently", async () => {
    const fixture = await createSnapshotFixture();
    const snapshot = createHubTaskSnapshot({
      cwd: fixture.repoDir,
      taskId: fixture.selected.id,
      runDir: fixture.runDir,
      role: "implement",
      attemptId: "attempt-1",
      env: fixture.env,
    });

    const dirStat = lstatSync(snapshot.snapshotDir);
    const fileStat = lstatSync(join(snapshot.snapshotDir, "snapshot.json"));
    expect(dirStat.isSymbolicLink()).toBe(false);
    expect(fileStat.isSymbolicLink()).toBe(false);
    expect(dirStat.mode & 0o777).toBe(0o500);
    expect(fileStat.mode & 0o777).toBe(0o400);

    expect(() =>
      createHubTaskSnapshot({
        cwd: fixture.repoDir,
        taskId: fixture.selected.id,
        runDir: fixture.runDir,
        role: "implement",
        attemptId: "attempt-1",
        env: fixture.env,
      }),
    ).toThrow(/already exists|symlink/i);

    cleanupHubTaskSnapshot(snapshot);
    cleanupHubTaskSnapshot(snapshot);
    expect(existsSync(snapshot.snapshotDir)).toBe(false);

    const hijackDir = join(
      fixture.runDir,
      "task-snapshots",
      "implement",
      fixture.selected.id,
    );
    await mkdir(hijackDir, { recursive: true });
    const hijackPath = join(hijackDir, "attempt-symlink");
    symlinkSync(fixture.root, hijackPath);
    expect(() =>
      createHubTaskSnapshot({
        cwd: fixture.repoDir,
        taskId: fixture.selected.id,
        runDir: fixture.runDir,
        role: "implement",
        attemptId: "attempt-symlink",
        env: fixture.env,
      }),
    ).toThrow(/symlink/i);
  }, 90_000);

  it("applies valid notes idempotently and rejects invalid or oversized notes", async () => {
    const fixture = await createSnapshotFixture();
    const validText = `<${HUB_TASK_NOTES_TAG}>
{"schemaVersion":1,"taskId":"${fixture.selected.id}","comments":["Attempt note"]}
</${HUB_TASK_NOTES_TAG}>`;

    const applied = applyHubTaskNotes({
      cwd: fixture.repoDir,
      taskId: fixture.selected.id,
      text: validText,
      env: fixture.env,
    });
    expect(applied.status).toBe("applied");

    const replayed = applyHubTaskNotes({
      cwd: fixture.repoDir,
      taskId: fixture.selected.id,
      text: validText,
      env: fixture.env,
    });
    expect(replayed.status).toBe("replayed");

    const loaded = loadHubTask(
      fixture.repoDir,
      fixture.selected.id,
      fixture.env,
    );
    expect(
      loaded.comments.filter((comment) => comment.body === "Attempt note"),
    ).toHaveLength(1);

    const otherTask = applyHubTaskNotes({
      cwd: fixture.repoDir,
      taskId: fixture.selected.id,
      text: `<${HUB_TASK_NOTES_TAG}>{"schemaVersion":1,"taskId":"${fixture.unrelated.id}","comments":["hijack"]}</${HUB_TASK_NOTES_TAG}>`,
      env: fixture.env,
    });
    expect(otherTask).toMatchObject({ status: "rejected" });

    const oversized = applyHubTaskNotes({
      cwd: fixture.repoDir,
      taskId: fixture.selected.id,
      text: `<${HUB_TASK_NOTES_TAG}>{"schemaVersion":1,"taskId":"${fixture.selected.id}","comments":["${"x".repeat(9000)}"]}</${HUB_TASK_NOTES_TAG}>`,
      env: fixture.env,
    });
    expect(oversized).toMatchObject({ status: "rejected" });

    const unrelatedAfter = loadHubTask(
      fixture.repoDir,
      fixture.unrelated.id,
      fixture.env,
    );
    expect(unrelatedAfter.comments.map((comment) => comment.body)).not.toContain(
      "hijack",
    );
  }, 90_000);

  it("prevents isolated agent env from mutating the live store or another task", async () => {
    const fixture = await createSnapshotFixture();
    const snapshot = createHubTaskSnapshot({
      cwd: fixture.repoDir,
      taskId: fixture.selected.id,
      runDir: fixture.runDir,
      role: "implement",
      env: fixture.env,
    });

    const isolatedEnv = {
      ...fixture.env,
      ...snapshot.sandboxEnv,
    };

    await expect(
      execFileAsync(
        fixture.bundledBd,
        ["comments", "add", fixture.unrelated.id, "malicious note"],
        { cwd: fixture.repoDir, env: isolatedEnv },
      ),
    ).rejects.toThrow();

    await expect(
      execFileAsync(
        fixture.bundledBd,
        ["update", fixture.unrelated.id, "--status", "closed"],
        { cwd: fixture.repoDir, env: isolatedEnv },
      ),
    ).rejects.toThrow();

    cleanupHubTaskSnapshot(snapshot);

    const unrelated = loadHubTask(
      fixture.repoDir,
      fixture.unrelated.id,
      fixture.env,
    );
    expect(unrelated.beadsStatus).not.toBe("closed");
    expect(unrelated.comments.map((comment) => comment.body)).not.toContain(
      "malicious note",
    );
  }, 90_000);
});
