import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  cleanupHubTaskSnapshot,
  createHubTaskSnapshot,
} from "./hubTaskSnapshot.js";
import { initHubTaskStore } from "./hubTaskStore.js";
import { resolveHubTaskStoreRedirectPath } from "./hubTaskStoreResolver.js";
import { resolveBundledBdExecutable } from "./resolveBdExecutable.js";
import {
  appendHubTaskComment,
  createHubTask,
  loadHubReadyQueue,
  loadHubTask,
} from "./taskBoard.js";

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

describe("parallel Hub task snapshots with concurrent task-board attempts", () => {
  it("keeps the managed store readable while two selected tasks overlap", async () => {
    const bundledBd = resolveBundledBdExecutable();
    expect(bundledBd).toBeDefined();

    const root = await mkdtemp(join(tmpdir(), "hub-snapshot-parallel-"));
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
      projectName: "parallel",
    });

    const first = createHubTask(
      repoDir,
      {
        title: "First parallel task",
        description: "Acceptance: first concurrent snapshot.",
        hubStatus: "ready_for_agent",
      },
      env,
    );
    const second = createHubTask(
      repoDir,
      {
        title: "Second parallel task",
        description: "Acceptance: second concurrent snapshot.",
        hubStatus: "ready_for_agent",
      },
      env,
    );

    const redirectPath = resolveHubTaskStoreRedirectPath(repoDir);
    const originalRedirect = readFileSync(redirectPath);
    const runDir = join(hubProjectDir, "runs", "run-parallel");
    await mkdir(runDir, { recursive: true });

    const redirectSamples: Buffer[] = [];
    const started = new Set<string>();
    let notifyStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const runAttempt = async (taskId: string) => {
      const snapshot = createHubTaskSnapshot({
        cwd: repoDir,
        taskId,
        runDir,
        role: "implement",
        attemptId: `attempt-${taskId}`,
        env,
      });
      try {
        redirectSamples.push(readFileSync(redirectPath));
        expect(loadHubTask(repoDir, first.id, env).id).toBe(first.id);
        expect(loadHubReadyQueue(repoDir, env).tasks.length).toBeGreaterThan(0);

        started.add(taskId);
        if (started.size >= 2) {
          notifyStarted();
        }
        await bothStarted;
        redirectSamples.push(readFileSync(redirectPath));

        // Lifecycle mutation must still reach the managed store while both
        // snapshots are active.
        appendHubTaskComment(
          repoDir,
          taskId,
          `overlap-note-${taskId}`,
          env,
        );
        expect(
          loadHubTask(repoDir, taskId, env).comments.some(
            (comment) => comment.body === `overlap-note-${taskId}`,
          ),
        ).toBe(true);
      } finally {
        cleanupHubTaskSnapshot(snapshot);
      }
    };

    await Promise.all([runAttempt(first.id), runAttempt(second.id)]);

    expect(started.size).toBe(2);
    expect(redirectSamples.length).toBeGreaterThanOrEqual(2);
    for (const sample of redirectSamples) {
      expect(sample).toEqual(originalRedirect);
    }
    expect(readFileSync(redirectPath)).toEqual(originalRedirect);
    expect(loadHubReadyQueue(repoDir, env).tasks.length).toBeGreaterThan(0);
  }, 120_000);
});
