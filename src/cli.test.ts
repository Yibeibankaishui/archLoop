import { exec } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { describe, expect, it, vi } from "vitest";

import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { seedHubTaskStoreMetadata } from "./hubTaskStore.js";

const execAsync = promisify(exec);
vi.setConfig({ testTimeout: 60_000 });

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

const seedSandcastlePackage = async (dir: string) => {
  const { version } = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf-8"),
  ) as { version: string };

  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "cli-host",
        private: true,
        scripts: {
          sandcastle: "tsx .sandcastle/main.mts",
        },
        devDependencies: {
          "@ai-hero/sandcastle": `^${version}`,
          tsx: "^4.21.0",
        },
      },
      null,
      2,
    )}\n`,
  );
};

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (args: string, cwd: string, env?: NodeJS.ProcessEnv) =>
  execAsync(`"${process.execPath}" ${cliPath} ${args}`, {
    cwd,
    env: env ?? { ...process.env, XDG_DATA_HOME: join(cwd, ".test-xdg-data") },
  });

const runNonInteractiveInit = (cwd: string, args: string) =>
  runCli(
    `init --sandbox docker --backlog beads --template blank --preset-agents none --build-image false ${args}`,
    cwd,
  );

const cliFailureOutput = (err: unknown): string => {
  if (
    typeof err === "object" &&
    err !== null &&
    "stdout" in err &&
    "stderr" in err
  ) {
    const failure = err as Partial<Record<"stdout" | "stderr", unknown>>;
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    return stdout + stderr;
  }

  throw err;
};

const seedHubTaskStore = seedHubTaskStoreMetadata;

const withBdEnv = (
  bdPath: string,
  repoDirOrEnv?: string | NodeJS.ProcessEnv,
  maybeEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  let repoDir: string | undefined;
  let mergedEnv: NodeJS.ProcessEnv = {};

  if (typeof repoDirOrEnv === "string") {
    repoDir = repoDirOrEnv;
    mergedEnv = maybeEnv ?? {};
  } else if (repoDirOrEnv) {
    mergedEnv = repoDirOrEnv;
  }

  if (repoDir) {
    seedHubTaskStore(repoDir);
  }

  return {
    ...process.env,
    ...mergedEnv,
    PATH: `${dirname(bdPath)}:${mergedEnv.PATH ?? process.env.PATH ?? ""}`,
    SANDCASTLE_BD_PATH: bdPath,
  };
};

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).toContain("run");
    expect(stdout).not.toMatch(/-\s+interactive(?:\s|\[|$)/);
    // build-image and remove-image are namespaced under docker, not top-level
    expect(stdout).toContain("docker build-image");
    expect(stdout).toContain("docker remove-image");
    // Old command names should not be exposed
    expect(stdout).not.toContain("setup-sandbox");
    expect(stdout).not.toContain("cleanup-sandbox");
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("docker --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("docker --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("docker build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("docker build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toContain("No .sandcastle/ found");
    }
  });

  it("init --help shows --template flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--template");
  });

  it("init --help exposes --agent flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--agent");
  });

  it("init --help exposes --model flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--model");
  });

  it("init --help exposes --runtimes flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--runtimes");
  });

  it("init --help exposes --installed-runtimes alias", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--installed-runtimes");
  });

  it("init --help exposes --project-profile flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--project-profile");
  });

  it("init --help exposes --capability flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--capability");
  });

  it("root help exposes the project namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("project");
    expect(stdout).toContain("project status");
  });

  it("root help exposes the agent-config namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("agent-config");
    expect(stdout).toContain("agent-config path");
    expect(stdout).toContain("agent-config show");
    expect(stdout).toContain("agent-config init");
    expect(stdout).toContain("agent-config set-role");
  });

  it("root help exposes the env namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("env");
    expect(stdout).toContain("env path");
    expect(stdout).toContain("env show");
    expect(stdout).toContain("env init");
    expect(stdout).toContain("env set");
  });

  it("root help exposes the auth namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("auth");
    expect(stdout).toContain("auth show");
    expect(stdout).toContain("auth path");
    expect(stdout).toContain("auth login");
  });

  it("env path prints the Hub env file path", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-hub-env-"));
    const dataDir = join(hostDir, "xdg-data");
    const { stdout } = await runCli("env path", hostDir, {
      ...process.env,
      XDG_DATA_HOME: dataDir,
    });
    expect(stdout).toContain(join(dataDir, "sandcastle", ".env"));
  });

  it("env show reports missing Hub env file guidance", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-hub-env-"));
    const dataDir = join(hostDir, "xdg-data");
    const { stdout } = await runCli("env show", hostDir, {
      ...process.env,
      XDG_DATA_HOME: dataDir,
    });
    expect(stdout).toContain("CURSOR_API_KEY");
    expect(stdout).toContain("sandcastle env init");
  });

  it("env set persists a Hub env value", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-hub-env-"));
    const dataDir = join(hostDir, "xdg-data");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const { stdout } = await runCli(
      "env set CURSOR_API_KEY test-cursor-key",
      hostDir,
      env,
    );
    expect(stdout).toContain("Saved CURSOR_API_KEY");

    const show = await runCli("env show", hostDir, env);
    expect(show.stdout).toContain("CURSOR_API_KEY");
    expect(show.stdout).toContain("test");
  });

  it("env init non-interactive guidance points Codex users to auth login", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-hub-env-"));
    const dataDir = join(hostDir, "xdg-data");

    try {
      await runCli("env init", hostDir, {
        ...process.env,
        XDG_DATA_HOME: dataDir,
      });
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toContain("sandcastle env set <key> <value>");
      expect(output).toContain("sandcastle auth login codex");
      expect(output).toMatch(/OPENAI_KEY.*API billing/i);
    }
  });

  it("auth path prints Hub-owned provider auth directories", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-hub-auth-"));
    const dataDir = join(hostDir, "xdg-data");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    const codex = await runCli("auth path codex", hostDir, env);
    expect(codex.stdout).toContain(
      join(dataDir, "sandcastle", "hub", "auth", "codex"),
    );

    const github = await runCli("auth path github", hostDir, env);
    expect(github.stdout).toContain(
      join(dataDir, "sandcastle", "hub", "auth", "github"),
    );
  });

  it("auth show reports process env, Hub env file, Hub auth session, and missing guidance", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-hub-auth-"));
    const dataDir = join(hostDir, "xdg-data");
    const authDir = join(dataDir, "sandcastle", "hub", "auth", "github");
    await mkdir(authDir, { recursive: true });
    await writeFile(join(authDir, "hosts.yml"), "github.com: {}\n");
    await writeFile(
      join(dataDir, "sandcastle", ".env"),
      "CURSOR_API_KEY=hub-cursor-key\n",
    );

    const { stdout } = await runCli("auth show", hostDir, {
      ...process.env,
      XDG_DATA_HOME: dataDir,
      OPENAI_KEY: "runtime-openai-key",
      GH_TOKEN: "",
      CURSOR_API_KEY: "",
      OPENCODE_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    });

    expect(stdout).toContain("codex: process env OPENAI_KEY=");
    expect(stdout).toContain("github: Hub auth dir/session");
    expect(stdout).toContain(join(dataDir, "sandcastle", "hub", "auth"));
    expect(stdout).toContain("cursor: Hub env file CURSOR_API_KEY=");
    expect(stdout).toContain("opencode: missing");
    expect(stdout).toContain("sandcastle env set OPENCODE_API_KEY <value>");
  });

  it("auth login fails with actionable commands in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-hub-auth-"));
    const dataDir = join(hostDir, "xdg-data");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };

    try {
      await runCli("auth login codex", hostDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toMatch(/Interactive codex login requires a TTY/i);
      expect(output).toContain(
        `CODEX_HOME=${join(dataDir, "sandcastle", "hub", "auth", "codex")} codex login`,
      );
      expect(output).toContain("sandcastle env set OPENAI_KEY <value>");
      expect(output).toMatch(/API billing|Codex\/ChatGPT CLI login/i);
    }

    try {
      await runCli("auth login github", hostDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toMatch(/Interactive github login requires a TTY/i);
      expect(output).toContain(
        `GH_CONFIG_DIR=${join(dataDir, "sandcastle", "hub", "auth", "github")} gh auth login --insecure-storage`,
      );
      expect(output).toContain("sandcastle env set GH_TOKEN <value>");
    }
  });

  it("agent-config path prints the Hub agent config file path", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-agent-config-"));
    const dataDir = join(hostDir, "xdg-data");
    const { stdout } = await runCli("agent-config path", hostDir, {
      ...process.env,
      XDG_DATA_HOME: dataDir,
    });
    expect(stdout).toContain(
      join(dataDir, "sandcastle", "hub", "agent-roles.json"),
    );
  });

  it("agent-config show reports missing roles from an empty config", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-agent-config-"));
    const dataDir = join(hostDir, "xdg-data");
    const { stdout } = await runCli("agent-config show", hostDir, {
      ...process.env,
      XDG_DATA_HOME: dataDir,
    });
    expect(stdout).toContain("Configured roles:");
    expect(stdout).toContain("planning: (missing)");
    expect(stdout).toContain("Missing roles:");
  });

  it("agent-config set-role persists provider and model settings", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-agent-config-"));
    const dataDir = join(hostDir, "xdg-data");
    const env = { ...process.env, XDG_DATA_HOME: dataDir };
    const { stdout } = await runCli(
      "agent-config set-role planning --provider codex --model gpt-5.4-mini --options effort=medium",
      hostDir,
      env,
    );
    expect(stdout).toContain("Saved Hub agent role planning");
    expect(stdout).toContain("codex");
    expect(stdout).toContain("effort=medium");

    const show = await runCli("agent-config show", hostDir, env);
    expect(show.stdout).toContain(
      "planning: codex / gpt-5.4-mini (effort=medium)",
    );
  });

  it("agent-config set-role rejects invalid roles", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-agent-config-"));
    const dataDir = join(hostDir, "xdg-data");
    try {
      await runCli(
        "agent-config set-role invalid --provider codex --model gpt-5.4-mini",
        hostDir,
        { ...process.env, XDG_DATA_HOME: dataDir },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toMatch(/Unknown Hub agent role/i);
    }
  });

  it("agent-config set-role fails clearly without flags in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-agent-config-"));
    const dataDir = join(hostDir, "xdg-data");
    try {
      await runCli("agent-config set-role planning", hostDir, {
        ...process.env,
        XDG_DATA_HOME: dataDir,
      });
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toMatch(/non-interactive/i);
      expect(output).toMatch(
        /sandcastle agent-config set-role planning --provider/i,
      );
    }
  });

  it("run --flow prd-decomposition validates readable PRD input before execution", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-run-flow-input-"));
    await initRepo(hostDir);
    await mkdir(join(hostDir, "docs"), { recursive: true });
    await writeFile(
      join(hostDir, "docs", "feature.md"),
      "# PRD: Feature\n\n## Tasks\n\n- [ ] Build it\n",
    );

    try {
      await runCli(
        "run . --flow prd-decomposition --input docs/feature.md",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toMatch(
        /PRD input: docs\/feature.md|Missing Hub agent role config: planning/i,
      );
    }
  });

  it("run --flow prd-decomposition rejects missing required input", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-run-flow-input-"));
    await initRepo(hostDir);

    try {
      await runCli("run . --flow prd-decomposition", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toMatch(/PRD file path is required/i);
    }
  });

  it("run --flow triage --input bd-42 dispatches with task id selection", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-run-flow-triage-id-"));
    await initRepo(hostDir);

    const runTriage = vi.fn().mockResolvedValue({
      outcome: "applied",
      runId: "run-triage-42",
      runDir: join(hostDir, ".sandcastle", "runs", "run-triage-42"),
      proposal: {
        summary: "Single task triage.",
        decisions: [
          {
            taskId: "bd-42",
            outcome: "ready_for_agent",
            category: "enhancement",
            confidence: "high",
            rationale: "Fully specified AFK-safe work.",
            comment: "Ready for implementation.",
          },
        ],
      },
      appliedDecisions: ["bd-42"],
      skippedDecisions: [],
      skippedDependencies: [],
      dependencies: [],
    });

    vi.resetModules();
    vi.doMock("./hubTriageProposalCli.js", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        runTriageProposalFlowFromCli: runTriage,
      };
    });

    const { cli } = await import("./cli.js");

    const previousCwd = process.cwd();
    process.chdir(hostDir);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ref = yield* Ref.make([] as ReadonlyArray<DisplayEntry>);
          yield* cli([
            "node",
            "sandcastle",
            "run",
            ".",
            "--flow",
            "triage",
            "--input",
            "bd-42",
          ]).pipe(
            Effect.provide(SilentDisplay.layer(ref)),
            Effect.provide(NodeContext.layer),
          );
        }),
      );
    } finally {
      process.chdir(previousCwd);
      vi.doUnmock("./hubTriageProposalCli.js");
      vi.resetModules();
    }

    expect(runTriage).toHaveBeenCalledOnce();
    expect(runTriage.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["bd-42"],
      query: undefined,
      yes: false,
    });
    expect(runTriage.mock.calls[0]?.[0].cwd).toContain(
      "cli-run-flow-triage-id-",
    );
  });

  it("run --flow triage defaults task query to inbox and needs_info", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-run-flow-input-"));
    await initRepo(hostDir);

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    try {
      await runCli("run . --flow triage", hostDir, withBdEnv(bdPath, hostDir));
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toMatch(
        /Task query: inbox,needs_info|Missing Hub agent role config: triage|No tasks matched triage selection/i,
      );
    }
  });

  it("run --flow no-review rejects unsupported --input values", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-run-flow-input-"));
    await initRepo(hostDir);

    try {
      await runCli("run . --flow no-review --input docs/feature.md", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toMatch(/does not accept --input/i);
    }
  });

  it("root help exposes the tasks namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("tasks");
    expect(stdout).toContain("tasks init");
    expect(stdout).toContain("tasks list");
    expect(stdout).toContain("tasks show");
    expect(stdout).toContain("tasks create");
    expect(stdout).toContain("tasks triage");
    expect(stdout).toContain("tasks from-prd");
    expect(stdout).toContain("tasks sync");
    expect(stdout).toContain("tasks comment");
    expect(stdout).toContain("tasks delete");
  });

  it("project --help shows the status subcommand", async () => {
    const { stdout } = await runCli("project --help", process.cwd());
    expect(stdout).toContain("status");
  });

  it("tasks --help shows the list, sync, pull, and push subcommands", async () => {
    const { stdout } = await runCli("tasks --help", process.cwd());
    expect(stdout).toContain("init");
    expect(stdout).toContain("list");
    expect(stdout).toContain("show");
    expect(stdout).toContain("create");
    expect(stdout).toContain("triage");
    expect(stdout).toContain("from-prd");
    expect(stdout).toContain("pull");
    expect(stdout).toContain("push");
    expect(stdout).toContain("sync");
    expect(stdout).toContain("comment");
    expect(stdout).toContain("delete");
  });

  it("init --help no longer advertises podman as a sandbox option", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("Sandbox provider");
    expect(stdout).toContain("no-sandbox");
    expect(stdout).not.toContain("docker or podman");
  });

  it("init --template nonexistent produces error listing available templates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent claude-code --template nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toContain("nonexistent");
      expect(output).toContain("blank");
      expect(output).toContain("simple-loop");
    }
  });

  it("old top-level build-image command no longer works", async () => {
    try {
      await runCli("build-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      // Command should fail since build-image is no longer a top-level command
      expect(err).toBeDefined();
    }
  });

  it("old top-level remove-image command no longer works", async () => {
    try {
      await runCli("remove-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
  });

  it("project status works from a git repo that has not run init", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const dataDir = join(hostDir, "xdg-data");
    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));
    const { stdout } = await runCli("project status", hostDir, {
      ...process.env,
      XDG_DATA_HOME: dataDir,
      PATH: binDir,
    });

    expect(stdout).toContain("Hub project status");
    expect(stdout).toContain(hostDir);
    expect(stdout).toContain("xdg-data/sandcastle");
    expect(stdout).toContain("Beads available");
    expect(stdout).toContain("Task store initialized");
    expect(stdout).toContain("Task board ready");
    expect(stdout).toContain("Task board total");
  });

  it("tasks list points to sandcastle tasks init when the task store is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
process.stderr.write("Error: no beads database found\\n");
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    try {
      await runCli("tasks list", hostDir, {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SANDCASTLE_BD_PATH: bdPath,
      });
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toContain("sandcastle tasks init");
      expect(cliFailureOutput(err)).not.toContain("bd init");
    }
  });

  it("tasks init initializes a fresh git repo and tasks list succeeds afterward", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const bundledBd = join(
      process.cwd(),
      "node_modules",
      "@beads",
      "bd",
      "bin",
      "bd",
    );
    await access(bundledBd);

    const { stdout: initStdout } = await runCli("tasks init", hostDir, {
      ...process.env,
      SANDCASTLE_BD_PATH: bundledBd,
      PATH: `${join(hostDir, "bin")}:${process.env.PATH ?? ""}`,
    });
    expect(initStdout).toContain("Initialized local Hub task store");

    const boardJson = JSON.stringify([]);
    const mockBdPath = join(hostDir, "bin", "bd");
    await mkdir(join(hostDir, "bin"), { recursive: true });
    await writeFile(
      mockBdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\\n' '${boardJson}'
  exit 0
fi
exit 1
`,
    );
    await chmod(mockBdPath, 0o755);

    const { stdout } = await runCli(
      "tasks list",
      hostDir,
      withBdEnv(mockBdPath, hostDir),
    );
    expect(stdout).toContain("Hub task board");
    expect(stdout).toContain("No Beads tasks found");
  });

  it("tasks list groups representative Beads tasks by Hub status", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const boardJson = JSON.stringify([
      { id: "bd-1", title: "Inbox task", status: "open" },
      {
        id: "bd-2",
        title: "Ready task",
        status: "open",
        labels: ["ready-for-agent"],
      },
      {
        id: "bd-3",
        title: "Done task",
        status: "closed",
        labels: ["done"],
      },
    ]);
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\n' '${boardJson}'
  exit 0
fi
if [ "$1" = "show" ]; then
  printf '%s\n' '${JSON.stringify([
    {
      id: "bd-3",
      title: "Done task",
      status: "closed",
      labels: ["done"],
      metadata: { execution_mode: "agent" },
      description: "Task description",
      notes: "Task notes",
      comments: [
        {
          author: "alice",
          body: "Looks good",
          createdAt: "2026-06-11T15:00:00Z",
        },
      ],
      remoteRefs: [{ url: "github#64" }],
      runRefs: [{ ref: "run-123" }],
    },
  ])}'
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks list",
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    expect(stdout).toContain("Hub task board");
    expect(stdout).toContain("Total tasks: 3");
    expect(stdout).toContain("inbox (1)");
    expect(stdout).toContain("ready_for_agent (1)");
    expect(stdout).toContain("done (1)");
    expect(stdout).toContain("  1. bd-1: Inbox task");
    expect(stdout).toContain("  2. bd-2: Ready task");
    expect(stdout).toContain("  3. bd-3: Done task");
  });

  it("tasks list --warning filters tasks by PRD warning severity", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const boardJson = JSON.stringify([
      {
        id: "bd-1",
        title: "High warning task",
        status: "open",
        metadata: {
          slice_temp_id: "slice-1",
          warning_severity: "high",
          warning_message: "Scope unclear",
        },
      },
      {
        id: "bd-2",
        title: "Medium warning task",
        status: "open",
        labels: ["ready-for-agent"],
        metadata: {
          slice_temp_id: "slice-2",
          warning_severity: "medium",
          warning_message: "Missing deps",
        },
      },
    ]);
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\\n' '${boardJson}'
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks list --warning high",
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    expect(stdout).toContain("PRD warnings: 1 high · 0 medium · 0 low");
    expect(stdout).toContain("  1. bd-1: High warning task [high]");
    expect(stdout).not.toContain("bd-2");
  });

  it("tasks show renders Beads details, comments, remote refs, and run refs", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  cat <<'JSON'
[
  {
    "id": "bd-3",
    "title": "Done task",
    "status": "closed",
    "labels": ["done"]
  }
]
JSON
  exit 0
fi
if [ "$1" = "show" ] && [ "$2" = "bd-3" ]; then
  cat <<'JSON'
[
  {
    "id": "bd-3",
    "title": "Done task",
    "status": "closed",
    "labels": ["done"],
    "metadata": { "execution_mode": "agent" },
    "description": "Task description",
    "notes": "Task notes",
    "comments": [
      {
        "author": "alice",
        "body": "Looks good",
        "createdAt": "2026-06-11T15:00:00Z"
      }
    ],
    "remoteRefs": [
      { "url": "github#64" }
    ],
    "runRefs": [
      { "ref": "run-123" }
    ]
  }
]
JSON
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks show bd-3",
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    expect(stdout).toContain("Beads task bd-3");
    expect(stdout).toContain("Hub status");
    expect(stdout).toContain("done");
    expect(stdout).toContain("Description");
    expect(stdout).toContain("Task description");
    expect(stdout).toContain("Notes");
    expect(stdout).toContain("Task notes");
    expect(stdout).toContain("Labels");
    expect(stdout).toContain("done");
    expect(stdout).toContain("Metadata");
    expect(stdout).toContain("execution_mode");
    expect(stdout).toContain("Remote refs");
    expect(stdout).toContain("github#64");
    expect(stdout).toContain("Run refs");
    expect(stdout).toContain("run-123");
    expect(stdout).toContain("Comments");
    expect(stdout).toContain("alice");
    expect(stdout).toContain("Looks good");
  });

  it("tasks show resolves exact titles and list indices and uses supported Beads flags", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const showArgsFile = join(hostDir, "show-args.txt");
    const boardJson = JSON.stringify([
      { id: "bd-1", title: "Inbox task", status: "open" },
      {
        id: "bd-2",
        title: "Write docs",
        status: "open",
        labels: ["ready-for-agent"],
      },
      { id: "bd-3", title: "Done task", status: "closed", labels: ["done"] },
    ]);
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\n' '${boardJson}'
  exit 0
fi
if [ "$1" = "show" ] && [ "$2" = "bd-2" ]; then
  printf '%s\n' "$*" >> "${showArgsFile}"
  cat <<'JSON'
[
  {
    "id": "bd-2",
    "title": "Write docs",
    "status": "open",
    "labels": ["ready-for-agent"],
    "metadata": { "execution_mode": "agent" },
    "description": "Task description",
    "comments": [],
    "remoteRefs": [],
    "runRefs": []
  }
]
JSON
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const titleResult = await runCli(
      'tasks show "Write docs"',
      hostDir,
      withBdEnv(bdPath, hostDir),
    );
    expect(titleResult.stdout).toContain("Beads task bd-2");

    const indexResult = await runCli(
      "tasks show 2",
      hostDir,
      withBdEnv(bdPath, hostDir),
    );
    expect(indexResult.stdout).toContain("Beads task bd-2");

    const showArgs = await readFile(showArgsFile, "utf-8");
    expect(showArgs).toContain("show bd-2 --json --long");
    expect(showArgs).toContain("show bd-2 --json --thread");
    expect(showArgs).toContain("show bd-2 --json --refs");
    expect(showArgs).not.toContain("--long --thread");
    expect(showArgs).not.toContain("--include-comments");
    expect(showArgs).not.toContain("--include-dependents");
  });

  it("tasks show still renders primary details when optional Beads thread lookup fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  cat <<'JSON'
[
  {
    "id": "bd-2",
    "title": "Write docs",
    "status": "open",
    "labels": ["ready-for-agent"]
  }
]
JSON
  exit 0
fi
if [ "$1" = "show" ] && [ "$2" = "bd-2" ] && [ "$4" = "--long" ]; then
  cat <<'JSON'
[
  {
    "id": "bd-2",
    "title": "Write docs",
    "status": "open",
    "labels": ["ready-for-agent"],
    "description": "Primary details"
  }
]
JSON
  exit 0
fi
if [ "$1" = "show" ] && [ "$2" = "bd-2" ] && [ "$4" = "--thread" ]; then
  cat >&2 <<'JSON'
{
  "error": "fetching message bd-2: not found: issue bd-2",
  "schema_version": 1
}
JSON
  exit 1
fi
if [ "$1" = "show" ] && [ "$2" = "bd-2" ] && [ "$4" = "--refs" ]; then
  cat <<'JSON'
[]
JSON
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      'tasks show "Write docs"',
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    expect(stdout).toContain("Beads task bd-2");
    expect(stdout).toContain("Primary details");
  });

  it("tasks show fails with actionable error for ambiguous exact titles", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const boardJson = JSON.stringify([
      { id: "bd-1", title: "Duplicate task", status: "open" },
      {
        id: "bd-2",
        title: "Duplicate task",
        status: "open",
        labels: ["ready-for-agent"],
      },
    ]);
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\n' '${boardJson}'
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    try {
      await runCli(
        'tasks show "Duplicate task"',
        hostDir,
        withBdEnv(bdPath, hostDir),
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toContain("multiple tasks with the same exact title");
      expect(output).toContain("bd-1");
      expect(output).toContain("bd-2");
    }
  });

  it("tasks show fails with actionable error for out-of-range list numbers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const boardJson = JSON.stringify([
      { id: "bd-1", title: "Inbox task", status: "open" },
      {
        id: "bd-2",
        title: "Ready task",
        status: "open",
        labels: ["ready-for-agent"],
      },
    ]);
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\n' '${boardJson}'
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    try {
      await runCli("tasks show 3", hostDir, withBdEnv(bdPath, hostDir));
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toContain("out of range");
      expect(output).toContain("1-2");
    }
  });

  it("tasks create creates a manual inbox task with origin metadata", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const argsFile = join(hostDir, "create-args.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "create" ]; then
  printf '%s\n' "$@" > "${argsFile}"
  cat <<'JSON'
[
  {
    "id": "bd-99",
    "title": "Manual task"
  }
]
JSON
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      'tasks create "Manual task" --description "Track local work"',
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    const args = await readFile(argsFile, "utf-8");
    expect(args).toContain("create");
    expect(args).toContain("Manual task");
    expect(args).toContain("--description");
    expect(args).toContain("Track local work");
    expect(args).toContain("--type");
    expect(args).toContain("task");
    expect(args).toContain("-l");
    expect(args).toContain("needs-triage");
    expect(args).toContain("--metadata");
    expect(args).toContain('"origin":"manual"');
    expect(args).toContain("--json");
    expect(stdout).toContain("Created Beads task");
    expect(stdout).toContain("bd-99");
    expect(stdout).toContain("Manual task");
    expect(stdout).toContain("manual");
  });

  it("tasks create records user feedback origin metadata when requested", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const argsFile = join(hostDir, "create-feedback-args.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "create" ]; then
  printf '%s\n' "$@" > "${argsFile}"
  cat <<'JSON'
[
  {
    "id": "bd-100",
    "title": "Feedback task"
  }
]
JSON
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    await runCli(
      'tasks create "Feedback task" --origin user-feedback --kind enhancement',
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    const args = await readFile(argsFile, "utf-8");
    expect(args).toContain("Feedback task");
    expect(args).toContain('"origin":"user-feedback"');
    expect(args).toContain('"kind":"enhancement"');
  });

  it("tasks create accepts --category as an alias for kind metadata", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const argsFile = join(hostDir, "category-args.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "create" ]; then
  printf '%s\n' "$@" > "${argsFile}"
  cat <<'JSON'
[
  {
    "id": "bd-101",
    "title": "Categorized task"
  }
]
JSON
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    await runCli(
      'tasks create "Categorized task" --category enhancement',
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    const args = await readFile(argsFile, "utf-8");
    expect(args).toContain('"kind":"enhancement"');
  });

  it("tasks triage runs the proposal flow and applies high-confidence decisions under --yes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const dataHome = await mkdtemp(join(tmpdir(), "cli-xdg-data-"));
    await mkdir(join(dataHome, "sandcastle", "hub"), { recursive: true });
    await writeFile(
      join(dataHome, "sandcastle", "hub", "agent-roles.json"),
      `${JSON.stringify(
        {
          roles: {
            triage: { provider: "codex", model: "gpt-5.4-mini" },
          },
        },
        null,
        2,
      )}\n`,
    );

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const proposal = {
      summary: "One ready task.",
      decisions: [
        {
          taskId: "bd-1",
          outcome: "ready_for_agent",
          category: "enhancement",
          confidence: "high",
          rationale: "Fully specified AFK-safe work.",
          comment: "Add retry with backoff around sync-out.",
        },
        {
          taskId: "bd-2",
          outcome: "needs_info",
          category: "question",
          confidence: "medium",
          rationale: "Still missing reproduction details.",
          comment: "Which auth provider failed?",
        },
      ],
    };

    const fakeCodexPath = join(binDir, "codex");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const proposal = ${JSON.stringify(proposal)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const isFinal = stdin.includes("triage-proposal");
  const text = isFinal
    ? \`Approved.\\n<triage-proposal>\${JSON.stringify(proposal)}</triage-proposal>\`
    : "Draft triage recommendations";
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text },
    }) + "\\n",
  );
});
`,
    );
    await chmod(fakeCodexPath, 0o755);

    const boardTasks = [
      {
        id: "bd-1",
        title: "Add retry to sync",
        status: "open",
        labels: ["needs-triage"],
        metadata: { hubStatus: "inbox" },
        description:
          "When sync-out fails with ECONNRESET, retry up to three times before surfacing an error.",
      },
      {
        id: "bd-2",
        title: "Need details",
        status: "open",
        labels: ["needs-info"],
        metadata: { hubStatus: "needs_info" },
        description: "Need more details.",
      },
    ];
    const stateFile = join(hostDir, "triage-state.json");
    await writeFile(stateFile, JSON.stringify(boardTasks, null, 2));
    const updateArgsFile = join(hostDir, "triage-update-args.txt");
    const commentArgsFile = join(hostDir, "triage-comment-args.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const updateArgsFile = ${JSON.stringify(updateArgsFile)};
const commentArgsFile = ${JSON.stringify(commentArgsFile)};
const args = process.argv.slice(2);
const command = args[0];
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) =>
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

if (command === "list") {
  process.stdout.write(JSON.stringify(readState()));
  process.exit(0);
}

if (command === "show") {
  const task = readState().find((entry) => entry.id === args[1]);
  if (!task) {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (command === "update") {
  fs.appendFileSync(updateArgsFile, args.join(" ") + "\\n");
  const state = readState();
  const task = state.find((entry) => entry.id === args[1]);
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
      task.labels = [...new Set([...(task.labels ?? []), args[index + 1]])];
    }
    if (args[index] === "--remove-label") {
      task.labels = (task.labels ?? []).filter((label) => label !== args[index + 1]);
    }
  }
  writeState(state);
  process.exit(0);
}

if (command === "comments" && args[1] === "add") {
  fs.appendFileSync(commentArgsFile, args.join(" ") + "\\n");
  process.exit(0);
}

process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks triage --yes --query inbox,needs_info",
      hostDir,
      withBdEnv(bdPath, hostDir, {
        XDG_DATA_HOME: dataHome,
        OPENAI_KEY: "test-key",
      }),
    );

    const updateArgs = await readFile(updateArgsFile, "utf-8");
    const commentArgs = await readFile(commentArgsFile, "utf-8");

    expect(stdout).toContain("Applied triage decisions");
    expect(stdout).toContain("applied: bd-1");
    expect(stdout).toContain("skipped bd-2: unconfirmed");
    expect(updateArgs).toContain("bd-1");
    expect(updateArgs).toContain("ready-for-agent");
    expect(updateArgs).not.toContain("bd-2");
    expect(commentArgs).toContain("This was generated by AI during triage");
  });

  it("tasks sync previews changes and applies them with --yes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(stateFile, "[]");
    const ghArgsFile = join(hostDir, "gh-args.txt");
    await writeFile(ghArgsFile, "");

    const ghPath = join(binDir, "gh");
    await writeFile(
      ghPath,
      `#!/bin/sh
gh_args_file=${JSON.stringify(ghArgsFile)}
printf '%s\\n' "$*" >> "$gh_args_file"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[{"number":68,"title":"Sync Hub task state","body":"Implement tasks sync","state":"OPEN","labels":[{"name":"Sandcastle"},{"name":"ready-for-agent"}],"updatedAt":"2026-06-11T12:00:00Z"}]
JSON
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  exit 0
fi
exit 1
`,
    );
    await chmod(ghPath, 0o755);

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
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
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const created = {
    id: "bd-68",
    title: args[1],
    status: "open",
    labels: ["ready-for-agent"],
    metadata: { remote_refs: ["github#68"] },
    remoteRefs: [{ url: "github#68" }],
  };
  state.push(created);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify([created], null, 2));
  process.exit(0);
}

