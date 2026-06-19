import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  HUB_TRIAGE_COMMENT_PREFIX,
  classifyHubTaskForTriage,
  formatHubTriageComment,
  isHubTriageComment,
  triageHubTasks,
} from "./hubTriage.js";
import { projectHubTask } from "./taskBoard.js";

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

describe("hub triage classification", () => {
  it("routes underspecified inbox tasks to needs_info", () => {
    const task = projectHubTask({
      id: "bd-1",
      title: "Fix login",
      status: "open",
      labels: ["needs-triage"],
    });

    const decision = classifyHubTaskForTriage(task);

    expect(decision.outcome).toBe("needs_info");
    expect(decision.summary).toContain("more information");
  });

  it("routes fully specified inbox tasks to ready_for_agent", () => {
    const task = projectHubTask({
      id: "bd-2",
      title: "Add retry to sync",
      status: "open",
      labels: ["needs-triage"],
      description:
        "When sync-out fails with ECONNRESET, retry up to three times before surfacing an error.",
    });

    expect(classifyHubTaskForTriage(task).outcome).toBe("ready_for_agent");
  });

  it("routes human-owned tasks to ready_for_human", () => {
    const task = projectHubTask({
      id: "bd-3",
      title: "Approve vendor contract",
      status: "open",
      labels: ["needs-triage"],
      description:
        "Human-owned procurement work. Review the vendor contract and sign off before agents wire the integration.",
      metadata: { kind: "human" },
    });

    expect(classifyHubTaskForTriage(task).outcome).toBe("ready_for_human");
  });

  it("routes explicit wontfix tasks to wontfix", () => {
    const task = projectHubTask({
      id: "bd-4",
      title: "Duplicate of issue 12",
      status: "open",
      labels: ["needs-triage"],
      description: "This is a duplicate report and should be marked wontfix.",
    });

    expect(classifyHubTaskForTriage(task).outcome).toBe("wontfix");
  });

  it("revisits needs_info tasks after new non-triage comments arrive", () => {
    const task = projectHubTask({
      id: "bd-5",
      title: "Clarify API shape",
      status: "open",
      labels: ["needs-info"],
      description:
        "Add pagination to the tasks list endpoint with cursor support and stable ordering.",
      comments: [
        {
          author: "triage",
          body: formatHubTriageComment("Need the expected response schema."),
        },
        {
          author: "reporter",
          body: "Use cursor + limit with JSON fields nextCursor and items.",
        },
      ],
    });

    expect(classifyHubTaskForTriage(task).outcome).toBe("ready_for_agent");
  });

  it("keeps needs_info tasks without new information in needs_info", () => {
    const task = projectHubTask({
      id: "bd-6",
      title: "Need details",
      status: "open",
      labels: ["needs-info"],
      comments: [
        {
          author: "triage",
          body: formatHubTriageComment("Need reproduction steps."),
        },
      ],
    });

    expect(classifyHubTaskForTriage(task).outcome).toBe("needs_info");
  });
});

describe("hub triage comments", () => {
  it("prefixes AI triage comments with the required disclaimer", () => {
    expect(formatHubTriageComment("Ready for agent implementation.")).toBe(
      `${HUB_TRIAGE_COMMENT_PREFIX}\n\nReady for agent implementation.`,
    );
    expect(
      isHubTriageComment(formatHubTriageComment("Needs reporter input.")),
    ).toBe(true);
    expect(isHubTriageComment("Reporter added more context.")).toBe(false);
  });
});

describe("triageHubTasks", () => {
  it("updates inbox and needs_info tasks, writes triage comments, and closes wontfix tasks", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "hub-triage-"));
    await initRepo(repoDir);
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

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
            id: "bd-inbox",
            title: "Add retry to sync",
            status: "open",
            labels: ["needs-triage"],
            metadata: { origin: "manual" },
            description:
              "When sync-out fails with ECONNRESET, retry up to three times before surfacing an error.",
          },
          {
            id: "bd-needs-info",
            title: "Clarify API shape",
            status: "open",
            labels: ["needs-info"],
            metadata: {},
            description:
              "Add pagination to the tasks list endpoint with cursor support and stable ordering.",
            comments: [
              {
                author: "triage",
                body: `${HUB_TRIAGE_COMMENT_PREFIX}\n\nNeed the expected response schema.`,
              },
              {
                author: "reporter",
                body: "Use cursor + limit with JSON fields nextCursor and items.",
              },
            ],
          },
          {
            id: "bd-wontfix",
            title: "Duplicate of issue 12",
            status: "open",
            labels: ["needs-triage"],
            metadata: {},
            description: "Duplicate report; mark wontfix.",
          },
          {
            id: "bd-ready",
            title: "Already ready",
            status: "open",
            labels: ["ready-for-agent"],
            metadata: {},
            description: "Already triaged.",
          },
        ],
        null,
        2,
      ),
    );

    const updateArgsFile = join(repoDir, "bd-update-args.txt");
    const commentArgsFile = join(repoDir, "bd-comment-args.txt");
    await writeFile(updateArgsFile, "");
    await writeFile(commentArgsFile, "");

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const updateArgsFile = process.env.BD_UPDATE_ARGS_FILE;
const commentArgsFile = process.env.BD_COMMENT_ARGS_FILE;
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
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = JSON.parse(args[metadataIndex + 1]);
  }
  for (let index = 0; index < args.length; index += 1) {
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

if (command === "comments" && args[1] === "add") {
  fs.appendFileSync(commentArgsFile, args.join(" ") + "\\n");
  const taskId = args[2];
  const body = args.slice(3).join(" ");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.find((entry) => entry.id === taskId);
  if (!task) {
    process.exit(1);
  }
  task.comments = [...(task.comments ?? []), { author: "triage", body }];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
}

process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const result = await triageHubTasks({
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SANDCASTLE_BD_PATH: bdPath,
        BD_STATE_FILE: stateFile,
        BD_UPDATE_ARGS_FILE: updateArgsFile,
        BD_COMMENT_ARGS_FILE: commentArgsFile,
      },
    });

    expect(result.triaged.map((entry) => entry.taskId).sort()).toEqual([
      "bd-inbox",
      "bd-needs-info",
      "bd-wontfix",
    ]);
    expect(result.triaged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "bd-inbox",
          priorStatus: "inbox",
          outcome: "ready_for_agent",
        }),
        expect.objectContaining({
          taskId: "bd-needs-info",
          priorStatus: "needs_info",
          outcome: "ready_for_agent",
        }),
        expect.objectContaining({
          taskId: "bd-wontfix",
          priorStatus: "inbox",
          outcome: "wontfix",
        }),
      ]),
    );

    const updateArgs = await readFile(updateArgsFile, "utf-8");
    expect(updateArgs).toContain("bd-inbox");
    expect(updateArgs).toContain("--add-label ready-for-agent");
    expect(updateArgs).toContain("bd-needs-info");
    expect(updateArgs).toContain("bd-wontfix");
    expect(updateArgs).toContain("--status closed");
    expect(updateArgs).toContain("--add-label wontfix");

    const commentArgs = await readFile(commentArgsFile, "utf-8");
    expect(commentArgs).toContain(HUB_TRIAGE_COMMENT_PREFIX);
    expect(
      (commentArgs.match(/This was generated by AI during triage/g) ?? [])
        .length,
    ).toBe(3);
  });
});
