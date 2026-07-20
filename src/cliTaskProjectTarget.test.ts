import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { exec } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { cli } from "./cli.js";
import { registerHubProject, selectHubProject } from "./hubProjectRegistry.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";
import { resolveGitRepoRoot } from "./projectStatus.js";

const mockSelect = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    select: (...args: unknown[]) => mockSelect(...args),
  };
});

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

const runCli = async (
  args: string[],
): Promise<ReadonlyArray<DisplayEntry>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
      yield* cli(["node", "archloop", ...args]).pipe(
        Effect.provide(SilentDisplay.layer(ref)),
        Effect.provide(NodeContext.layer),
      );
      return yield* Ref.get(ref);
    }),
  );

describe("archloop task commands target the selected Hub project", () => {
  let hostDir: string;
  let originalCwd: string;
  let originalStdinTTY: boolean | undefined;
  let originalStdoutTTY: boolean | undefined;
  let originalXdgDataHome: string | undefined;
  let originalPath: string | undefined;
  let originalBdPath: string | undefined;
  let repoAlpha: string;
  let repoBeta: string;
  let otherDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalStdinTTY = process.stdin.isTTY;
    originalStdoutTTY = process.stdout.isTTY;
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    originalPath = process.env.PATH;
    originalBdPath = process.env.ARCHLOOP_BD_PATH;

    hostDir = await mkdtemp(join(tmpdir(), "cli-task-target-"));
    otherDir = await mkdtemp(join(tmpdir(), "cli-task-other-"));
    repoAlpha = join(hostDir, "repo-alpha");
    repoBeta = join(hostDir, "repo-beta");
    await mkdir(repoAlpha, { recursive: true });
    await mkdir(repoBeta, { recursive: true });
    await initRepo(repoAlpha);
    await initRepo(repoBeta);
    await commitFile(repoAlpha, "alpha.txt", "alpha", "initial alpha");
    await commitFile(repoBeta, "beta.txt", "beta", "initial beta");
    const repoAlphaRoot = resolveGitRepoRoot(repoAlpha);
    const repoBetaRoot = resolveGitRepoRoot(repoBeta);
    seedHubTaskStoreMetadata(repoAlphaRoot);
    seedHubTaskStoreMetadata(repoBetaRoot);

    process.env.XDG_DATA_HOME = join(hostDir, "xdg-data");
    process.chdir(otherDir);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    mockSelect.mockReset();

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const cwd = process.cwd();
const repoAlpha = ${JSON.stringify(repoAlphaRoot)};
const repoBeta = ${JSON.stringify(repoBetaRoot)};
const args = process.argv.slice(2);
const command = args[0];

const readTask = () => {
  if (cwd === repoAlpha) {
    return {
      id: "bd-a",
      title: "Alpha task",
      status: "open",
      labels: [],
      metadata: { execution_mode: "agent" },
      description: "Alpha task description",
      comments: [],
      remoteRefs: [],
      runRefs: [],
    };
  }
  if (cwd === repoBeta) {
    return {
      id: "bd-b",
      title: "Beta task",
      status: "open",
      labels: ["ready-for-agent"],
      metadata: { execution_mode: "agent" },
      description: "Beta task description",
      comments: [],
      remoteRefs: [],
      runRefs: [],
    };
  }
  return undefined;
};

if (command === "list") {
  const task = readTask();
  if (!task) {
    process.stderr.write("unexpected cwd");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "show") {
  const task = readTask();
  if (!task) {
    process.stderr.write("unexpected cwd");
    process.exit(1);
  }
  const selector = args[1];
  if (selector !== task.id && selector !== task.title) {
    process.stderr.write("unexpected selector");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

process.stderr.write("unsupported command");
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.ARCHLOOP_BD_PATH = bdPath;

    registerHubProject({
      repoPath: repoAlphaRoot,
      projectName: "alpha",
      env: process.env,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    registerHubProject({
      repoPath: repoBetaRoot,
      projectName: "beta",
      env: process.env,
      now: new Date("2026-07-04T12:01:00.000Z"),
    });
    selectHubProject({
      projectSelector: "beta",
      env: process.env,
      now: new Date("2026-07-04T12:02:00.000Z"),
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinTTY,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutTTY,
    });
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalBdPath === undefined) {
      delete process.env.ARCHLOOP_BD_PATH;
    } else {
      process.env.ARCHLOOP_BD_PATH = originalBdPath;
    }
    vi.clearAllMocks();
  });

  it("uses the selected Hub project from any directory", async () => {
    const entries = await runCli(["tasks", "list"]);
    const section = entries.find(
      (entry): entry is Extract<DisplayEntry, { _tag: "section" }> =>
        entry._tag === "section",
    );
    expect(section).toBeDefined();
    const itemIds = section!.blocks.flatMap((block) =>
      block.kind === "group" ? block.items.map((item) => item.id) : [],
    );
    const itemTitles = section!.blocks.flatMap((block) =>
      block.kind === "group" ? block.items.map((item) => item.title) : [],
    );
    expect(itemIds).toContain("bd-b");
    expect(itemTitles).toContain("Beta task");
    expect(itemIds).not.toContain("bd-a");
    expect(itemTitles).not.toContain("Alpha task");
    expect(section!.blocks).toContainEqual(
      expect.objectContaining({
        kind: "header",
        title: "archLoop",
        subtitle: "beta",
      }),
    );
  });

  it("accepts --project as an explicit override without disturbing selectors", async () => {
    const entries = await runCli([
      "tasks",
      "show",
      "--project",
      "alpha",
      "Alpha task",
    ]);

    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "summary",
        title: "Beads task bd-a",
      }),
    );
  });

  it("opens the project picker in TTYs when no project is selected", async () => {
    await unlink(
      join(process.env.XDG_DATA_HOME!, "archloop", "hub", "selected-project.json"),
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    mockSelect.mockResolvedValue("alpha");

    const entries = await runCli(["tasks", "list"]);
    const section = entries.find(
      (entry): entry is Extract<DisplayEntry, { _tag: "section" }> =>
        entry._tag === "section",
    );
    expect(section).toBeDefined();

    expect(mockSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a Hub project:",
      }),
    );
    const itemIds = section!.blocks.flatMap((block) =>
      block.kind === "group" ? block.items.map((item) => item.id) : [],
    );
    expect(itemIds).toContain("bd-a");
    expect(section!.blocks).toContainEqual(
      expect.objectContaining({
        kind: "header",
        title: "archLoop",
        subtitle: "alpha",
      }),
    );
  });

  it("fails in non-interactive mode when no project is selected", async () => {
    await unlink(
      join(process.env.XDG_DATA_HOME!, "archloop", "hub", "selected-project.json"),
    );

    await expect(runCli(["tasks", "list"])).rejects.toMatchObject({
      message:
        "No selected Hub project exists. Run `archloop project add` to register one, `archloop project select <name>` to choose one, or pass `--project <name>`.",
    });
  });
});