if (command === "update") {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.find((entry) => entry.id === id);
  if (!task) {
    process.exit(1);
  }
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = JSON.parse(args[metadataIndex + 1]);
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
}

process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks sync --yes",
      hostDir,
      withBdEnv(bdPath, hostDir, { BD_STATE_FILE: stateFile }),
    );

    expect(stdout).toContain("Hub task sync preview");
    expect(stdout).toContain("Synced Hub tasks with GitHub Issues");
    expect(stdout).toContain("1 created");
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as unknown[];
    expect(state).toHaveLength(1);
  });

  it("tasks sync requires --yes or --dry-run in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(stateFile, "[]");
    const ghArgsFile = join(hostDir, "gh-args.txt");
    await writeFile(ghArgsFile, "");

    const ghPath = join(binDir, "gh");
    await writeFile(
      ghPath,
      `#!/bin/sh
gh_args_file=${JSON.stringify(ghArgsFile)}
printf '%s\\n' "$*" >> "$gh_args_file"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[{"number":68,"title":"Sync Hub task state","body":"Implement tasks sync","state":"OPEN","labels":[{"name":"Sandcastle"},{"name":"ready-for-agent"}],"updatedAt":"2026-06-11T12:00:00Z"}]
JSON
  exit 0
fi
exit 1
`,
    );
    await chmod(ghPath, 0o755);

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const args = process.argv.slice(2);
if (args[0] === "list") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
if (args[0] === "create") {
  process.exit(0);
}
if (args[0] === "update") {
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    try {
      await runCli(
        "tasks sync",
        hostDir,
        withBdEnv(bdPath, hostDir, { BD_STATE_FILE: stateFile }),
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toContain("--yes");
      expect(output).toContain("--dry-run");
    }

    expect(await readFile(ghArgsFile, "utf-8")).toContain(
      "issue list --state open",
    );
  });

  it("tasks pull --dry-run previews open and closed issues when included", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(stateFile, "[]");
    const ghArgsFile = join(hostDir, "gh-args.txt");
    await writeFile(ghArgsFile, "");

    const ghPath = join(binDir, "gh");
    await writeFile(
      ghPath,
      `#!/bin/sh
gh_args_file=${JSON.stringify(ghArgsFile)}
printf '%s\\n' "$*" >> "$gh_args_file"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[{"number":68,"title":"Open issue","body":"Keep me","state":"OPEN","labels":[{"name":"Sandcastle"},{"name":"ready-for-agent"}],"updatedAt":"2026-06-11T12:00:00Z"},{"number":69,"title":"Closed history","body":"Import me too","state":"CLOSED","labels":[{"name":"Sandcastle"}],"updatedAt":"2026-06-11T13:00:00Z"}]
JSON
  exit 0
fi
exit 1
`,
    );
    await chmod(ghPath, 0o755);

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const args = process.argv.slice(2);
if (args[0] === "list") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
if (args[0] === "create" || args[0] === "update") {
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks pull --include-closed --dry-run",
      hostDir,
      withBdEnv(bdPath, hostDir, { BD_STATE_FILE: stateFile }),
    );

    expect(stdout).toContain("Hub task sync preview");
    expect(stdout).toContain("Pull:");
    expect(await readFile(ghArgsFile, "utf-8")).toContain(
      "issue list --state all",
    );
    expect(JSON.parse(await readFile(stateFile, "utf-8"))).toEqual([]);
  });

  it("tasks push closes linked done tasks without importing remote-only issues", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify(
        [
          {
            id: "bd-done",
            title: "Done task",
            status: "closed",
            labels: ["done"],
            metadata: {
              hubStatus: "done",
              remote_refs: ["github#11"],
              sync_state: "push_pending",
            },
          },
        ],
        null,
        2,
      ),
    );

    const ghArgsFile = join(hostDir, "gh-args.txt");
    await writeFile(ghArgsFile, "");
    const ghPath = join(binDir, "gh");
    await writeFile(
      ghPath,
      `#!/bin/sh
gh_args_file=${JSON.stringify(ghArgsFile)}
printf '%s\\n' "$*" >> "$gh_args_file"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[{"number":11,"title":"Done task","body":"Already done","state":"OPEN","labels":[{"name":"Sandcastle"},{"name":"ready-for-agent"}],"updatedAt":"2026-06-11T12:00:00Z"},{"number":12,"title":"Remote-only issue","state":"OPEN","labels":[{"name":"Sandcastle"},{"name":"ready-for-agent"}],"updatedAt":"2026-06-11T13:00:00Z"}]
JSON
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "close" ]; then
  exit 0
fi
exit 1
`,
    );
    await chmod(ghPath, 0o755);

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.BD_STATE_FILE;
const args = process.argv.slice(2);
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) =>
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

