import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
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
        labels: ["needs-triage", "Sandcastle"],
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
    expect(detectSemanticSyncConflict("done", "ready_for_agent")).toContain(
      "local done",
    );
    expect(
      detectSemanticSyncConflict("ready_for_agent", "needs_info"),
    ).toContain("disagrees");
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
    const binDir = join(repoDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await execAsync(`ln -sf "${gitPath}" "${join(binDir, "git")}"`);

    const stateFile = join(repoDir, "bd-state.json");
    const createArgsFile = join(repoDir, "bd-create-args.txt");
    const updateArgsFile = join(repoDir, "bd-update-args.txt");
    await writeFile(stateFile, JSON.stringify(initialState, null, 2));
    await writeFile(createArgsFile, "");
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
  const metadataIndex = args.indexOf("--set-metadata");
  if (metadataIndex >= 0) {
    task.metadata = JSON.parse(args[metadataIndex + 1]);
    if (task.metadata.remote_refs) {
      task.remoteRefs = task.metadata.remote_refs.map((url) => ({ url }));
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--add-labels") {
      const label = args[index + 1];
      task.labels = [...new Set([...(task.labels ?? []), label])];
    }
    if (args[index] === "--remove-labels") {
      const labels = args[index + 1].split(",");
      task.labels = (task.labels ?? []).filter(
        (entry) => !labels.includes(entry),
      );
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
        labels: ["Sandcastle", "ready-for-agent"],
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

  it("marks semantic conflicts as sync_conflict without downgrading done tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-sync-conflict-"));
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
        },
        remoteRefs: [{ url: "github#20" }],
      },
    ]);

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
      closeIssue: () => {},
    };

    const result = await syncHubTasksWithGithub({
      cwd: repoDir,
      github,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
      },
    });

    expect(result.pulled.conflicts).toEqual(["bd-done"]);
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      id: string;
      status: string;
      labels: string[];
      metadata: { hubStatus?: string; sync_state?: string };
    }>;
    const task = state.find((entry) => entry.id === "bd-done");
    expect(task?.metadata.hubStatus).toBe("done");
    expect(task?.metadata.sync_state).toBe("conflict");
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
