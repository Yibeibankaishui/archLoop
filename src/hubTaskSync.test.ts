import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";
import {
  detectSemanticSyncConflict,
  formatGithubRemoteRef,
  isHubExecutionStatus,
  parseGithubRemoteRef,
  resolveRemoteCollaborationLabel,
  resolveRemoteCollaborationStatus,
  syncHubTasksWithGithub,
  type GithubIssueClient,
  type GithubIssueRecord,
} from "./hubTaskSync.js";

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

describe("github remote ref helpers", () => {
  it("formats and parses github remote refs", () => {
    expect(formatGithubRemoteRef(68)).toBe("github#68");
    expect(parseGithubRemoteRef("github#68")).toBe(68);
    expect(parseGithubRemoteRef(" GitHub#12 ")).toBe(12);
    expect(parseGithubRemoteRef("beads#1")).toBeUndefined();
  });
});

describe("remote collaboration mapping", () => {
  it("maps GitHub labels and closure state to Hub collaboration statuses", () => {
    expect(
      resolveRemoteCollaborationStatus({
        state: "OPEN",
        labels: ["needs-triage", "archLoop"],
      }),
    ).toBe("inbox");
    expect(
      resolveRemoteCollaborationStatus({
        state: "OPEN",
        labels: ["ready-for-agent"],
      }),
    ).toBe("ready_for_agent");
    expect(
      resolveRemoteCollaborationStatus({
        state: "CLOSED",
        labels: ["wontfix"],
      }),
    ).toBe("wontfix");
    expect(
      resolveRemoteCollaborationStatus({
        state: "CLOSED",
        labels: [],
      }),
    ).toBe("done");
  });

  it("does not treat execution labels as remote collaboration state", () => {
    expect(
      resolveRemoteCollaborationStatus({
        state: "OPEN",
        labels: ["implementing"],
      }),
    ).toBe("inbox");
    expect(isHubExecutionStatus("implementing")).toBe(true);
    expect(isHubExecutionStatus("ready_for_agent")).toBe(false);
    expect(resolveRemoteCollaborationLabel("implementing")).toBeUndefined();
    expect(resolveRemoteCollaborationLabel("ready_for_agent")).toBe(
      "ready-for-agent",
    );
    expect(resolveRemoteCollaborationLabel("done")).toBeUndefined();
  });
});

describe("semantic sync conflicts", () => {
  it("flags collaboration mismatches and protects completed local tasks", () => {
    expect(
      detectSemanticSyncConflict("ready_for_agent", "needs_info"),
    ).toContain("disagrees");
    expect(
      detectSemanticSyncConflict("done", "ready_for_agent"),
    ).toBeUndefined();
    expect(detectSemanticSyncConflict("wontfix", "blocked")).toBeUndefined();
    expect(detectSemanticSyncConflict("done", "wontfix")).toContain(
      "disagrees",
    );
    expect(detectSemanticSyncConflict("wontfix", "done")).toContain(
      "disagrees",
    );
    expect(
      detectSemanticSyncConflict("implementing", "ready_for_agent"),
    ).toBeUndefined();
  });
});

