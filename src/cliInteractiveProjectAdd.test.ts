import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { cli } from "./cli.js";
import { resolveHubProjectDevelopmentContractPath } from "./hubProjectDevelopmentContract.js";
import {
  resolveSelectedHubProject,
  listHubProjects,
} from "./hubProjectRegistry.js";
import { resolveGitRepoRoot } from "./projectStatus.js";

const mockText = vi.fn();
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockInitHubTaskStore = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    text: (...args: unknown[]) => mockText(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    confirm: (...args: unknown[]) => mockConfirm(...args),
  };
});

vi.mock("./hubTaskStore.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initHubTaskStore: (...args: unknown[]) => mockInitHubTaskStore(...args),
  };
});

const execAsync = async (dir: string, command: string) => {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(exec)(command, { cwd: dir });
};

const initRepo = async (dir: string) => {
  await execAsync(dir, "git init -b main");
  await execAsync(dir, 'git config user.email "test@test.com"');
  await execAsync(dir, 'git config user.name "Test"');
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(dir, `git add "${name}"`);
  await execAsync(dir, `git commit -m "${message}"`);
};

describe("archloop project add interactive onboarding", () => {
  let hostDir: string;
  let originalCwd: string;
  let originalStdinTTY: boolean | undefined;
  let originalStdoutTTY: boolean | undefined;
  let originalXdgDataHome: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalStdinTTY = process.stdin.isTTY;
    originalStdoutTTY = process.stdout.isTTY;
    originalXdgDataHome = process.env.XDG_DATA_HOME;

    hostDir = await mkdtemp(join(tmpdir(), "cli-project-add-"));
    process.env.XDG_DATA_HOME = join(hostDir, "xdg-data");
    process.chdir(hostDir);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    mockText.mockReset();
    mockSelect.mockReset();
    mockConfirm.mockReset();
    mockInitHubTaskStore.mockReset();
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
    vi.clearAllMocks();
  });

  it("uses repo-derived defaults and initializes the task store when accepted", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cli-project-add-repo-"));
    await initRepo(repoDir);
    await writeFile(
      join(repoDir, "package.json"),
      `${JSON.stringify({ name: "alpha-project" }, null, 2)}\n`,
    );
    await writeFile(join(repoDir, "pnpm-lock.yaml"), "lockfile\n");
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    mockText.mockImplementation(
      async (opts: { message: string; initialValue?: string }) => {
        if (opts.message === "Repo path") {
          return repoDir;
        }
        if (opts.message === "Hub project name") {
          expect(opts.initialValue).toBe("alpha-project");
          return "alpha";
        }
        throw new Error(`Unexpected text prompt: ${opts.message}`);
      },
    );
    mockSelect.mockImplementation(
      async (opts: { message: string; initialValue?: string }) => {
        expect(opts.message).toBe("Select a project profile:");
        expect(opts.initialValue).toBe("node");
        return "node";
      },
    );
    mockConfirm.mockImplementation(
      async (opts: { message: string; initialValue?: boolean }) => {
        expect(opts.message).toBe("Initialize the local task store now?");
        expect(opts.initialValue).toBe(true);
        return true;
      },
    );
    mockInitHubTaskStore.mockReturnValue({
      alreadyInitialized: false,
      output: "Initialized local Hub task store.\n",
    });

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli(["node", "archloop", "project", "add"]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
        return yield* Ref.get(ref);
      }),
    );

    expect(mockInitHubTaskStore).toHaveBeenCalledWith(
      resolveGitRepoRoot(repoDir),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining("Recommended Node project profile"),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "summary",
        title: "Hub project registered",
        rows: expect.objectContaining({
          Name: "alpha",
          "Project profile": "node",
          "Task store initialized": "yes",
        }),
      }),
    );

    const selected = resolveSelectedHubProject({
      env: process.env,
      homeDir: hostDir,
    });
    expect(selected?.name).toBe("alpha");

    const contract = JSON.parse(
      await readFile(
        resolveHubProjectDevelopmentContractPath(selected!.hubProjectDir),
        "utf8",
      ),
    ) as { projectProfile: string };
    expect(contract.projectProfile).toBe("node");
    expect(listHubProjects({ env: process.env, homeDir: hostDir })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "alpha",
          selected: true,
        }),
      ]),
    );
  });

  it("allows overriding the recommended profile and skipping task store init", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "cli-project-add-repo-"));
    await initRepo(repoDir);
    await writeFile(join(repoDir, "package.json"), "{}\n");
    await commitFile(repoDir, "hello.txt", "hello", "initial commit");

    mockText.mockImplementation(
      async (opts: { message: string; initialValue?: string }) => {
        if (opts.message === "Repo path") {
          return repoDir;
        }
        if (opts.message === "Hub project name") {
          return "beta";
        }
        throw new Error(`Unexpected text prompt: ${opts.message}`);
      },
    );
    mockSelect.mockImplementation(
      async (opts: { message: string; initialValue?: string }) => {
        expect(opts.message).toBe("Select a project profile:");
        expect(opts.initialValue).toBe("node");
        return "python";
      },
    );
    mockConfirm.mockImplementation(
      async (opts: { message: string; initialValue?: boolean }) => {
        expect(opts.message).toBe("Initialize the local task store now?");
        expect(opts.initialValue).toBe(true);
        return false;
      },
    );

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli(["node", "archloop", "project", "add"]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
        return yield* Ref.get(ref);
      }),
    );

    expect(mockInitHubTaskStore).not.toHaveBeenCalled();
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "summary",
        title: "Hub project registered",
        rows: expect.objectContaining({
          Name: "beta",
          "Project profile": "python",
          "Task store initialized": "no",
        }),
      }),
    );

    const selected = resolveSelectedHubProject({
      env: process.env,
      homeDir: hostDir,
    });
    expect(selected?.name).toBe("beta");

    const contract = JSON.parse(
      await readFile(
        resolveHubProjectDevelopmentContractPath(selected!.hubProjectDir),
        "utf8",
      ),
    ) as { projectProfile: string };
    expect(contract.projectProfile).toBe("python");
  });
});
