import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";
import type { GithubIssueClient, GithubIssueRecord } from "./hubTaskSync.js";
import {
  hasHubTaskSyncConflict,
  resolveHubTaskConflict,
  resolveHubTaskSyncConflict,
  type HubConflictFieldValues,
} from "./hubTaskResolve.js";
import { loadHubTask } from "./taskBoard.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

interface MockBeadsTask {
  id: string;
  title: string;
  status: string;
  description?: string;
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
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const findTask = (state, taskId) => state.find((task) => task.id === taskId);

if (command === "show" && id) {
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "list") {
  process.stdout.write(JSON.stringify(readState()));
  process.exit(0);
}

if (command === "update" && id) {
  fs.appendFileSync(argsFile, args.join(" ") + "\\n");
  const state = readState();
  const task = findTask(state, id);
  if (!task) process.exit(1);
  const statusIndex = args.indexOf("--status");
  if (statusIndex >= 0) {
    task.status = args[statusIndex + 1];
  }
  const titleIndex = args.indexOf("--title");
  if (titleIndex >= 0) {
    task.title = args[titleIndex + 1];
  }
  const descriptionIndex = args.indexOf("--description");
  if (descriptionIndex >= 0) {
    task.description = args[descriptionIndex + 1];
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      task.labels = [];
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set-labels") {
      const label = args[index + 1];
      if (!task.labels.includes(label)) task.labels.push(label);
    }
    if (args[index] === "--add-label") {
      const label = args[index + 1];
      if (!task.labels.includes(label)) task.labels.push(label);
    }
    if (args[index] === "--remove-label") {
      const label = args[index + 1];
      task.labels = task.labels.filter((entry) => entry !== label);
    }
  }
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = {
      ...task.metadata,
      ...JSON.parse(args[metadataIndex + 1]),
    };
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--unset-metadata") {
      delete task.metadata[args[index + 1]];
    }
  }
  writeState(state);
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
      BD_ARGS_FILE: argsFile,
    },
    argsFile,
  };
};

const conflictIssue = (
  overrides: Partial<GithubIssueRecord> = {},
): GithubIssueRecord => ({
  number: 226,
  title: "Remote title",
  body: "Remote description",
  state: "OPEN",
  labels: ["archLoop", "needs-info"],
  updatedAt: "2026-07-21T12:00:00Z",
  ...overrides,
});

const githubClient = (
  issues: readonly GithubIssueRecord[],
): GithubIssueClient => ({
  listIssues: () => issues,
  editIssue: () => {
    throw new Error("resolve must not edit GitHub issues");
  },
  closeIssue: () => {
    throw new Error("resolve must not close GitHub issues");
  },
});

const baseLocal: HubConflictFieldValues = {
  title: "Local title",
  hubStatus: "ready_for_agent",
  description: "Local description",
};

const baseRemote: HubConflictFieldValues = {
  title: "Remote title",
  hubStatus: "needs_info",
  description: "Remote description",
};

describe("resolveHubTaskConflict", () => {
  it.each([
    {
      name: "status-only keep local",
      divergedFields: ["hubStatus"] as const,
      keep: "local" as const,
      expected: {
        keep: "local" as const,
        syncState: "push_pending" as const,
        hubStatus: "ready_for_agent" as const,
        title: undefined,
        description: undefined,
      },
    },
    {
      name: "status-only keep remote",
      divergedFields: ["hubStatus"] as const,
      keep: "remote" as const,
      expected: {
        keep: "remote" as const,
        syncState: "synced" as const,
        hubStatus: "needs_info" as const,
        title: undefined,
        description: undefined,
      },
    },
    {
      name: "title-only keep local",
      divergedFields: ["title"] as const,
      keep: "local" as const,
      expected: {
        keep: "local" as const,
        syncState: "push_pending" as const,
        hubStatus: "ready_for_agent" as const,
        title: undefined,
        description: undefined,
      },
    },
    {
      name: "title-only keep remote",
      divergedFields: ["title"] as const,
      keep: "remote" as const,
      expected: {
        keep: "remote" as const,
        syncState: "synced" as const,
        hubStatus: "needs_info" as const,
        title: "Remote title",
        description: undefined,
      },
    },
    {
      name: "title and status keep local",
      divergedFields: ["title", "hubStatus"] as const,
      keep: "local" as const,
      expected: {
        keep: "local" as const,
        syncState: "push_pending" as const,
        hubStatus: "ready_for_agent" as const,
        title: undefined,
        description: undefined,
      },
    },
    {
      name: "title and status keep remote",
      divergedFields: ["title", "hubStatus"] as const,
      keep: "remote" as const,
      expected: {
        keep: "remote" as const,
        syncState: "synced" as const,
        hubStatus: "needs_info" as const,
        title: "Remote title",
        description: undefined,
      },
    },
    {
      name: "all fields keep remote",
      divergedFields: ["title", "hubStatus", "description"] as const,
      keep: "remote" as const,
      expected: {
        keep: "remote" as const,
        syncState: "synced" as const,
        hubStatus: "needs_info" as const,
        title: "Remote title",
        description: "Remote description",
      },
    },
  ])("$name", ({ divergedFields, keep, expected }) => {
    const mutation = resolveHubTaskConflict({
      localValue: baseLocal,
      remoteValue: baseRemote,
      keep,
      divergedFields,
    });

    expect(mutation).toEqual({
      keep: expected.keep,
      syncState: expected.syncState,
      clearConflictMetadata: true,
      hubStatus: expected.hubStatus,
      ...(expected.title !== undefined ? { title: expected.title } : {}),
      ...(expected.description !== undefined
        ? { description: expected.description }
        : {}),
      mutations: expect.any(Array),
    });
    expect(mutation.mutations.length).toBeGreaterThan(0);
  });

  it("keep local never copies remote title or description", () => {
    const mutation = resolveHubTaskConflict({
      localValue: baseLocal,
      remoteValue: baseRemote,
      keep: "local",
      divergedFields: ["title", "hubStatus", "description"],
    });

    expect(mutation.title).toBeUndefined();
    expect(mutation.description).toBeUndefined();
    expect(mutation.syncState).toBe("push_pending");
    expect(mutation.hubStatus).toBe("ready_for_agent");
  });
});

