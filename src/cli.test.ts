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
import { describe, expect, it, vi } from "vitest";

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
  execAsync(`"${process.execPath}" ${cliPath} ${args}`, { cwd, env });

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

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).not.toMatch(/-\s+run(?:\s|\[|$)/);
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

  it("root help exposes the tasks namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("tasks");
    expect(stdout).toContain("tasks list");
    expect(stdout).toContain("tasks show");
    expect(stdout).toContain("tasks create");
    expect(stdout).toContain("tasks from-prd");
    expect(stdout).toContain("tasks comment");
  });

  it("project --help shows the status subcommand", async () => {
    const { stdout } = await runCli("project --help", process.cwd());
    expect(stdout).toContain("status");
  });

  it("tasks --help shows the list and show subcommands", async () => {
    const { stdout } = await runCli("tasks --help", process.cwd());
    expect(stdout).toContain("list");
    expect(stdout).toContain("show");
    expect(stdout).toContain("create");
    expect(stdout).toContain("from-prd");
    expect(stdout).toContain("comment");
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
    expect(stdout).toContain(join(dataDir, "sandcastle"));
    expect(stdout).toContain("Beads available");
    expect(stdout).toContain("Task board ready");
    expect(stdout).toContain("Task board total");
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

    const { stdout } = await runCli("tasks list", hostDir, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(stdout).toContain("Hub task board");
    expect(stdout).toContain("Total tasks: 3");
    expect(stdout).toContain("inbox (1)");
    expect(stdout).toContain("ready_for_agent (1)");
    expect(stdout).toContain("done (1)");
    expect(stdout).toContain("  bd-2: Ready task");
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

    const { stdout } = await runCli("tasks show bd-3", hostDir, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

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
      {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
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
      {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
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
      {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    const args = await readFile(argsFile, "utf-8");
    expect(args).toContain('"kind":"enhancement"');
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

    const binDir = join(hostDir, "bin");
    await mkdir(binDir, { recursive: true });
    const gitPath = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitPath, join(binDir, "git"));

    const createArgsFile = join(hostDir, "create-args.txt");
    const depArgsFile = join(hostDir, "dep-args.txt");
    const createCountFile = join(hostDir, "create-count.txt");
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      `#!/bin/sh
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
      {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
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
      {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
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

  it("init --sandbox no-sandbox --backlog beads requires bd on the host", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --sandbox no-sandbox --backlog beads --template blank --project-profile generic --preset-agents none --build-image false --agent claude-code",
        hostDir,
        { ...process.env, PATH: dirname(process.execPath) },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const output = cliFailureOutput(err);
      expect(output).toContain("requires `bd` on the host");
      expect(output).toContain("Install Beads locally or choose docker");
    }
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
    expect(stdout).toContain("`bd` available on your host PATH");
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
