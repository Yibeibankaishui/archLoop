import { exec } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (
  args: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => execAsync(`"${process.execPath}" ${cliPath} ${args}`, { cwd, env });

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

    const binDir = join(hostDir, "test-bin");
    await mkdir(binDir, { recursive: true });
    const bdPath = join(binDir, "bd");
    await writeFile(
      bdPath,
      "#!/bin/sh\nif [ \"$1\" = \"ready\" ]; then\n  echo '[]'\n  exit 0\nfi\nexit 0\n",
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
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile.match(/@openai\/codex/g)).toHaveLength(1);
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