describe("syncHubTasksWithGithub", () => {
  const createFakeBd = async (
    repoDir: string,
    initialState: Record<string, unknown>[],
  ) => {
    seedHubTaskStoreMetadata(repoDir);
    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

    const stateFile = join(repoDir, "bd-state.json");
    const createArgsFile = join(repoDir, "bd-create-args.txt");
    const showArgsFile = join(repoDir, "bd-show-args.txt");
    const updateArgsFile = join(repoDir, "bd-update-args.txt");
    await writeFile(stateFile, JSON.stringify(initialState, null, 2));
    await writeFile(createArgsFile, "");
    await writeFile(showArgsFile, "");
    await writeFile(updateArgsFile, "");

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const createArgsFile = process.env.BD_CREATE_ARGS_FILE;
const updateArgsFile = process.env.BD_UPDATE_ARGS_FILE;
const args = process.argv.slice(2);
const [command, id] = args;

if (command === "list") {
  const includeClosed = args.includes("--all");
  const limitIndex = args.indexOf("--limit");
  const limit =
    limitIndex >= 0 ? Number(args[limitIndex + 1]) : 50;
  let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (!includeClosed) {
    state = state.filter((entry) => entry.status !== "closed");
  }
  if (limit > 0) {
    state = state.slice(0, limit);
  }
  fs.writeSync(1, JSON.stringify(state, null, 2));
  process.exit(0);
}

if (command === "show") {
  fs.appendFileSync(${JSON.stringify(showArgsFile)}, args.join(" ") + "\\n");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.find((entry) => entry.id === id);
  if (!task) {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([task], null, 2));
  process.exit(0);
}

if (command === "create") {
  fs.appendFileSync(createArgsFile, args.join(" ") + "\\n");
  const title = args[1];
  const metadataIndex = args.indexOf("--metadata");
  const metadata =
    metadataIndex >= 0 ? JSON.parse(args[metadataIndex + 1]) : {};
  const labels = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-l") {
      labels.push(args[index + 1]);
    }
  }
  const descriptionIndex = args.indexOf("--description");
  const description =
    descriptionIndex >= 0 ? args[descriptionIndex + 1] : undefined;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const created = {
    id: \`bd-\${state.length + 1}\`,
    title,
    status: "open",
    labels,
    metadata,
    description,
    remoteRefs: metadata.remote_refs?.map((url) => ({ url })) ?? [],
  };
  state.push(created);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify([created], null, 2));
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
  const titleIndex = args.indexOf("--title");
  if (titleIndex >= 0) {
    task.title = args[titleIndex + 1];
  }
  const descriptionIndex = args.indexOf("--description");
  if (descriptionIndex >= 0) {
    task.description = args[descriptionIndex + 1];
  }
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = {
      ...task.metadata,
      ...JSON.parse(args[metadataIndex + 1]),
    };
    if (task.metadata.remote_refs) {
      task.remoteRefs = task.metadata.remote_refs.map((url) => ({ url }));
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--unset-metadata") {
      delete task.metadata[args[index + 1]];
    }
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

process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    return {
      binDir,
      stateFile,
      createArgsFile,
      showArgsFile,
      updateArgsFile,
    };
  };

  it("pulls new GitHub issues into Beads", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-pull-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, createArgsFile, stateFile } = await createFakeBd(
      repoDir,
      [],
    );

    const issues: GithubIssueRecord[] = [
      {
        number: 68,
        title: "Sync Hub task state",
        body: "Implement tasks sync",
        state: "OPEN",
        labels: ["archLoop", "ready-for-agent"],
        updatedAt: "2026-06-11T12:00:00Z",
      },
    ];

    const github: GithubIssueClient = {
      listIssues: () => issues,
      editIssue: () => {},
      closeIssue: () => {},
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_CREATE_ARGS_FILE: createArgsFile,
        BD_UPDATE_ARGS_FILE: join(repoDir, "bd-update-args.txt"),
      },
    });

    expect(result.pulled.created).toEqual(["bd-1"]);
    const createArgs = await readFile(createArgsFile, "utf-8");
    expect(createArgs).toContain("Sync Hub task state");
    expect(createArgs).toContain("ready-for-agent");
    expect(createArgs).toContain("github#68");
  });

  it("pulls only open GitHub issues by default", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-open-only-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, createArgsFile, stateFile } = await createFakeBd(
      repoDir,
      [],
    );

    const issues: GithubIssueRecord[] = [
      {
        number: 68,
        title: "Open issue",
        body: "Keep me",
        state: "OPEN",
        labels: ["archLoop", "ready-for-agent"],
        updatedAt: "2026-06-11T12:00:00Z",
      },
      {
        number: 69,
        title: "Closed history",
        body: "Do not import me",
        state: "CLOSED",
        labels: ["archLoop"],
        updatedAt: "2026-06-11T13:00:00Z",
      },
    ];

    const github: GithubIssueClient = {
      listIssues: () => issues,
      editIssue: () => {},
      closeIssue: () => {},
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_CREATE_ARGS_FILE: createArgsFile,
        BD_UPDATE_ARGS_FILE: join(repoDir, "bd-update-args.txt"),
      },
    });

    expect(result.pulled.created).toEqual(["bd-1"]);
    expect(await readFile(createArgsFile, "utf-8")).toContain("Open issue");
    expect(await readFile(createArgsFile, "utf-8")).not.toContain(
      "Closed history",
    );
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      title: string;
    }>;
    expect(state).toHaveLength(1);
    expect(state[0]?.title).toBe("Open issue");
  });

  it("includes closed GitHub issues when requested", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-include-closed-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, createArgsFile, stateFile } = await createFakeBd(
      repoDir,
      [],
    );

    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 68,
          title: "Open issue",
          body: "Keep me",
          state: "OPEN",
          labels: ["archLoop", "ready-for-agent"],
          updatedAt: "2026-06-11T12:00:00Z",
        },
        {
          number: 69,
          title: "Closed history",
          body: "Import me too",
          state: "CLOSED",
          labels: ["archLoop"],
          updatedAt: "2026-06-11T13:00:00Z",
        },
      ],
      editIssue: () => {},
      closeIssue: () => {},
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      includeClosed: true,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_CREATE_ARGS_FILE: createArgsFile,
        BD_UPDATE_ARGS_FILE: join(repoDir, "bd-update-args.txt"),
      },
    });

    expect(result.pulled.created).toHaveLength(2);
    expect(await readFile(createArgsFile, "utf-8")).toContain("Closed history");
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      title: string;
    }>;
    expect(state.map((entry) => entry.title)).toEqual([
      "Open issue",
      "Closed history",
    ]);
  });

  it("reports same-title GitHub issues as duplicate link candidates", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-duplicate-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, createArgsFile, stateFile } = await createFakeBd(repoDir, [
      {
        id: "bd-1",
        title: "Duplicate candidate",
        status: "open",
      },
    ]);

    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 71,
          title: "Duplicate candidate",
          body: "Should not create a second task",
          state: "OPEN",
          labels: ["archLoop"],
          updatedAt: "2026-06-11T14:00:00Z",
        },
      ],
      editIssue: () => {},
      closeIssue: () => {},
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_CREATE_ARGS_FILE: createArgsFile,
        BD_UPDATE_ARGS_FILE: join(repoDir, "bd-update-args.txt"),
      },
    });

    expect(result.pulled.created).toEqual([]);
    expect(result.pulled.updated).toEqual([]);
    expect(result.pulled.conflicts).toEqual([]);
    expect(result.pulled.duplicateCandidates).toEqual([
      {
        issueNumber: 71,
        title: "Duplicate candidate",
        localTaskIds: ["bd-1"],
      },
    ]);
    expect(await readFile(createArgsFile, "utf-8")).toBe("");
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      id: string;
      title: string;
    }>;
    expect(state).toHaveLength(1);
    expect(state[0]?.id).toBe("bd-1");
  });

  it("does not mutate local task metadata during a dry-run push preview", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-push-dry-run-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, stateFile, updateArgsFile } = await createFakeBd(repoDir, [
      {
        id: "bd-ready",
        title: "Ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          remote_refs: ["github#10"],
          sync_state: "push_pending",
          hubStatus: "ready_for_agent",
        },
        remoteRefs: [{ url: "github#10" }],
      },
    ]);

    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 10,
          title: "Ready task",
          state: "OPEN",
          labels: ["needs-triage"],
          updatedAt: "2026-06-11T10:00:00Z",
        },
      ],
      editIssue: () => {},
      closeIssue: () => {},
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      mode: "push",
      dryRun: true,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(result.pulled.created).toEqual([]);
    expect(result.pushed.synced).toEqual(["bd-ready"]);
    expect(await readFile(updateArgsFile, "utf-8")).toBe("");
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      metadata: { sync_state?: string };
    }>;
    expect(state[0]?.metadata.sync_state).toBe("push_pending");
  });

  it("does not preview already closed remote issues as newly closed", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-sync-push-dry-run-closed-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, stateFile, updateArgsFile } = await createFakeBd(repoDir, [
      {
        id: "bd-done",
        title: "Done task",
        status: "closed",
        labels: ["done"],
        metadata: {
          remote_refs: ["github#10"],
          sync_state: "push_pending",
          hubStatus: "done",
        },
      },
    ]);

    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 10,
          title: "Done task",
          state: "CLOSED",
          labels: ["archLoop"],
        },
      ],
      editIssue: () => {},
      closeIssue: () => {},
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      mode: "push",
      dryRun: true,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(result.pushed.closed).toEqual([]);
    expect(result.pushed.synced).toEqual(["bd-done"]);
    expect(await readFile(updateArgsFile, "utf-8")).toBe("");
  });

  it("does not rewrite already synced local tasks when the remote issue is already closed", async () => {
    const repoDir = await mkdtemp(
      join(tmpdir(), "hub-sync-push-already-synced-"),
    );
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, stateFile, updateArgsFile } = await createFakeBd(repoDir, [
      {
        id: "bd-done",
        title: "Done task",
        status: "closed",
        labels: ["done"],
        metadata: {
          remote_refs: ["github#10"],
          sync_state: "synced",
          hubStatus: "done",
        },
      },
    ]);

    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 10,
          title: "Done task",
          state: "CLOSED",
          labels: ["archLoop"],
        },
      ],
      editIssue: () => {},
      closeIssue: () => {},
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      mode: "push",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(result.pushed.closed).toEqual([]);
    expect(result.pushed.synced).toEqual(["bd-done"]);
    expect(await readFile(updateArgsFile, "utf-8")).toBe("");
  });

  it("push mode never imports remote-only GitHub issues", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-push-only-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, createArgsFile, stateFile, updateArgsFile } =
      await createFakeBd(repoDir, [
        {
          id: "bd-done",
          title: "Done task",
          status: "closed",
          labels: ["done"],
          metadata: {
            remote_refs: ["github#20"],
            sync_state: "push_pending",
            hubStatus: "done",
          },
          remoteRefs: [{ url: "github#20" }],
        },
      ]);

    const closes: number[] = [];
    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 20,
          title: "Done task",
          state: "OPEN",
          labels: ["ready-for-agent"],
        },
        {
          number: 21,
          title: "Remote-only issue",
          state: "OPEN",
          labels: ["ready-for-agent"],
        },
      ],
      editIssue: () => {},
      closeIssue: (issueNumber) => {
        closes.push(issueNumber);
      },
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      mode: "push",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_CREATE_ARGS_FILE: createArgsFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(result.pulled.created).toEqual([]);
    expect(result.pushed.closed).toEqual(["bd-done"]);
    expect(closes).toEqual([20]);
    expect(await readFile(createArgsFile, "utf-8")).toBe("");
  });

  it("pushes completed tasks that are Beads-closed and beyond the default list page", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-push-all-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const fillerTasks = Array.from({ length: 55 }, (_, index) => ({
      id: `bd-filler-${index}`,
      title: `Filler ${index}`,
      status: "open",
    }));
    const { binDir, stateFile, showArgsFile, updateArgsFile } =
      await createFakeBd(repoDir, [
        ...fillerTasks,
        {
          id: "bd-closed-target",
          title: "Closed target",
          status: "closed",
          labels: ["done"],
          metadata: {
            done: true,
            hubStatus: "done",
            sync_state: "push_pending",
            remote_refs: ["github#102"],
            github_issue: 102,
          },
        },
      ]);

    const closes: number[] = [];
    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 102,
          title: "Closed target",
          state: "OPEN",
          labels: ["archLoop", "ready-for-agent"],
        },
      ],
      editIssue: () => {},
      closeIssue: (issueNumber) => {
        closes.push(issueNumber);
      },
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      mode: "push",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(closes).toEqual([102]);
    expect(result.pushed.closed).toEqual(["bd-closed-target"]);
    expect(result.pushed.synced).toEqual([]);
    expect(await readFile(showArgsFile, "utf-8")).toBe("");
  });

  it("closes each linked GitHub issue at most once when duplicate local tasks share a remote ref", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-push-duplicate-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, stateFile, updateArgsFile } = await createFakeBd(repoDir, [
      {
        id: "bd-first",
        title: "First local duplicate",
        status: "closed",
        labels: ["done"],
        metadata: {
          hubStatus: "done",
          sync_state: "push_pending",
          remote_refs: ["github#102"],
        },
      },
      {
        id: "bd-second",
        title: "Second local duplicate",
        status: "closed",
        labels: ["done"],
        metadata: {
          hubStatus: "done",
          sync_state: "push_pending",
          remote_refs: ["github#102"],
        },
      },
    ]);

    const closes: number[] = [];
    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 102,
          title: "Remote issue",
          state: "OPEN",
          labels: ["archLoop", "ready-for-agent"],
        },
      ],
      editIssue: () => {},
      closeIssue: (issueNumber) => {
        closes.push(issueNumber);
      },
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      mode: "push",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(closes).toEqual([102]);
    expect(result.pushed.closed).toEqual(["bd-first"]);
    expect(result.pushed.synced).toEqual(["bd-second"]);
  });

  it("pushes collaboration labels and closes done or wontfix issues remotely", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-push-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, stateFile, updateArgsFile } = await createFakeBd(repoDir, [
      {
        id: "bd-ready",
        title: "Ready task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          remote_refs: ["github#10"],
          sync_state: "push_pending",
        },
        remoteRefs: [{ url: "github#10" }],
      },
      {
        id: "bd-done",
        title: "Done task",
        status: "closed",
        labels: ["done"],
        metadata: {
          remote_refs: ["github#11"],
          sync_state: "push_pending",
          hubStatus: "done",
        },
        remoteRefs: [{ url: "github#11" }],
      },
      {
        id: "bd-wontfix",
        title: "Wontfix task",
        status: "closed",
        labels: ["wontfix"],
        metadata: {
          remote_refs: ["github#12"],
          sync_state: "push_pending",
          hubStatus: "wontfix",
          wontfix: true,
        },
        remoteRefs: [{ url: "github#12" }],
      },
    ]);

    const edits: string[] = [];
    const closes: number[] = [];
    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 10,
          title: "Ready task",
          state: "OPEN",
          labels: ["needs-triage"],
          updatedAt: "2026-06-11T10:00:00Z",
        },
        {
          number: 11,
          title: "Done task",
          state: "OPEN",
          labels: ["ready-for-agent"],
          updatedAt: "2026-06-11T10:00:00Z",
        },
        {
          number: 12,
          title: "Wontfix task",
          state: "OPEN",
          labels: ["needs-triage"],
          updatedAt: "2026-06-11T10:00:00Z",
        },
      ],
      editIssue: (issueNumber, input) => {
        edits.push(`${issueNumber}:${input.addLabels?.join(",") ?? ""}`);
      },
      closeIssue: (issueNumber) => {
        closes.push(issueNumber);
      },
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(result.pushed.synced).toEqual(["bd-ready"]);
    expect([...result.pushed.closed].sort()).toEqual(["bd-done", "bd-wontfix"]);
    expect(closes.sort()).toEqual([11, 12]);
    expect(edits.some((entry) => entry.startsWith("10:ready-for-agent"))).toBe(
      true,
    );
    expect(edits.some((entry) => entry.startsWith("12:wontfix"))).toBe(true);

    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      id: string;
      metadata: { sync_state?: string; hubStatus?: string };
    }>;
    expect(
      state.find((task) => task.id === "bd-done")?.metadata.sync_state,
    ).toBe("synced");
    expect(
      state.find((task) => task.id === "bd-done")?.metadata.hubStatus,
    ).toBe("done");
  });

  it("uses metadata remote refs and pushes completed local tasks over open remote issues", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-done-wins-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, stateFile, updateArgsFile } = await createFakeBd(repoDir, [
      {
        id: "bd-done",
        title: "Done task",
        status: "closed",
        labels: ["done"],
        metadata: {
          remote_refs: ["github#20"],
          sync_state: "synced",
          hubStatus: "done",
          remote_updated_at: "2026-06-11T10:00:00Z",
        },
      },
    ]);

    const closes: number[] = [];
    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 20,
          title: "Done task",
          state: "OPEN",
          labels: ["ready-for-agent"],
          updatedAt: "2026-06-11T13:00:00Z",
        },
      ],
      editIssue: () => {},
      closeIssue: (issueNumber) => {
        closes.push(issueNumber);
      },
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(result.pulled.created).toEqual([]);
    expect(result.pulled.conflicts).toEqual([]);
    expect(result.pushed.closed).toEqual(["bd-done"]);
    expect(closes).toEqual([20]);
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      status: string;
      id: string;
      metadata: { hubStatus?: string; sync_state?: string };
    }>;
    const task = state.find((entry) => entry.id === "bd-done");
    expect(task?.metadata.hubStatus).toBe("done");
    expect(task?.metadata.sync_state).toBe("synced");
    expect(task?.status).toBe("closed");
  });

  it("records push_pending when remote close fails without reopening done tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-push-fail-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");
    const { binDir, stateFile, updateArgsFile } = await createFakeBd(repoDir, [
      {
        id: "bd-done",
        title: "Done task",
        status: "closed",
        labels: ["done"],
        metadata: {
          remote_refs: ["github#30"],
          sync_state: "push_pending",
          hubStatus: "done",
        },
        remoteRefs: [{ url: "github#30" }],
      },
    ]);

    const github: GithubIssueClient = {
      listIssues: () => [
        {
          number: 30,
          title: "Done task",
          state: "OPEN",
          labels: ["ready-for-agent"],
          updatedAt: "2026-06-11T10:00:00Z",
        },
      ],
      editIssue: () => {},
      closeIssue: () => {
        throw new Error("gh unavailable");
      },
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHLOOP_BD_PATH: join(binDir, "bd"),
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(result.pushed.pushPending).toEqual(["bd-done"]);
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      id: string;
      status: string;
      metadata: { hubStatus?: string; sync_state?: string };
    }>;
    const task = state.find((entry) => entry.id === "bd-done");
    expect(task?.metadata.hubStatus).toBe("done");
    expect(task?.metadata.sync_state).toBe("push_pending");
    expect(task?.status).toBe("closed");
  });
});