if (args[0] === "list") {
  process.stdout.write(JSON.stringify(readState()));
  process.exit(0);
}

if (args[0] === "show") {
  const task = readState().find((entry) => entry.id === args[1]);
  if (!task) {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([task]));
  process.exit(0);
}

if (args[0] === "update") {
  const state = readState();
  const task = state.find((entry) => entry.id === args[1]);
  if (!task) {
    process.exit(1);
  }
  const metadataIndex = args.indexOf("--metadata");
  if (metadataIndex >= 0) {
    task.metadata = JSON.parse(args[metadataIndex + 1]);
  }
  writeState(state);
  process.exit(0);
}

if (args[0] === "create") {
  process.exit(2);
}

process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks push",
      hostDir,
      withBdEnv(bdPath, hostDir, { BD_STATE_FILE: stateFile }),
    );

    expect(stdout).toContain("Pushed: 0 synced, 1 closed");
    const ghArgs = await readFile(ghArgsFile, "utf-8");
    expect(ghArgs).toContain("issue close 11");
    expect(ghArgs).not.toContain("issue close 12");
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as Array<{
      metadata: { sync_state?: string };
    }>;
    expect(state).toHaveLength(1);
    expect(state[0]?.metadata.sync_state).toBe("synced");
  });

  it("tasks from-prd creates dependency-aware Beads tasks from a local PRD", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const prdPath = join(hostDir, "docs", "prd", "feature.md");
    await mkdir(join(hostDir, "docs", "prd"), { recursive: true });
    await writeFile(
      prdPath,
      `# PRD: Feature Slice

### Tasks

- [ ] Implement feature core path
- [ ] Confirm rollout checklist with maintainer
- [ ] Add verification coverage for feature core path
`,
    );

    const dataHome = await mkdtemp(join(tmpdir(), "cli-xdg-data-"));
    await mkdir(join(dataHome, "sandcastle", "hub"), { recursive: true });
    await writeFile(
      join(dataHome, "sandcastle", "hub", "agent-roles.json"),
      `${JSON.stringify(
        {
          roles: {
            planning: { provider: "codex", model: "gpt-5.4-mini" },
          },
        },
        null,
        2,
      )}\n`,
    );

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const proposal = {
      prdRef: "docs/prd/feature.md",
      prdTitle: "Feature Slice",
      summary: "Three tracer-bullet slices.",
      slices: [
        {
          tempId: "slice-1",
          title: "Implement feature core path",
          description: "Deliver the end-to-end core feature path.",
          sliceType: "AFK",
          acceptanceCriteria: ["Core path works"],
          rationale: "Tracer bullet.",
        },
        {
          tempId: "slice-2",
          title: "Confirm rollout checklist with maintainer",
          description: "Review rollout risks.",
          sliceType: "HITL",
          acceptanceCriteria: ["Maintainer confirms rollout checklist"],
          rationale: "Human checkpoint.",
        },
        {
          tempId: "slice-3",
          title: "Add verification coverage for feature core path",
          description: "Expand verification.",
          sliceType: "AFK",
          acceptanceCriteria: ["Regression tests cover the core path"],
          rationale: "Hardens the first slice.",
        },
      ],
      dependencies: [
        { dependentTempId: "slice-2", blockerTempId: "slice-1" },
        { dependentTempId: "slice-3", blockerTempId: "slice-2" },
      ],
      warnings: [],
    };

    const fakeCodexPath = join(binDir, "codex");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const proposal = ${JSON.stringify(proposal)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const isFinal = stdin.includes("prd-decomposition-proposal");
  const text = isFinal
    ? \`Approved.\\n<prd-decomposition-proposal>\${JSON.stringify(proposal)}</prd-decomposition-proposal>\`
    : "Draft proposal";
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text },
    }) + "\\n",
  );
});
`,
    );
    await chmod(fakeCodexPath, 0o755);

    const createArgsFile = join(hostDir, "create-args.txt");
    const depArgsFile = join(hostDir, "dep-args.txt");
    const createCountFile = join(hostDir, "create-count.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "create" ]; then
  n=0
  if [ -f "${createCountFile}" ]; then
    n=$(cat "${createCountFile}")
  fi
  n=$((n + 1))
  printf '%s' "$n" > "${createCountFile}"
  printf '%s\\n' "$@" >> "${createArgsFile}"
  printf '[{"id":"bd-%s","title":"%s"}]\\n' "$n" "$2"
  exit 0
fi
if [ "$1" = "dep" ] && [ "$2" = "add" ]; then
  printf '%s\\n' "$@" >> "${depArgsFile}"
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      'tasks from-prd docs/prd/feature.md --yes --deps "2:1,3:2"',
      hostDir,
      withBdEnv(bdPath, hostDir, {
        XDG_DATA_HOME: dataHome,
        OPENAI_KEY: "test-key",
      }),
    );

    const createArgs = await readFile(createArgsFile, "utf-8");
    const depArgs = await readFile(depArgsFile, "utf-8");

    expect(createArgs).toContain('"origin":"prd-decomposition"');
    expect(createArgs).toContain('"slice_type":"AFK"');
    expect(createArgs).toContain('"slice_type":"HITL"');
    expect(createArgs).toContain('"prd_ref":"docs/prd/feature.md"');
    expect(createArgs).toContain("needs-triage");
    expect(depArgs).toContain("dep");
    expect(depArgs).toContain("add");
    expect(depArgs).toContain("bd-2");
    expect(depArgs).toContain("bd-1");
    expect(depArgs).toContain("bd-3");
    expect(depArgs).toContain("bd-2");
    expect(stdout).toContain("Created PRD-derived Beads tasks");
    expect(stdout).toContain("bd-2 depends on bd-1");
    expect(stdout).toContain("bd-3 depends on bd-2");
  });

  it("tasks comment appends a comment without changing task status", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const argsFile = join(hostDir, "comment-args.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  cat <<'JSON'
[
  {
    "id": "bd-99",
    "title": "Commented task",
    "status": "open"
  }
]
JSON
  exit 0
fi
if [ "$1" = "comments" ] && [ "$2" = "add" ]; then
  printf '%s\n' "$@" > "${argsFile}"
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      'tasks comment bd-99 --body "Still needs a clear acceptance test"',
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    const args = await readFile(argsFile, "utf-8");
    expect(args).toContain("comments");
    expect(args).toContain("add");
    expect(args).toContain("bd-99");
    expect(args).toContain("Still needs a clear acceptance test");
    expect(args).not.toContain("update");
    expect(args).not.toContain("--status");
    expect(stdout).toContain("Appended a comment to Beads task bd-99.");
  });

  it("tasks comment resolves exact titles and list indices", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const commentArgsFile = join(hostDir, "comment-args.txt");
    const boardJson = JSON.stringify([
      { id: "bd-1", title: "Inbox task", status: "open" },
      {
        id: "bd-2",
        title: "Write docs",
        status: "open",
        labels: ["ready-for-agent"],
      },
      { id: "bd-3", title: "Done task", status: "closed", labels: ["done"] },
    ]);
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  printf '%s\n' '${boardJson}'
  exit 0
fi
if [ "$1" = "comments" ] && [ "$2" = "add" ]; then
  printf '%s\n' "$*" >> "${commentArgsFile}"
  exit 0
fi
exit 1
`,
    );
    await chmod(bdPath, 0o755);

    const titleResult = await runCli(
      'tasks comment "Write docs" --body "Comment from title"',
      hostDir,
      withBdEnv(bdPath, hostDir),
    );
    expect(titleResult.stdout).toContain(
      "Appended a comment to Beads task bd-2.",
    );

    const indexResult = await runCli(
      'tasks comment 2 --body "Comment from index"',
      hostDir,
      withBdEnv(bdPath, hostDir),
    );
    expect(indexResult.stdout).toContain(
      "Appended a comment to Beads task bd-2.",
    );

    const commentArgs = await readFile(commentArgsFile, "utf-8");
    expect(commentArgs).toContain("comments add bd-2 Comment from title");
    expect(commentArgs).toContain("comments add bd-2 Comment from index");
  });

  it("tasks delete removes local Beads tasks with --yes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const stateFile = join(hostDir, "bd-state.json");
    const deleteArgsFile = join(hostDir, "bd-delete-args.txt");
    const initialTasks = [
      { id: "bd-1", title: "Delete me", status: "open" },
      { id: "bd-2", title: "Keep me", status: "open" },
    ];
    await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));
    await writeFile(deleteArgsFile, "");

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const deleteArgsFile = ${JSON.stringify(deleteArgsFile)};
const args = process.argv.slice(2);
const command = args[0];
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) =>
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

if (command === "list") {
  process.stdout.write(JSON.stringify(readState()));
  process.exit(0);
}

if (command === "delete") {
  fs.appendFileSync(deleteArgsFile, args.join(" ") + "\\n");
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const taskIds = args.slice(1).filter((arg) => !arg.startsWith("--"));
  if (dryRun) {
    process.stdout.write("Dry run: would delete " + taskIds.join(", "));
    process.exit(0);
  }
  if (!force) {
    process.stdout.write("Preview: would delete " + taskIds.join(", "));
    process.exit(0);
  }
  const state = readState();
  writeState(state.filter((task) => !taskIds.includes(task.id)));
  process.stdout.write("Deleted " + taskIds.join(", "));
  process.exit(0);
}

process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks delete bd-1 bd-2 --yes",
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    const deleteArgs = await readFile(deleteArgsFile, "utf-8");
    expect(deleteArgs).toContain("delete bd-1 bd-2 --force");
    expect(stdout).toContain("Deleted local Beads tasks bd-1, bd-2");
    expect(JSON.parse(await readFile(stateFile, "utf-8"))).toEqual([]);
  });

  it("tasks delete requires --yes in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify([{ id: "bd-1", title: "Delete me", status: "open" }]),
    );

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
if (args[0] === "list") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    try {
      await runCli("tasks delete bd-1", hostDir, withBdEnv(bdPath, hostDir));
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toContain("--yes");
      expect(cliFailureOutput(err)).toContain("--dry-run");
    }
  });

  it("tasks delete --dry-run previews without deleting", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const stateFile = join(hostDir, "bd-state.json");
    const deleteArgsFile = join(hostDir, "bd-delete-args.txt");
    const initialTasks = [{ id: "bd-1", title: "Delete me", status: "open" }];
    await writeFile(stateFile, JSON.stringify(initialTasks, null, 2));
    await writeFile(deleteArgsFile, "");

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const deleteArgsFile = ${JSON.stringify(deleteArgsFile)};
const args = process.argv.slice(2);
const command = args[0];
if (command === "list") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
if (command === "delete") {
  fs.appendFileSync(deleteArgsFile, args.join(" ") + "\\n");
  process.stdout.write("Dry run: would delete bd-1");
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "tasks delete bd-1 --dry-run",
      hostDir,
      withBdEnv(bdPath, hostDir),
    );

    const deleteArgs = await readFile(deleteArgsFile, "utf-8");
    expect(deleteArgs).toContain("delete bd-1 --dry-run");
    expect(deleteArgs).not.toContain("--force");
    expect(stdout).toContain("Dry run for local Beads task delete (bd-1)");
    expect(JSON.parse(await readFile(stateFile, "utf-8"))).toEqual(
      initialTasks,
    );
  });

  it("tasks delete surfaces Beads dependency failures", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const stateFile = join(hostDir, "bd-state.json");
    await writeFile(
      stateFile,
      JSON.stringify([
        { id: "bd-1", title: "Blocker", status: "open" },
        { id: "bd-2", title: "Dependent", status: "open" },
      ]),
    );

    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
if (args[0] === "list") {
  process.stdout.write(fs.readFileSync(stateFile, "utf8"));
  process.exit(0);
}
if (args[0] === "delete" && args.includes("--force")) {
  process.stderr.write(
    "Error: bd-1 has dependents not in deletion set: bd-2",
  );
  process.exit(1);
}
process.exit(1);
`,
    );
    await chmod(bdPath, 0o755);

    try {
      await runCli(
        "tasks delete bd-1 --yes",
        hostDir,
        withBdEnv(bdPath, hostDir),
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toContain("dependents not in deletion set");
    }
  });

  it("--help shows podman namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("podman");
    expect(stdout).toContain("podman build-image");
    expect(stdout).toContain("podman remove-image");
  });

  it("podman --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("podman --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("podman build-image --help shows --containerfile and --image-name flags", async () => {
    const { stdout } = await runCli("podman build-image --help", process.cwd());
    expect(stdout).toContain("--containerfile");
    expect(stdout).toContain("--image-name");
  });

  it("podman build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("podman build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toContain("No .sandcastle/ found");
    }
  });

  it("init --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toContain("nonexistent");
      expect(output).toContain("claude-code");
    }
  });

  it("init --sandbox podman is rejected", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --sandbox podman --agent claude-code", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toContain('Unknown sandbox provider "podman"');
      expect(output).toContain("no-sandbox");
    }
  });

  it("init --sandbox no-sandbox --backlog beads succeeds when bundled bd is available", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    const { stdout } = await runCli(
      "init --sandbox no-sandbox --backlog beads --template blank --project-profile generic --preset-agents none --build-image false --agent claude-code",
      hostDir,
      { ...process.env, PATH: dirname(process.execPath) },
    );

    const mainTs = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );

    expect(mainTs).toContain("noSandbox()");
    expect(stdout).toContain("bundled @beads/bd install");
    expect(stdout).toContain("no-sandbox + beads");
  });

  it("init --sandbox no-sandbox --backlog beads succeeds when bd exists on the host and explains the host requirement", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    const binDir = join(hostDir, "test-bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      '#!/bin/sh\nif [ "$1" = "ready" ]; then\n  echo \'[]\'\n  exit 0\nfi\nexit 0\n',
    );
    await chmod(bdPath, 0o755);

    const { stdout } = await runCli(
      "init --sandbox no-sandbox --backlog beads --template blank --project-profile generic --preset-agents none --build-image false --agent claude-code",
      hostDir,
      { ...process.env, PATH: `${binDir}:${dirname(process.execPath)}` },
    );

    const mainTs = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );

    expect(mainTs).toContain("noSandbox()");
    expect(stdout).toContain("bundled @beads/bd install");
    expect(stdout).toContain("SANDCASTLE_BD_PATH");
    expect(stdout).toContain("no-sandbox + beads");
  });

  it("init --sandbox no-sandbox --project-profile python explains host Python prerequisites", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    const { stdout } = await runCli(
      "init --sandbox no-sandbox --backlog github-issues --template blank --project-profile python --preset-agents none --build-image false --create-sandcastle-label false --agent claude-code",
      hostDir,
    );

    const bootstrap = await readFile(
      join(hostDir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );

    expect(bootstrap).toContain("removing incomplete .venv");
    expect(stdout).toContain("python3-venv");
    expect(stdout).toContain("no-sandbox");
  });

  it("init with --agent and omitted runtimes installs the selected agent runtime", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    await runNonInteractiveInit(hostDir, "--agent cursor");

    const dockerfile = await readFile(
      join(hostDir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    const mainTs = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).not.toContain("claude.ai/install.sh");
    expect(dockerfile).not.toContain("@openai/codex");
    expect(mainTs).toContain('cursor("auto")');
  });

  it("init --installed-runtimes scaffolds a Dockerfile with selected runtimes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    await runNonInteractiveInit(
      hostDir,
      "--agent claude-code --installed-runtimes codex,cursor,codex",
    );

    const dockerfile = await readFile(
      join(hostDir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("npm install -g @openai/codex");
    expect(dockerfile).toContain("codex --version");
    expect(dockerfile).not.toContain("@openai/codex-linux-x64");
    expect(dockerfile).not.toContain("CODEX_PLATFORM");
    expect(dockerfile.match(/npm install -g @openai\/codex/g)).toHaveLength(1);
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).not.toContain("claude.ai/install.sh");
    expect(dockerfile).not.toContain("opencode-ai");
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(1);
  });

  it("init --runtimes scaffolds a Dockerfile with selected runtimes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    await runNonInteractiveInit(
      hostDir,
      "--agent claude-code --runtimes codex,cursor",
    );

    const dockerfile = await readFile(
      join(hostDir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    const envExample = await readFile(
      join(hostDir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).not.toContain("claude.ai/install.sh");
    expect(envExample).toContain("OPENAI_KEY=");
    expect(envExample).toContain("CURSOR_API_KEY=");
    expect(envExample).not.toContain("ANTHROPIC_API_KEY=");
  });

  it("init --project-profile cpp scaffolds C++ Dockerfile tools and bootstrap.sh", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    await runNonInteractiveInit(
      hostDir,
      "--agent claude-code --project-profile cpp",
    );

    const dockerfile = await readFile(
      join(hostDir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    const bootstrap = await readFile(
      join(hostDir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(dockerfile).toContain("cmake");
    expect(dockerfile).toContain("build-essential");
    expect(bootstrap).toContain("cmake -S");
    expect(bootstrap).not.toContain("cmake --build");
  });

  it("init --project-profile generic scaffolds bootstrap.sh", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    await runNonInteractiveInit(
      hostDir,
      "--agent claude-code --project-profile generic",
    );

    const bootstrap = await readFile(
      join(hostDir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(bootstrap).toContain("#!/usr/bin/env bash");
    expect(bootstrap).toContain("exit 0");
  });

  it("init --project-profile node scaffolds lockfile-aware bootstrap.sh", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    await runNonInteractiveInit(
      hostDir,
      "--agent claude-code --project-profile node",
    );

    const bootstrap = await readFile(
      join(hostDir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(bootstrap).toContain("pnpm-lock.yaml");
    expect(bootstrap).toContain("npm ci");
    expect(bootstrap).toContain("No package.json found");
  });

  it("init --project-profile python scaffolds Python bootstrap and image tools", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await seedSandcastlePackage(hostDir);

    await runNonInteractiveInit(
      hostDir,
      "--agent claude-code --project-profile python",
    );

    const bootstrap = await readFile(
      join(hostDir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(bootstrap).toContain("uv sync");
    expect(bootstrap).toContain("Poetry");

    const dockerfile = await readFile(
      join(hostDir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("python3-venv");
    expect(dockerfile).toContain("astral.sh/uv/install.sh");
  });

  it("init --project-profile rejects unknown profiles before scaffolding", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runNonInteractiveInit(
        hostDir,
        "--agent claude-code --project-profile rust",
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toContain('Unknown project profile "rust"');
      await expect(access(join(hostDir, ".sandcastle"))).rejects.toThrow();
    }
  });

  it("init --runtimes rejects unknown runtimes before scaffolding", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runNonInteractiveInit(
        hostDir,
        "--agent claude-code --runtimes not-a-runtime",
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(cliFailureOutput(err)).toContain(
        'Unknown agent runtime "not-a-runtime"',
      );
      await expect(access(join(hostDir, ".sandcastle"))).rejects.toThrow();
    }
  });
});