describe("resolveHubTaskSyncConflict integration", () => {
  it("keep local clears conflict metadata and sets push_pending without calling gh mutations", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-resolve-local-"));
    await initRepo(repoDir);
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-conflict",
        title: "Local title",
        description: "Local description",
        status: "blocked",
        labels: ["sync-conflict"],
        metadata: {
          hubStatus: "sync_conflict",
          sync_state: "conflict",
          sync_conflict_reason:
            "local ready_for_agent disagrees with remote needs_info",
          github_issue: 226,
          remote_refs: ["github#226"],
        },
      },
    ]);

    const result = resolveHubTaskSyncConflict({
      cwd: repoDir,
      taskId: "bd-conflict",
      keep: "local",
      env,
      github: githubClient([conflictIssue()]),
    });

    expect(result.kept).toBe("local");
    expect(result.task.hubStatus).toBe("ready_for_agent");
    expect(result.task.metadata.sync_state).toBe("push_pending");
    expect(result.task.metadata.sync_conflict_reason).toBeUndefined();
    expect(hasHubTaskSyncConflict(result.task)).toBe(false);
    expect(result.task.title).toBe("Local title");
    expect(result.task.description).toBe("Local description");
  });

  it("keep remote overwrites local fields and sets synced", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-resolve-remote-"));
    await initRepo(repoDir);
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-conflict",
        title: "Local title",
        description: "Local description",
        status: "blocked",
        labels: ["sync-conflict"],
        metadata: {
          hubStatus: "sync_conflict",
          sync_state: "conflict",
          sync_conflict_reason:
            "local ready_for_agent disagrees with remote needs_info",
          github_issue: 226,
          remote_refs: ["github#226"],
        },
      },
    ]);

    const result = resolveHubTaskSyncConflict({
      cwd: repoDir,
      taskId: "bd-conflict",
      keep: "remote",
      env,
      github: githubClient([
        conflictIssue({
          title: "Remote title",
          body: "Remote description",
          labels: ["archLoop", "needs-info"],
        }),
      ]),
    });

    expect(result.kept).toBe("remote");
    expect(result.task.hubStatus).toBe("needs_info");
    expect(result.task.metadata.sync_state).toBe("synced");
    expect(result.task.metadata.sync_conflict_reason).toBeUndefined();
    expect(result.task.title).toBe("Remote title");
    expect(result.task.description).toBe("Remote description");
  });

  it("throws a friendly nothing-to-resolve error when there is no conflict", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-resolve-none-"));
    await initRepo(repoDir);
    const stateFile = join(repoDir, "bd-state.json");
    const { env } = await writeMockBd(repoDir, stateFile, [
      {
        id: "bd-ok",
        title: "Synced task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          hubStatus: "ready_for_agent",
          sync_state: "synced",
          github_issue: 226,
          remote_refs: ["github#226"],
        },
      },
    ]);

    expect(() =>
      resolveHubTaskSyncConflict({
        cwd: repoDir,
        taskId: "bd-ok",
        keep: "local",
        env,
        github: githubClient([conflictIssue()]),
      }),
    ).toThrow(/nothing to resolve/);

    const task = loadHubTask(repoDir, "bd-ok", env);
    expect(task.hubStatus).toBe("ready_for_agent");
  });
});
