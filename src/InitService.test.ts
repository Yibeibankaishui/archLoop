import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { tmpdir } from "node:os";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCapabilityManifest,
  RUNTIME_DEBUG_ADDON_ID,
  resolveCapabilityInitOptions,
  validateCapabilityRegistries,
  type CapabilitySetupAction,
} from "./capabilityPacks.js";
import {
  MINIPROGRAM_VERIFICATION_PROMPT_MARKER,
  MINIPROGRAM_RUNTIME_DEBUG_PROMPT_MARKER,
  listTemplatePromptFiles,
} from "./capabilityPromptAssembly.js";
import { setMiniprogramCiInstallRunnerForTests } from "./miniprogramScaffold.js";
import { validatePresetRegistries } from "./presetAgents.js";
import {
  scaffold,
  ensureProjectPackage,
  getNextStepsLines,
  listAgents,
  getAgent,
  listTemplates,
  listBacklogManagers,
  getBacklogManager,
  listSandboxProviders,
  listInitSandboxProviders,
  getSandboxProvider,
  getInitSandboxProvider,
  listAgentRuntimes,
  getAgentRuntime,
  collectAuthRequirements,
  DEFAULT_PROJECT_PROFILE,
  BOOTSTRAP_HOOK_TIMEOUT_MS,
} from "./InitService.js";
import { renderBootstrapScript } from "./bootstrap.js";
import { getProjectProfile, NODE_PROJECT_PROFILE } from "./projectProfiles.js";
import type { ScaffoldOptions } from "./InitService.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { SKELETON_PROMPT } from "./templates.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const claudeCodeAgent = getAgent("claude-code")!;
const piAgent = getAgent("pi")!;
const codexAgent = getAgent("codex")!;
const cursorAgent = getAgent("cursor")!;
const opencodeAgent = getAgent("opencode")!;
const codexRuntime = getAgentRuntime("codex")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-6",
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, {
      ...defaultOptions,
      skipDependencyInstall: true,
      ...options,
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

const runEnsureProjectPackage = (
  repoDir: string,
  mainFilename: string,
  sandcastleVersion = "0.5.9",
) =>
  Effect.runPromise(
    ensureProjectPackage(repoDir, { mainFilename, sandcastleVersion }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

const countOccurrences = (content: string, pattern: RegExp): number =>
  content.match(pattern)?.length ?? 0;

/** Non-blank templates run init-scaffolded bootstrap only (no runtime generation). */
const expectMainUsesInitBootstrapOnly = (mainTs: string) => {
  expect(mainTs).toContain("bash .sandcastle/bootstrap.sh");
  expect(mainTs).toMatch(
    /onSandboxReady:\s*\[\s*\{\s*command:\s*"bash \.sandcastle\/bootstrap\.sh",\s*timeoutMs:\s*300_000/,
  );
  expect(mainTs).toContain("onSandboxReady");
  expect(mainTs).not.toContain("bootstrap-prompt.md");
  expect(mainTs).not.toContain("ensureBootstrapReady");
  expect(mainTs).not.toContain("bootstrap-generator");
  expect(mainTs).not.toContain("npm install");
  expect(mainTs).not.toContain("node_modules");
};

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

describe("Agent registry", () => {
  it("listAgents returns at least claude-code", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "claude-code")).toBe(true);
  });

  it("getAgent returns claude-code entry with expected fields", () => {
    const agent = getAgent("claude-code");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("claude-code");
    expect(agent!.defaultModel).toBe("claude-opus-4-6");
    expect(agent!.factoryImport).toBe("claudeCode");
    expect(agent).not.toHaveProperty("dockerfileTemplate");
    expect(agent).not.toHaveProperty("envExample");
  });

  it("getAgent returns undefined for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
  });

  it("listAgents includes pi", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "pi")).toBe(true);
  });

  it("getAgent returns pi entry with expected fields", () => {
    const agent = getAgent("pi");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("pi");
    expect(agent!.defaultModel).toBe("claude-sonnet-4-6");
    expect(agent!.factoryImport).toBe("pi");
    expect(agent).not.toHaveProperty("dockerfileTemplate");
    expect(agent).not.toHaveProperty("envExample");
  });

  it("listAgents includes codex", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "codex")).toBe(true);
  });

  it("getAgent returns codex entry with expected fields", () => {
    const agent = getAgent("codex");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("codex");
    expect(agent!.defaultModel).toBe("gpt-5.4-mini");
    expect(agent!.factoryImport).toBe("codex");
    expect(agent).not.toHaveProperty("dockerfileTemplate");
    expect(agent).not.toHaveProperty("envExample");
  });

  it("listAgents includes cursor", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "cursor")).toBe(true);
  });

  it("getAgent returns cursor entry with expected fields", () => {
    const agent = getAgent("cursor");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("cursor");
    expect(agent!.defaultModel).toBe("auto");
    expect(agent!.factoryImport).toBe("cursor");
    expect(agent).not.toHaveProperty("dockerfileTemplate");
    expect(agent).not.toHaveProperty("envExample");
  });

  it("listAgents includes opencode", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "opencode")).toBe(true);
  });

  it("getAgent returns opencode entry with expected fields", () => {
    const agent = getAgent("opencode");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("opencode");
    expect(agent!.defaultModel).toBe("opencode/big-pickle");
    expect(agent!.factoryImport).toBe("opencode");
    expect(agent).not.toHaveProperty("dockerfileTemplate");
    expect(agent).not.toHaveProperty("envExample");
  });
});

describe("Agent runtime registry", () => {
  it("listAgentRuntimes returns at least claude-code", () => {
    const runtimes = listAgentRuntimes();
    expect(runtimes.some((runtime) => runtime.name === "claude-code")).toBe(
      true,
    );
  });

  it("getAgentRuntime returns install metadata for codex", () => {
    expect(codexRuntime.name).toBe("codex");
    expect(codexRuntime.envExample).toContain("OPENAI_KEY=");
    expect(codexRuntime.dockerfileTemplate).toContain("FROM");
    for (const dockerfile of [
      codexRuntime.dockerfileInstall.root!,
      codexRuntime.dockerfileTemplate,
    ]) {
      expect(dockerfile).toContain("@openai/codex");
      expect(dockerfile).toContain("@openai/codex-linux-x64");
      expect(dockerfile).toContain("codex --version");
    }
  });

  it("getAgentRuntime returns undefined for unknown runtime", () => {
    expect(getAgentRuntime("nonexistent")).toBeUndefined();
  });
});

describe("Auth requirement collection", () => {
  it("collects auth requirements from selected runtimes and backlog manager", () => {
    const requirements = collectAuthRequirements({
      installedRuntimes: [
        getAgentRuntime("codex")!,
        getAgentRuntime("cursor")!,
      ],
      backlogManager: getBacklogManager("github-issues")!,
    });

    expect(requirements.map((requirement) => requirement.id)).toEqual([
      "codex",
      "cursor",
      "github-issues",
    ]);
    expect(
      requirements.find((requirement) => requirement.id === "codex"),
    ).toMatchObject({
      envVars: ["OPENAI_KEY"],
      authMounts: [
        {
          hostPath: ".sandcastle/auth/codex",
          sandboxPath: "/home/agent/.codex",
        },
      ],
    });
    expect(
      requirements.find((requirement) => requirement.id === "github-issues"),
    ).toMatchObject({
      envVars: ["GH_TOKEN"],
      authMounts: [
        {
          hostPath: ".sandcastle/auth/gh",
          sandboxPath: "/home/agent/.config/gh",
        },
      ],
      githubLoginSupported: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

describe("InitService scaffold", () => {
  it("BOOTSTRAP_HOOK_TIMEOUT_MS matches the numeric literal in scaffolded main.mts", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });
    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    const match = mainTs.match(/timeoutMs:\s*(\d[\d_]*)/);
    expect(match).not.toBeNull();
    expect(Number(match![1]!.replaceAll("_", ""))).toBe(
      BOOTSTRAP_HOOK_TIMEOUT_MS,
    );
  });

  it("scaffolds a no-op bootstrap.sh for the generic project profile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      projectProfile: DEFAULT_PROJECT_PROFILE,
    });

    const bootstrap = await readFile(
      join(dir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(bootstrap).toContain("#!/usr/bin/env bash");
    expect(bootstrap).toContain("exit 0");
    expect(bootstrap).not.toContain("npm install");
  });

  it.each(["generic", "node", "python", "cpp"] as const)(
    "scaffolds bootstrap.sh from renderBootstrapScript for %s profile",
    async (profileName) => {
      const dir = await makeDir();
      await runScaffold(dir, {
        projectProfile: getProjectProfile(profileName)!,
      });

      const bootstrap = await readFile(
        join(dir, ".sandcastle", "bootstrap.sh"),
        "utf-8",
      );
      expect(bootstrap).toBe(renderBootstrapScript(profileName));
    },
  );

  it.each([
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ] as const)(
    "non-blank template %s main.mts runs init bootstrap only",
    async (templateName) => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expectMainUsesInitBootstrapOnly(mainTs);
    },
  );

  it("generic project profile does not add language-specific Dockerfile tools", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      projectProfile: DEFAULT_PROJECT_PROFILE,
    });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("{{PROJECT_PROFILE_TOOLS}}");
    expect(dockerfile).not.toContain("corepack enable");
    expect(dockerfile).not.toMatch(/\buv\b/);
    expect(dockerfile).not.toContain("cmake");
  });

  it("cpp project profile adds C++ toolchain to Dockerfile and bootstrap.sh", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      projectProfile: getProjectProfile("cpp")!,
    });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("build-essential");
    expect(dockerfile).toContain("cmake");
    expect(dockerfile).toContain("ninja-build");
    expect(dockerfile).not.toContain("{{PROJECT_PROFILE_TOOLS}}");

    const bootstrap = await readFile(
      join(dir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(bootstrap).toContain("cmake -S");
    expect(bootstrap).not.toContain("cmake --build");
    expect(bootstrap).toContain("No supported C++ build signal found");
  });

  it("cpp project profile does not alter .env.example or copy-to-worktree defaults", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { projectProfile: getProjectProfile("cpp")! });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
    expect(envExample).not.toContain("CCACHE");
    expect(envExample).not.toContain("CMAKE_");

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).not.toMatch(/copyToWorktree:[\s\S]*build\//);
  });

  it("generic project profile does not alter .env.example beyond runtime and backlog vars", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      projectProfile: DEFAULT_PROJECT_PROFILE,
    });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
    expect(envExample).toContain("GH_TOKEN=");
    expect(envExample).not.toContain("NPM_TOKEN");
    expect(envExample).not.toContain("UV_");
  });

  it("scaffolds node bootstrap.sh with lockfile-based dependency install", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      projectProfile: NODE_PROJECT_PROFILE,
    });

    const bootstrap = await readFile(
      join(dir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(bootstrap).toContain("pnpm-lock.yaml");
    expect(bootstrap).toContain("pnpm install");
    expect(bootstrap).toContain("yarn.lock");
    expect(bootstrap).toContain("npm ci");
    expect(bootstrap).toContain("No package.json found");
    expect(bootstrap).not.toContain("npm test");
    expect(bootstrap).not.toContain("npm run build");
  });

  it("node project profile reuses Node 22 base without extra containerfile tools", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      projectProfile: NODE_PROJECT_PROFILE,
    });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).not.toContain("{{PROJECT_PROFILE_TOOLS}}");
    expect(dockerfile).not.toContain("corepack enable");
    expect(dockerfile).not.toMatch(/\buv\b/);
    expect(dockerfile).not.toContain("cmake");
  });

  it("python project profile adds Python tools to Dockerfile", async () => {
    const dir = await makeDir();
    const pythonProfile = getProjectProfile("python")!;
    await runScaffold(dir, { projectProfile: pythonProfile });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("{{PROJECT_PROFILE_TOOLS}}");
    expect(dockerfile).toContain("python3");
    expect(dockerfile).toContain("python3-pip");
    expect(dockerfile).toContain("python3-venv");
    expect(dockerfile).toContain("astral.sh/uv/install.sh");
    expect(dockerfile.toLowerCase()).not.toContain("poetry");
  });

  it("python project profile adds Python tools to Containerfile", async () => {
    const dir = await makeDir();
    const pythonProfile = getProjectProfile("python")!;
    await runScaffold(dir, {
      projectProfile: pythonProfile,
      sandboxProvider: getSandboxProvider("podman")!,
    });

    const containerfile = await readFile(
      join(dir, ".sandcastle", "Containerfile"),
      "utf-8",
    );
    expect(containerfile).not.toContain("{{PROJECT_PROFILE_TOOLS}}");
    expect(containerfile).toContain("python3-venv");
    expect(containerfile).toContain("astral.sh/uv/install.sh");
  });

  it("python project profile scaffolds a Python bootstrap.sh", async () => {
    const dir = await makeDir();
    const pythonProfile = getProjectProfile("python")!;
    await runScaffold(dir, { projectProfile: pythonProfile });

    const bootstrap = await readFile(
      join(dir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(bootstrap).toContain("uv sync");
    expect(bootstrap).toContain("requirements.txt");
    expect(bootstrap).toContain("Poetry");
    expect(bootstrap).not.toContain("pytest");
  });

  it("python project profile does not alter .env.example beyond runtime and backlog vars", async () => {
    const dir = await makeDir();
    const pythonProfile = getProjectProfile("python")!;
    await runScaffold(dir, { projectProfile: pythonProfile });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
    expect(envExample).not.toContain("UV_INDEX_URL");
    expect(envExample).not.toContain("POETRY_");
  });

  it("uses default runtime Dockerfile metadata for Dockerfile (with templateArgs substitution)", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    // Template has {{BACKLOG_MANAGER_TOOLS}} replaced — should contain GitHub CLI (default backlog manager)
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("GitHub CLI");
    expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    expect(dockerfile).not.toContain("{{PROJECT_PROFILE_TOOLS}}");
  });

  // --- Dynamic .env.example generation ---

  it.each([
    {
      agent: claudeCodeAgent,
      expectedKey: "ANTHROPIC_API_KEY=",
      unexpectedKey: "OPENAI_KEY=",
      expectIssue191Link: true,
    },
    {
      agent: piAgent,
      expectedKey: "ANTHROPIC_API_KEY=",
      unexpectedKey: "OPENAI_KEY=",
      expectIssue191Link: false,
    },
    {
      agent: codexAgent,
      expectedKey: "OPENAI_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectIssue191Link: false,
    },
    {
      agent: opencodeAgent,
      expectedKey: "OPENCODE_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectIssue191Link: false,
    },
  ])(
    "generates .env.example with $agent.name env var",
    async ({ agent, expectedKey, unexpectedKey, expectIssue191Link }) => {
      const dir = await makeDir();
      await runScaffold(dir, { agent, model: agent.defaultModel });

      const envExample = await readFile(
        join(dir, ".sandcastle", ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain(expectedKey);
      expect(envExample).not.toContain(unexpectedKey);
      if (expectIssue191Link) {
        expect(envExample).toContain("issues/191");
      } else {
        expect(envExample).not.toContain("issues/191");
      }
    },
  );

  it("generates .env.example with GH_TOKEN when backlog manager is github-issues", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      backlogManager: getBacklogManager("github-issues"),
    });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("GH_TOKEN=");
  });

  it("generates .env.example without GH_TOKEN when backlog manager is beads", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      backlogManager: getBacklogManager("beads"),
    });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).not.toContain("GH_TOKEN=");
  });

  it("does not scaffold config.json for blank template", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".sandcastle", "config.json")),
    ).rejects.toThrow();
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".sandcastle"));

    await expect(runScaffold(dir)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes .env, logs/, and worktrees/ in .gitignore but not patches/", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const gitignore = await readFile(
      join(dir, ".sandcastle", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("logs/");
    expect(gitignore).toContain("worktrees/");
    expect(gitignore).not.toContain("patches/");
  });

  it("Dockerfile template contains worktree mount comment", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(SANDBOX_REPO_DIR);
  });

  it("claude-code Dockerfile template does not install pnpm or enable corepack", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).not.toContain("pnpm");
  });

  it("skeleton prompt contains section headers and hints", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("# ");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("blank template produces skeleton prompt and main.mts", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const configDir = join(dir, ".sandcastle");
    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");

    const { access } = await import("node:fs/promises");
    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
  });

  it("blank template main.mts imports from @ai-hero/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('"@ai-hero/sandcastle"');
  });

  it("blank template main.mts calls run()", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("run(");
  });

  it("blank template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1);
    await runScaffold(dir2, { templateName: "blank" });

    const prompt1 = await readFile(
      join(dir1, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    const prompt2 = await readFile(
      join(dir2, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt1).toBe(prompt2);
  });

  // --- main file rewriting ---

  it("scaffolds main.mts with the specified model", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('claudeCode("claude-sonnet-4-6")');
    // Should not contain the template's original model
    expect(mainTs).not.toContain('claudeCode("claude-opus-4-6")');
  });

  it("scaffolds main.mts with default model when using agent default", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('claudeCode("claude-opus-4-6")');
  });

  it("uses the selected agent in main.mts while installing the selected runtime", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: claudeCodeAgent,
      model: "claude-opus-4-6",
      installedRuntimes: [codexRuntime],
    });

    const configDir = join(dir, ".sandcastle");
    const mainTs = await readFile(join(configDir, "main.mts"), "utf-8");
    const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");

    expect(mainTs).toContain('claudeCode("claude-opus-4-6")');
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).not.toContain("claude.ai/install.sh");
    expect(envExample).toContain("OPENAI_KEY=");
    expect(envExample).not.toContain("ANTHROPIC_API_KEY=");
  });

  it("can scaffold multiple installed runtimes without changing the default main agent", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: claudeCodeAgent,
      model: "claude-opus-4-6",
      installedRuntimes: [
        getAgentRuntime("codex")!,
        getAgentRuntime("cursor")!,
      ],
    });

    const configDir = join(dir, ".sandcastle");
    const mainTs = await readFile(join(configDir, "main.mts"), "utf-8");
    const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");

    expect(mainTs).toContain('claudeCode("claude-opus-4-6")');
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).toContain('test -x "$HOME/.local/bin/agent"');
    expect(envExample).toContain("OPENAI_KEY=");
    expect(envExample).toContain("CURSOR_API_KEY=");
  });

  it("assembles a Dockerfile from multiple selected runtime snippets once", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      installedRuntimes: [
        getAgentRuntime("codex")!,
        getAgentRuntime("cursor")!,
      ],
    });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );

    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).toContain("@openai/codex-linux-x64");
    expect(dockerfile).toContain("codex --version");
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).toContain('test -x "$HOME/.local/bin/agent"');
    expect(dockerfile).not.toContain("claude.ai/install.sh");
    expect(dockerfile).not.toContain("@mariozechner/pi-coding-agent");
    expect(dockerfile).not.toContain("opencode-ai");
    expect(countOccurrences(dockerfile, /^FROM /gm)).toBe(1);
    expect(countOccurrences(dockerfile, /Install system dependencies/g)).toBe(
      1,
    );
    expect(
      countOccurrences(dockerfile, /^USER \$\{AGENT_UID\}:\$\{AGENT_GID\}/gm),
    ).toBe(1);
    expect(countOccurrences(dockerfile, /^ENTRYPOINT /gm)).toBe(1);
  });

  it("assembles a Containerfile from multiple selected runtime snippets once", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      sandboxProvider: getSandboxProvider("podman")!,
      installedRuntimes: [
        getAgentRuntime("codex")!,
        getAgentRuntime("cursor")!,
      ],
    });

    const containerfile = await readFile(
      join(dir, ".sandcastle", "Containerfile"),
      "utf-8",
    );

    expect(containerfile).toContain("@openai/codex");
    expect(containerfile).toContain("cursor.com/install");
    expect(containerfile).toContain('test -x "$HOME/.local/bin/agent"');
    expect(containerfile).not.toContain("claude.ai/install.sh");
    expect(containerfile).not.toContain("opencode-ai");
    expect(countOccurrences(containerfile, /^FROM /gm)).toBe(1);
    expect(countOccurrences(containerfile, /^ENTRYPOINT /gm)).toBe(1);
  });

  it.each([
    ["docker", "Dockerfile"],
    ["podman", "Containerfile"],
  ] as const)(
    "keeps one selected runtime output valid for %s",
    async (sandboxProviderName, containerfileName) => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: getSandboxProvider(sandboxProviderName)!,
        installedRuntimes: [getAgentRuntime("codex")!],
      });

      const containerfile = await readFile(
        join(dir, ".sandcastle", containerfileName),
        "utf-8",
      );

      expect(containerfile).toContain("FROM node:22-bookworm");
      expect(containerfile).toContain("@openai/codex");
      expect(containerfile).not.toContain("cursor.com/install");
      expect(containerfile).not.toContain("claude.ai/install.sh");
      expect(countOccurrences(containerfile, /^FROM /gm)).toBe(1);
      expect(countOccurrences(containerfile, /^ENTRYPOINT /gm)).toBe(1);
    },
  );

  it("deduplicates selected runtime env hints in .env.example and .env", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      installedRuntimes: [
        getAgentRuntime("claude-code")!,
        getAgentRuntime("pi")!,
        getAgentRuntime("codex")!,
      ],
      backlogManager: getBacklogManager("github-issues"),
    });

    const configDir = join(dir, ".sandcastle");
    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");
    const env = await readFile(join(configDir, ".env"), "utf-8");

    for (const content of [envExample, env]) {
      expect(content).toContain("ANTHROPIC_API_KEY=");
      expect(content).toContain("OPENAI_KEY=");
      expect(content).toContain("GH_TOKEN=");
      expect(content.match(/^ANTHROPIC_API_KEY=/gm)).toHaveLength(1);
    }
  });

  it("scaffolds auth mounts for selected runtimes and backlog manager only", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "simple-loop",
      installedRuntimes: [getAgentRuntime("codex")!],
      backlogManager: getBacklogManager("github-issues"),
    });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );

    expect(mainTs).toContain(".sandcastle/auth/codex");
    expect(mainTs).toContain("/home/agent/.codex");
    expect(mainTs).toContain(".sandcastle/auth/gh");
    expect(mainTs).toContain("/home/agent/.config/gh");
    expect(mainTs).not.toContain(".sandcastle/auth/cursor");
    expect(mainTs).not.toContain(".sandcastle/auth/cursor-config");

    await expect(
      access(join(dir, ".sandcastle", "auth", "codex")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(dir, ".sandcastle", "auth", "gh")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(dir, ".sandcastle", "auth", "cursor")),
    ).rejects.toThrow();
    await expect(
      access(join(dir, ".sandcastle", "auth", "cursor-config")),
    ).rejects.toThrow();
  });

  it("scaffolds combined auth mounts for multiple selected runtimes", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "simple-loop",
      installedRuntimes: [
        getAgentRuntime("codex")!,
        getAgentRuntime("cursor")!,
      ],
      backlogManager: getBacklogManager("beads"),
    });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );

    expect(mainTs).toContain(".sandcastle/auth/codex");
    expect(mainTs).toContain("/home/agent/.codex");
    expect(mainTs).not.toContain(".sandcastle/auth/cursor");
    expect(mainTs).not.toContain("/home/agent/.cursor");
    expect(mainTs).not.toContain(".sandcastle/auth/cursor-config");
    expect(mainTs).not.toContain("/home/agent/.config/cursor");
    expect(mainTs).not.toContain(".sandcastle/auth/gh");

    await expect(
      access(join(dir, ".sandcastle", "auth", "codex")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(dir, ".sandcastle", "auth", "cursor")),
    ).rejects.toThrow();
    await expect(
      access(join(dir, ".sandcastle", "auth", "cursor-config")),
    ).rejects.toThrow();
    await expect(
      access(join(dir, ".sandcastle", "auth", "gh")),
    ).rejects.toThrow();
  });

  // --- Template-specific tests ---

  it("simple-loop template produces main.mts and prompt.md", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const configDir = join(dir, ".sandcastle");
    const { access } = await import("node:fs/promises");

    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
    await expect(access(join(configDir, "prompt.md"))).resolves.toBeUndefined();
    await expect(
      access(join(configDir, "bootstrap-prompt.md")),
    ).rejects.toThrow();
  });

  it("simple-loop main.mts imports from @ai-hero/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('"@ai-hero/sandcastle"');
  });

  it("simple-loop main.mts contains bootstrap hook and run() options", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("run(");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("3");
    // When scaffolded with default model, simple-loop uses claude-opus-4-6
    // (rewritten from template's claude-sonnet-4-6)
    expect(mainTs).toContain("promptFile");
  });

  it("simple-loop prompt.md contains shell expressions for issues and commit history", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("!`gh issue");
    expect(prompt).toContain("!`git log");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  describe("sequential-reviewer template", () => {
    it("produces main.mts, implement-prompt.md, and review-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "bootstrap-prompt.md")),
      ).rejects.toThrow();
    });

    it("main.mts imports from @ai-hero/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ai-hero/sandcastle"');
    });

    it("main.mts uses createSandbox so implementer and reviewer share a sandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("sandbox.run");
      expect(mainTs).toContain("sandbox.close");
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
    });

    it("main.mts keeps implementer/reviewer handoff on a shared explicit branch", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("const branch =");
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("promptArgs");
      expect(mainTs).toContain("BRANCH: branch");
    });

    it("main.mts only reviews when implementer produces commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implement.commits.length");
    });

    it("implement-prompt.md contains issue selection and closure, not prompt argument placeholders", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
      expect(prompt).not.toContain("{{ISSUE_TITLE}}");
      expect(prompt).not.toContain("{{BRANCH}}");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("sequential-reviewer appears in listTemplates()", async () => {
      const templates = listTemplates();
      expect(templates.some((t) => t.name === "sequential-reviewer")).toBe(
        true,
      );
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const standards = await readFile(
        join(dir, ".sandcastle", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      // Should have guiding comment, not opinionated defaults
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.sandcastle/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("review-prompt.md uses {{SOURCE_BRANCH}} instead of hardcoded main", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{SOURCE_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{SOURCE_BRANCH}}..{{BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });
  });

  it("simple-loop template does not scaffold compiled .js or .d.ts files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(dir, ".sandcastle"));
    const compiledFiles = files.filter(
      (f) =>
        f.endsWith(".js") ||
        f.endsWith(".d.ts") ||
        f.endsWith(".js.map") ||
        f.endsWith(".d.ts.map"),
    );
    expect(compiledFiles).toEqual([]);
  });

  describe("getNextStepsLines", () => {
    it("blank template returns steps mentioning .env and main filename (not npx sandcastle run)", () => {
      const lines = getNextStepsLines("blank", "main.mts");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).toContain("main.mts");
      expect(joined).toContain("tsx");
      expect(joined).not.toContain("npm exec --yes --package tsx");
      expect(joined).not.toContain("npx sandcastle run");
      expect(joined).not.toContain("npx tsx");
    });

    it("non-blank template returns steps mentioning .env, package.json, and npm run sandcastle", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).toMatch(/package\.json/);
      expect(joined).toContain("tsx");
      expect(joined).toContain("npm run sandcastle");
      expect(joined).not.toContain("npm exec --yes --package tsx");
      expect(joined).not.toContain("npx tsx");
    });

    it("blank template next steps explain the main file can mix installed providers after init", () => {
      const lines = getNextStepsLines("blank", "main.ts");
      const joined = lines.join("\n");
      expect(joined).toContain("main.ts");
      expect(joined).toContain("mix installed agent providers");
    });

    it("non-blank template next steps explain the main file can mix installed providers after init", () => {
      const lines = getNextStepsLines("simple-loop", "main.ts");
      const joined = lines.join("\n");
      expect(joined).toContain("main.ts");
      expect(joined).toContain("mix installed agent providers");
    });

    it("non-blank template includes a note about customizing bootstrap.sh", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toMatch(/Project profile/i);
      expect(joined).toContain(".sandcastle/bootstrap.sh");
      expect(joined).toContain("onSandboxReady");
      expect(joined).toMatch(/worktree|mounted/i);
      expect(joined).toMatch(/image build|during init/i);
      expect(joined).toMatch(/does not run or validate/i);
      expect(joined).toMatch(/300_000|5-minute/);
      expect(joined).toMatch(/timeoutMs/);
    });

    it("blank template next steps mention scaffolded bootstrap from Project profile", () => {
      const joined = getNextStepsLines("blank", "main.mts").join("\n");
      expect(joined).toMatch(/Project profile/i);
      expect(joined).toContain(".sandcastle/bootstrap.sh");
      expect(joined).toMatch(/does not run or validate/i);
    });

    it("non-blank template does not mention node_modules optimization defaults", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("node_modules");
      expect(joined).not.toContain("copyToWorktree");
    });

    it("blank template includes a step to customize prompt.md", () => {
      const lines = getNextStepsLines("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt.md");
    });

    it("simple-loop template includes a step to read/customize prompt files", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("sequential-reviewer template includes a step mentioning prompt files", () => {
      const lines = getNextStepsLines("sequential-reviewer", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("parallel-planner template includes a step mentioning prompt files", () => {
      const lines = getNextStepsLines("parallel-planner", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("returns at least 2 numbered steps for blank template", () => {
      const lines = getNextStepsLines("blank", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns at least 3 numbered steps for non-blank templates", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(3);
    });

    it("uses main.ts filename when passed", () => {
      const lines = getNextStepsLines("blank", "main.ts");
      const joined = lines.join("\n");
      expect(joined).toContain("main.ts");
      expect(joined).not.toContain("main.mts");
    });

    it("reviewer template mentions CODING_STANDARDS.md customization", () => {
      const lines = getNextStepsLines("sequential-reviewer", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("CODING_STANDARDS.md");
    });

    it("non-reviewer template does not mention CODING_STANDARDS.md", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });

    it("blank template does not mention CODING_STANDARDS.md", () => {
      const lines = getNextStepsLines("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });

    it("mentions preset paths when presetAgentIds are provided", () => {
      const lines = getNextStepsLines("blank", "main.mts", {
        presetAgentIds: ["reviewer"],
      });
      const joined = lines.join("\n");
      expect(joined).toContain(".sandcastle/agents/");
      expect(joined).toContain("agent-profiles.json");
      expect(joined).toContain("recommended provider/model");
      expect(joined).toContain("matching installed runtimes");
    });

    it("created package setup mentions configured package.json instead of manual add", () => {
      const joined = getNextStepsLines("blank", "main.mts", {
        packageSetup: "created",
      }).join("\n");
      expect(joined).toContain("package.json was configured");
      expect(joined).not.toContain('Add "sandcastle"');
    });

    it("invalid package setup tells user to fix package.json", () => {
      const joined = getNextStepsLines("simple-loop", "main.mts", {
        packageSetup: "invalid-skipped",
      }).join("\n");
      expect(joined).toContain("Fix package.json");
      expect(joined).toContain("@ai-hero/sandcastle");
    });
  });

  it("scaffolds pi agent with pi Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
    expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
  });

  it("scaffolds main.mts with pi factory import when pi agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('pi("claude-sonnet-4-6")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds codex agent with codex Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).toContain("@openai/codex-linux-x64");
    expect(dockerfile).toContain("codex --version");
    expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
  });

  it("scaffolds main.mts with codex factory import when codex agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('codex("gpt-5.4-mini")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds cursor agent with Cursor Agent Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: cursorAgent, model: "auto" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
  });

  it("scaffolds main.mts with cursor factory import when cursor agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: cursorAgent, model: "auto" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('cursor("auto")');
    expect(mainTs).not.toContain("claudeCode");
  });

  // --- createLabel option ---

  it("simple-loop prompt.md retains -l Sandcastle when createLabel is true", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop", createLabel: true });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("-l Sandcastle");
  });

  it("simple-loop prompt.md strips -l Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop", createLabel: false });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("-l Sandcastle");
    // The gh issue list command should still be valid
    expect(prompt).toContain("gh issue list");
    // No double spaces in gh commands from removal
    expect(prompt).not.toMatch(/gh issue list {2}/);
  });

  it("parallel-planner plan-prompt.md strips -l Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "parallel-planner",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "plan-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("-l Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("sequential-reviewer implement-prompt.md strips -l Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "sequential-reviewer",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("-l Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("scaffolded prompts that lack a runtime TASK_ID do not contain {{TASK_ID}}", async () => {
    // Regression test for #477: the {{TASK_ID}} placeholder inside
    // VIEW_TASK_COMMAND / CLOSE_TASK_COMMAND used to leak into prompts
    // whose runtime promptArgs do not include TASK_ID (simple-loop,
    // sequential-reviewer's implement, parallel-planner*'s merge),
    // causing PromptArgumentSubstitution to throw on every iteration.
    const cases: Array<{ template: string; file: string }> = [
      { template: "simple-loop", file: "prompt.md" },
      { template: "sequential-reviewer", file: "implement-prompt.md" },
      { template: "parallel-planner", file: "merge-prompt.md" },
      { template: "parallel-planner-with-review", file: "merge-prompt.md" },
    ];
    for (const { template, file } of cases) {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: template });
      const prompt = await readFile(join(dir, ".sandcastle", file), "utf-8");
      expect(prompt, `${template}/${file}`).not.toContain("{{TASK_ID}}");
    }
  });

  it("createLabel defaults to true (label retained when not specified)", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("-l Sandcastle");
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  describe("parallel-planner template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, and merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "bootstrap-prompt.md")),
      ).rejects.toThrow();
    });

    it("main.mts imports sandcastle namespace", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("sandcastle");
    });

    it("main.mts imports from @ai-hero/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ai-hero/sandcastle"');
    });

    it("main.mts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // All factory calls should use the specified model (default: claude-opus-4-6)
      expect(mainTs).toContain("claude-opus-4-6");
    });

    it("implement-prompt.md contains {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("main.mts always uses the merge agent regardless of branch count", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("completedBranches.length === 1");
    });

    it("common files are still generated with parallel-planner template", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      // Dynamic env: claude-code agent → ANTHROPIC_API_KEY, default backlog → GH_TOKEN
      expect(envExample).toContain("ANTHROPIC_API_KEY=");
      expect(envExample).toContain("GH_TOKEN=");
    });
  });

  describe("parallel-planner-with-review template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, review-prompt.md, and merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "bootstrap-prompt.md")),
      ).rejects.toThrow();
    });

    it("main.mts imports from @ai-hero/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ai-hero/sandcastle"');
    });

    it("main.mts uses createSandbox for shared sandbox per branch", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("sandbox.run");
      expect(mainTs).toContain("sandbox.close");
    });

    it("main.mts runs implementer then reviewer sequentially within each sandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
      expect(mainTs).toContain("implement.commits.length > 0");
    });

    it("main.mts captures reviewer result and merges commits from both runs", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Reviewer result must be captured, not discarded
      expect(mainTs).toContain("const review = await sandbox.run");
      // Commits from both implementer and reviewer must be merged
      expect(mainTs).toContain("implement.commits");
      expect(mainTs).toContain("review.commits");
    });

    it("main.mts uses Promise.allSettled for parallel execution", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("Promise.allSettled");
    });

    it("main.mts has correct maxIterations: planner=1, implementer=100, reviewer=1, merger=1", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Check planner maxIterations: 1 (near "planner" name)
      const plannerSection = mainTs.slice(
        mainTs.indexOf('name: "planner"') - 200,
        mainTs.indexOf('name: "planner"') + 200,
      );
      expect(plannerSection).toContain("maxIterations: 1");

      // Check implementer maxIterations: 100
      const implementerSection = mainTs.slice(
        mainTs.indexOf('name: "implementer"') - 200,
        mainTs.indexOf('name: "implementer"') + 200,
      );
      expect(implementerSection).toContain("maxIterations: 100");

      // Check reviewer maxIterations: 1
      const reviewerSection = mainTs.slice(
        mainTs.indexOf('name: "reviewer"') - 200,
        mainTs.indexOf('name: "reviewer"') + 200,
      );
      expect(reviewerSection).toContain("maxIterations: 1");

      // Check merger maxIterations: 1
      const mergerSection = mainTs.slice(
        mainTs.indexOf('name: "merger"') - 200,
        mainTs.indexOf('name: "merger"') + 200,
      );
      expect(mergerSection).toContain("maxIterations: 1");
    });

    it("implement-prompt.md contains {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("parallel-planner-with-review appears in listTemplates()", () => {
      const templates = listTemplates();
      expect(
        templates.some((t) => t.name === "parallel-planner-with-review"),
      ).toBe(true);
    });

    it("common files are still generated", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      // Dynamic env: claude-code agent → ANTHROPIC_API_KEY, default backlog → GH_TOKEN
      expect(envExample).toContain("ANTHROPIC_API_KEY=");
      expect(envExample).toContain("GH_TOKEN=");
    });

    it("main.mts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("claude-opus-4-6");
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const standards = await readFile(
        join(dir, ".sandcastle", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.sandcastle/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("review-prompt.md uses {{SOURCE_BRANCH}} instead of hardcoded main", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{SOURCE_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{SOURCE_BRANCH}}..{{BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });
  });

  // --- Backlog manager ---

  describe("Backlog manager registry", () => {
    it("listBacklogManagers returns github-issues and beads", () => {
      const managers = listBacklogManagers();
      expect(managers.some((m) => m.name === "github-issues")).toBe(true);
      expect(managers.some((m) => m.name === "beads")).toBe(true);
    });

    it("getBacklogManager returns github-issues entry with expected templateArgs", () => {
      const manager = getBacklogManager("github-issues");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("GitHub Issues");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(
        "gh issue list",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("labels");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("comments");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain(
        "gh issue view",
      );
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain(
        "gh issue close",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain(
        "GitHub CLI",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain("gh");
    });

    it("getBacklogManager returns beads entry with expected templateArgs", () => {
      const manager = getBacklogManager("beads");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("Beads");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toBe("bd ready --json");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain("bd show");
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain("bd close");
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain("beads");
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain("libicu72");
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain(
        "corepack enable",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).not.toContain("gh");
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).not.toContain(
        "x86_64-linux-gnu",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain(
        "dpkg-architecture -qDEB_HOST_MULTIARCH",
      );
    });

    it("getBacklogManager returns undefined for unknown manager", () => {
      expect(getBacklogManager("nonexistent")).toBeUndefined();
    });
  });

  describe("Backlog manager scaffold", () => {
    it("simple-loop with github-issues produces prompt with gh issue commands (richer version)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("simple-loop with beads produces prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue list");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("simple-loop with beads skips -l Sandcastle (no label to strip)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("-l Sandcastle");
    });

    it("simple-loop with github-issues retains -l Sandcastle when createLabel is true", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("github-issues"),
        createLabel: true,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("-l Sandcastle");
    });

    it("simple-loop with github-issues strips -l Sandcastle when createLabel is false", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("github-issues"),
        createLabel: false,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("-l Sandcastle");
      expect(prompt).toContain("gh issue list");
    });

    it("scaffold without backlogManager defaults to github-issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      // Should default to github-issues and replace placeholders
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("simple-loop prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- sequential-reviewer ---

    it("sequential-reviewer with github-issues produces implement-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("sequential-reviewer with beads produces implement-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue list");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("sequential-reviewer implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- blank ---

    it("blank with github-issues produces prompt with gh issue list example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("blank with beads produces prompt with bd ready example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    // --- parallel-planner ---

    it("parallel-planner with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner with beads produces plan-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).not.toContain("gh issue");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner main.mts uses id:string and TASK_ID", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: string");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner with github-issues produces implement-prompt with gh issue view", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue view");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner with beads produces implement-prompt with bd show", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd show");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner with github-issues produces merge-prompt with gh issue close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner with beads produces merge-prompt with bd close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner implement-prompt does not contain close-issue instruction", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- parallel-planner-with-review ---

    it("parallel-planner-with-review with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces plan-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).not.toContain("gh issue");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review main.mts uses id:string and TASK_ID", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: string");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner-with-review implement-prompt does not contain close-issue instruction", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner-with-review with github-issues produces implement-prompt with gh issue view", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue view");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces implement-prompt with bd show", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd show");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with github-issues produces merge-prompt with gh issue close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces merge-prompt with bd close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- Dockerfile backlog manager tools ---

    it("scaffold with github-issues produces Dockerfile with GitHub CLI install", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        backlogManager: getBacklogManager("github-issues"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("GitHub CLI");
      expect(dockerfile).toContain("gh");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    });

    it("scaffold with beads produces Dockerfile with beads install (no GitHub CLI)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        backlogManager: getBacklogManager("beads"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("libicu72");
      expect(dockerfile).toContain("corepack enable");
      expect(dockerfile).not.toContain("GitHub CLI");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
      expect(dockerfile).not.toContain("x86_64-linux-gnu");
      expect(dockerfile).toContain("dpkg-architecture -qDEB_HOST_MULTIARCH");
    });

    it("scaffold with beads + podman produces Containerfile with beads install", async () => {
      const dir = await makeDir();
      const podmanProvider = getSandboxProvider("podman")!;
      await runScaffold(dir, {
        backlogManager: getBacklogManager("beads"),
        sandboxProvider: podmanProvider,
      });

      const containerfile = await readFile(
        join(dir, ".sandcastle", "Containerfile"),
        "utf-8",
      );
      expect(containerfile).toContain("beads");
      expect(containerfile).toContain("libicu72");
      expect(containerfile).not.toContain("GitHub CLI");
      expect(containerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
      expect(containerfile).not.toContain("x86_64-linux-gnu");
      expect(containerfile).toContain("dpkg-architecture -qDEB_HOST_MULTIARCH");
    });

    it("scaffold with beads + pi agent produces Dockerfile with beads install and pi agent", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        agent: piAgent,
        model: "claude-sonnet-4-6",
        backlogManager: getBacklogManager("beads"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
      expect(dockerfile).not.toContain("GitHub CLI");
    });
  });

  // --- Project package.json setup (issue #35) ---

  describe("ensureProjectPackage", () => {
    it("creates package.json with sandcastle devDependencies when none exists", async () => {
      const dir = await makeDir();
      const result = await runEnsureProjectPackage(dir, "main.mts");

      expect(result.setup).toBe("created");
      expect(result.needsInstall).toBe(true);
      const pkg = JSON.parse(
        await readFile(join(dir, "package.json"), "utf-8"),
      ) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.devDependencies?.["@ai-hero/sandcastle"]).toBe("^0.5.9");
      expect(pkg.devDependencies?.tsx).toMatch(/^\^/);
      expect(pkg.scripts?.sandcastle).toBe("tsx .sandcastle/main.mts");
    });

    it("adds missing devDependencies and script to existing package.json", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "my-py-app", private: true }),
      );
      const result = await runEnsureProjectPackage(dir, "main.mts");

      expect(result.setup).toBe("updated");
      expect(result.needsInstall).toBe(true);
      const pkg = JSON.parse(
        await readFile(join(dir, "package.json"), "utf-8"),
      ) as {
        name: string;
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.name).toBe("my-py-app");
      expect(pkg.devDependencies?.["@ai-hero/sandcastle"]).toBe("^0.5.9");
      expect(pkg.devDependencies?.tsx).toMatch(/^\^/);
      expect(pkg.scripts?.sandcastle).toBe("tsx .sandcastle/main.mts");
    });

    it("leaves invalid package.json unchanged", async () => {
      const dir = await makeDir();
      const invalid = "not valid json{{{";
      await writeFile(join(dir, "package.json"), invalid);
      const result = await runEnsureProjectPackage(dir, "main.mts");

      expect(result.setup).toBe("invalid-skipped");
      expect(result.needsInstall).toBe(false);
      expect(await readFile(join(dir, "package.json"), "utf-8")).toBe(invalid);
    });

    it("scaffold creates package.json when none exists", async () => {
      const dir = await makeDir();
      await runScaffold(dir);

      const pkg = JSON.parse(
        await readFile(join(dir, "package.json"), "utf-8"),
      ) as { devDependencies?: Record<string, string> };
      expect(pkg.devDependencies?.["@ai-hero/sandcastle"]).toMatch(/^\^/);
      expect(pkg.devDependencies?.tsx).toMatch(/^\^/);
    });

    it("scaffolded main.mts comments recommend npm run sandcastle, not npm exec tsx", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainContent).toContain("npm run sandcastle");
      expect(mainContent).toContain("tsx .sandcastle/main.mts");
      expect(mainContent).not.toContain("npm exec --yes --package tsx");
    });
  });

  // --- ESM extension detection ---

  describe("main file extension detection", () => {
    it("scaffolds main.mts when no package.json exists", async () => {
      const dir = await makeDir();
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "main.mts")),
      ).resolves.toBeUndefined();
    });

    it("scaffolds main.mts when package.json has no type field", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainContent).toContain("@ai-hero/sandcastle");
    });

    it("scaffolds main.mts when package.json has type: commonjs", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "commonjs" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });

    it("scaffolds main.ts when package.json has type: module", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.ts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "main.ts")),
      ).resolves.toBeUndefined();
      // main.mts should NOT exist
      await expect(
        access(join(dir, ".sandcastle", "main.mts")),
      ).rejects.toThrow();
    });

    it("main.ts scaffolded with type: module has correct imports and factory calls", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain("@ai-hero/sandcastle");
      expect(mainContent).toContain('claudeCode("claude-opus-4-6")');
    });

    it("main.ts scaffolded with type: module rewrites agent factory correctly", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain('pi("claude-sonnet-4-6")');
      expect(mainContent).not.toContain("claudeCode");
    });

    it("comments in scaffolded main.ts reference main.ts, not main.mts", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).not.toContain("main.mts");
      expect(mainContent).toContain("main.ts");
    });

    it("scaffolds main.mts when package.json is invalid JSON", async () => {
      const dir = await makeDir();
      await writeFile(join(dir, "package.json"), "not valid json{{{");
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });
  });

  // ---------------------------------------------------------------------------
  // Sandbox provider selection
  // ---------------------------------------------------------------------------

  describe("sandbox provider", () => {
    const dockerProvider = getSandboxProvider("docker")!;
    const noSandboxProvider = getSandboxProvider("no-sandbox")!;
    const podmanProvider = getSandboxProvider("podman")!;

    it("selecting docker writes Dockerfile to .sandcastle/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    });

    it("selecting podman writes Containerfile to .sandcastle/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const containerfile = await readFile(
        join(dir, ".sandcastle", "Containerfile"),
        "utf-8",
      );
      expect(containerfile).toContain("FROM node:22-bookworm");
      expect(containerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    });

    it("selecting podman does not write Dockerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Dockerfile")),
      ).rejects.toThrow();
    });

    it("selecting docker does not write Containerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Containerfile")),
      ).rejects.toThrow();
    });

    it("selecting no-sandbox rewrites the scaffolded main file to use noSandbox()", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: noSandboxProvider,
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );

      expect(main).toContain(
        'import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";',
      );
      expect(main).toContain("const sandboxProvider = noSandbox();");
      expect(main).not.toContain("import { docker }");
      expect(main).not.toContain("const sandboxProvider = docker({");
    });
  });

  describe("preset agent scaffold", () => {
    it("validatePresetRegistries passes", () => {
      expect(() => validatePresetRegistries()).not.toThrow();
    });

    it("rejects unknown preset agent id", async () => {
      const dir = await makeDir();
      await expect(
        runScaffold(dir, { presetAgentIds: ["not-a-real-preset"] }),
      ).rejects.toThrow(/Unknown preset agent/);
    });

    it("writes agents, skills, and manifest for a single preset", async () => {
      const dir = await makeDir();
      const result = await runScaffold(dir, { presetAgentIds: ["reviewer"] });
      expect(result.mainFilename).toBeDefined();

      const agentMd = await readFile(
        join(dir, ".sandcastle", "agents", "reviewer.md"),
        "utf-8",
      );
      expect(agentMd).toContain(".sandcastle/skills/role-guidance/SKILL.md");

      const skillMd = await readFile(
        join(dir, ".sandcastle", "skills", "role-guidance", "SKILL.md"),
        "utf-8",
      );
      expect(skillMd).toContain("Sandcastle");

      const manifest = JSON.parse(
        await readFile(
          join(dir, ".sandcastle", "agent-profiles.json"),
          "utf-8",
        ),
      ) as {
        version: number;
        profiles: Record<string, { promptRelativePath: string }>;
      };
      expect(manifest.version).toBe(1);
      expect(manifest.profiles.reviewer?.promptRelativePath).toBe(
        "agents/reviewer.md",
      );
    });

    it("keeps preset recommendations as metadata when explicit installed runtimes differ from the default agent", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        agent: claudeCodeAgent,
        model: "claude-opus-4-6",
        installedRuntimes: [codexRuntime],
        presetAgentIds: ["miniprogram"],
      });

      const configDir = join(dir, ".sandcastle");
      const main = await readFile(join(configDir, "main.mts"), "utf-8");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      const manifest = JSON.parse(
        await readFile(join(configDir, "agent-profiles.json"), "utf-8"),
      ) as {
        profiles: Record<
          string,
          { recommendedAgentName: string; recommendedModel: string }
        >;
      };

      expect(main).toContain('claudeCode("claude-opus-4-6")');
      expect(main).not.toContain("codex(");
      expect(dockerfile).toContain("@openai/codex");
      expect(dockerfile).not.toContain("claude.ai/install.sh");
      expect(envExample).toContain("OPENAI_KEY=");
      expect(envExample).not.toContain("ANTHROPIC_API_KEY=");
      expect(manifest.profiles.miniprogram).toMatchObject({
        recommendedAgentName: "codex",
        recommendedModel: "gpt-5.4-mini",
      });
    });

    it("deduplicates shared skills when multiple presets are selected", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { presetAgentIds: ["reviewer", "planner"] });
      const skillDirs = await readdir(join(dir, ".sandcastle", "skills"));
      expect(skillDirs.sort()).toEqual(["role-guidance"]);
    });

    it("includes distinct skills when presets do not overlap", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        presetAgentIds: ["reviewer", "merger", "miniprogram"],
      });
      const skillDirs = (
        await readdir(join(dir, ".sandcastle", "skills"))
      ).sort();
      expect(skillDirs).toEqual([
        "merge-playbook",
        "miniprogram-context",
        "role-guidance",
      ]);
    });

    it("adds preset agent and skill paths to inline copyToWorktree arrays", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        presetAgentIds: ["reviewer"],
      });
      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).not.toContain('copyToWorktree: ["node_modules"');
    });

    it("adds preset agent and skill paths to copyToWorktree constants", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        presetAgentIds: ["reviewer"],
      });
      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).not.toContain('const copyToWorktree = ["node_modules"');
    });
  });
});

// ---------------------------------------------------------------------------
// Sandbox provider registry
// ---------------------------------------------------------------------------

describe("Sandbox provider registry", () => {
  it("listSandboxProviders returns docker and podman", () => {
    const providers = listSandboxProviders();
    expect(providers.some((p) => p.name === "docker")).toBe(true);
    expect(providers.some((p) => p.name === "podman")).toBe(true);
  });

  it("listInitSandboxProviders returns docker and no-sandbox", () => {
    const providers = listInitSandboxProviders();
    expect(providers.some((p) => p.name === "docker")).toBe(true);
    expect(providers.some((p) => p.name === "no-sandbox")).toBe(true);
    expect(providers.some((p) => p.name === "podman")).toBe(false);
  });

  it("getSandboxProvider returns docker entry", () => {
    const provider = getSandboxProvider("docker");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Dockerfile");
    expect(provider!.cliNamespace).toBe("docker");
  });

  it("getSandboxProvider returns podman entry", () => {
    const provider = getSandboxProvider("podman");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Containerfile");
    expect(provider!.cliNamespace).toBe("podman");
  });

  it("getInitSandboxProvider returns no-sandbox entry", () => {
    const provider = getInitSandboxProvider("no-sandbox");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Dockerfile");
    expect(provider!.cliNamespace).toBe("docker");
  });

  it("getInitSandboxProvider excludes podman", () => {
    expect(getInitSandboxProvider("podman")).toBeUndefined();
  });

  it("getSandboxProvider returns undefined for unknown provider", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
  });
});

describe("capability pack scaffold", () => {
  it("validateCapabilityRegistries passes", () => {
    expect(() => validateCapabilityRegistries()).not.toThrow();
  });

  it("implicit generic init does not write capability.json", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    await expect(
      access(join(dir, ".sandcastle", "capability.json")),
    ).rejects.toThrow();
  });

  it("explicit generic capability writes capability.json without changing blank scaffold", async () => {
    const dir = await makeDir();
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "generic",
    });
    await runScaffold(dir, {
      templateName: "blank",
      capabilityInit,
    });

    const manifest = JSON.parse(
      await readFile(join(dir, ".sandcastle", "capability.json"), "utf-8"),
    ) as {
      version: number;
      capability: string;
      addons: string[];
      setupActions: unknown[];
    };
    expect(manifest).toEqual({
      version: 1,
      capability: "generic",
      addons: [],
      setupActions: [],
    });
    expect(
      await readFile(join(dir, ".sandcastle", "bootstrap.sh"), "utf-8"),
    ).toContain("no-op");
  });

  it("explicit miniprogram capability writes manifest metadata", async () => {
    const dir = await makeDir();
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
    });
    await runScaffold(dir, {
      templateName: capabilityInit.templateName,
      projectProfile: getProjectProfile(capabilityInit.projectProfileName)!,
      presetAgentIds: capabilityInit.presetAgentIds,
      capabilityInit,
    });

    const manifest = JSON.parse(
      await readFile(join(dir, ".sandcastle", "capability.json"), "utf-8"),
    ) as {
      capability: string;
      variant: string;
      verification: { entrypoint: string; diagnosticLog: string };
      setupActions: CapabilitySetupAction[];
    };
    expect(manifest.capability).toBe("miniprogram");
    expect(manifest.variant).toBe("native");
    expect(manifest.verification).toEqual({
      entrypoint: ".sandcastle/verify.sh",
      diagnosticLog: "debug/wx-check.log",
    });
    expect(manifest.setupActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "miniprogram-ci-install",
          status: "skipped",
        }),
      ]),
    );
    expect(
      buildCapabilityManifest(
        capabilityInit,
        manifest.setupActions as CapabilitySetupAction[],
      ),
    ).toEqual(manifest);
  });

  it("records no_package_json when user approves miniprogram-ci install without package.json", async () => {
    const dir = await makeDir();
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
    });
    await runScaffold(dir, {
      templateName: capabilityInit.templateName,
      projectProfile: getProjectProfile(capabilityInit.projectProfileName)!,
      capabilityInit,
      miniprogramCiInstallApproved: true,
    });

    const manifest = JSON.parse(
      await readFile(join(dir, ".sandcastle", "capability.json"), "utf-8"),
    ) as { setupActions: CapabilitySetupAction[] };
    expect(manifest.setupActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "miniprogram-ci-install",
          status: "skipped",
          reason: "no_package_json",
        }),
      ]),
    );
  });

  it("records install_command_failed when user-approved miniprogram-ci install fails", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "wx-app" }),
    );
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
    });
    setMiniprogramCiInstallRunnerForTests(() => ({
      ok: false,
      stderrSummary: "install failed",
    }));

    await runScaffold(dir, {
      templateName: capabilityInit.templateName,
      projectProfile: getProjectProfile(capabilityInit.projectProfileName)!,
      capabilityInit,
      miniprogramCiInstallApproved: true,
    });

    setMiniprogramCiInstallRunnerForTests(undefined);
    const manifest = JSON.parse(
      await readFile(join(dir, ".sandcastle", "capability.json"), "utf-8"),
    ) as { setupActions: CapabilitySetupAction[] };
    const installAction = manifest.setupActions.find(
      (action) => action.id === "miniprogram-ci-install",
    );
    expect(installAction).toMatchObject({
      status: "failed",
      reason: "install_command_failed",
      command: "npm install -D miniprogram-ci",
    });
    expect(installAction?.summary?.length).toBeLessThanOrEqual(240);
  });

  it("miniprogram init writes core scaffold files and setup checklist", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "project.config.json"),
      JSON.stringify({ appid: "wxabcdef1234567890", miniprogramRoot: "./" }),
    );
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
    });
    await runScaffold(dir, {
      templateName: capabilityInit.templateName,
      projectProfile: getProjectProfile(capabilityInit.projectProfileName)!,
      capabilityInit,
    });

    const configDir = join(dir, ".sandcastle");
    const verifySh = await readFile(join(configDir, "verify.sh"), "utf-8");
    expect(verifySh).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(verifySh).toContain("wx:check");
    expect(verifySh).toContain("wx-check-native.mjs");
    expect(verifySh).toContain("project_wx_check");
    expect(verifySh).toContain("project_wx_check_summary");
    expect(verifySh).not.toContain("tee -a");
    expect(verifySh).not.toContain("capability.json");

    const nativeVerifier = await readFile(
      join(configDir, "wx-check-native.mjs"),
      "utf-8",
    );
    expect(nativeVerifier).toContain("debug/wx-check.log");

    const context = await readFile(
      join(configDir, "context", "miniprogram.md"),
      "utf-8",
    );
    expect(context).toContain("verify.sh");

    const setup = await readFile(
      join(configDir, "context", "miniprogram-setup.md"),
      "utf-8",
    );
    expect(setup).toContain("Init-time snapshot");
    expect(setup).toContain("wxabcdef1234567890");
    expect(setup).toContain("private.*.key");
    expect(setup).toContain("WX_UPLOAD_KEY_PATH");

    const uploadIgnore = await readFile(
      join(configDir, "auth", "wx-upload", ".gitignore"),
      "utf-8",
    );
    expect(uploadIgnore).toContain("private.*.key");
  });

  it("rejects incompatible miniprogram template before scaffolding files", async () => {
    const dir = await makeDir();
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
    });

    await expect(
      runScaffold(dir, {
        templateName: "custom-loop",
        capabilityInit,
      }),
    ).rejects.toThrow(
      /not compatible with capability pack "miniprogram".*Supported templates/,
    );
  });

  it("allows miniprogram blank template and returns manual wiring warning", async () => {
    const dir = await makeDir();
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
      explicitTemplate: "blank",
    });
    const result = await runScaffold(dir, {
      templateName: "blank",
      projectProfile: getProjectProfile("node")!,
      capabilityInit,
    });

    expect(result.capabilityBlankTemplateWarning).toMatch(/verify\.sh/);
    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain(MINIPROGRAM_VERIFICATION_PROMPT_MARKER);
    expect(prompt).toContain("debug/wx-check.log");
  });
});

describe("miniprogram capability prompt assembly", () => {
  const supportedTemplates = [
    "parallel-planner",
    "parallel-planner-with-review",
    "sequential-reviewer",
    "simple-loop",
  ] as const;

  for (const templateName of supportedTemplates) {
    it(`appends shared verification contract to ${templateName} orchestration prompts`, async () => {
      const dir = await makeDir();
      const capabilityInit = resolveCapabilityInitOptions({
        capabilityId: "miniprogram",
        explicitTemplate: templateName,
      });
      await runScaffold(dir, {
        templateName,
        projectProfile: getProjectProfile("node")!,
        presetAgentIds: capabilityInit.presetAgentIds,
        capabilityInit,
      });

      for (const promptFile of listTemplatePromptFiles(templateName)) {
        const content = await readFile(
          join(dir, ".sandcastle", promptFile),
          "utf-8",
        );
        expect(content, promptFile).toContain(
          MINIPROGRAM_VERIFICATION_PROMPT_MARKER,
        );
        expect(content, promptFile).toContain(".sandcastle/verify.sh");
        expect(content, promptFile).toContain("debug/wx-check.log");
        expect(content, promptFile).toContain("not_configured");
        expect(content, promptFile).toMatch(/`local`/);
        expect(content, promptFile).toMatch(/`platform`/);
        expect(content, promptFile).toMatch(/`artifacts`/);
      }
    });
  }

  it("uses the same verification section across planner, implementer, reviewer, and merger prompts", async () => {
    const dir = await makeDir();
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
    });
    await runScaffold(dir, {
      templateName: "parallel-planner-with-review",
      projectProfile: getProjectProfile("node")!,
      capabilityInit,
    });

    const sections = await Promise.all(
      listTemplatePromptFiles("parallel-planner-with-review").map(
        async (promptFile) => {
          const content = await readFile(
            join(dir, ".sandcastle", promptFile),
            "utf-8",
          );
          const markerIndex = content.indexOf(
            MINIPROGRAM_VERIFICATION_PROMPT_MARKER,
          );
          return content.slice(markerIndex);
        },
      ),
    );
    expect(new Set(sections).size).toBe(1);
  });
});

describe("miniprogram runtime-debug add-on", () => {
  const runtimeDebugCapabilityInit = resolveCapabilityInitOptions({
    capabilityId: "miniprogram",
    addonIds: [RUNTIME_DEBUG_ADDON_ID],
    sandboxProviderName: "no-sandbox",
  });

  it("does not generate runtime-debug context without the add-on", async () => {
    const dir = await makeDir();
    const capabilityInit = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
      sandboxProviderName: "no-sandbox",
    });
    await runScaffold(dir, {
      templateName: capabilityInit.templateName,
      projectProfile: getProjectProfile(capabilityInit.projectProfileName)!,
      capabilityInit,
    });

    await expect(
      access(
        join(dir, ".sandcastle", "context", "miniprogram-runtime-debug.md"),
      ),
    ).rejects.toThrow();
  });

  it("generates runtime-debug context and prompt references when selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: runtimeDebugCapabilityInit.templateName,
      projectProfile: getProjectProfile(
        runtimeDebugCapabilityInit.projectProfileName,
      )!,
      capabilityInit: runtimeDebugCapabilityInit,
    });

    const runtimeDebugContext = await readFile(
      join(dir, ".sandcastle", "context", "miniprogram-runtime-debug.md"),
      "utf-8",
    );
    expect(runtimeDebugContext).toContain("WaterTian");
    expect(runtimeDebugContext).toContain("wechat-devtools-mcp");
    expect(runtimeDebugContext).toContain("FliPPeDround");
    expect(runtimeDebugContext).toMatch(/experimental fallback/i);
    expect(runtimeDebugContext).toContain("wait IDE port timeout");
    expect(runtimeDebugContext).toContain("CLI_TIMEOUT");
    expect(runtimeDebugContext).toContain("service port");
    expect(runtimeDebugContext).toContain("Login state");
    expect(runtimeDebugContext).toContain("project path");
    expect(runtimeDebugContext).toContain("automator");
    expect(runtimeDebugContext).toMatch(/does not replace.*verify\.sh/is);
    expect(runtimeDebugContext).toMatch(/not a completion standard/i);
    expect(runtimeDebugContext).toMatch(/not.*start WeChat Developer Tools/i);

    for (const promptFile of listTemplatePromptFiles(
      runtimeDebugCapabilityInit.templateName,
    )) {
      const prompt = await readFile(
        join(dir, ".sandcastle", promptFile),
        "utf-8",
      );
      expect(prompt, promptFile).toContain(
        MINIPROGRAM_RUNTIME_DEBUG_PROMPT_MARKER,
      );
      expect(prompt, promptFile).toContain(
        ".sandcastle/context/miniprogram-runtime-debug.md",
      );
      expect(prompt, promptFile).toMatch(/not.*start WeChat Developer Tools/i);
      expect(prompt, promptFile).toMatch(/only when/i);
    }
  });

  it("does not change verify.sh when runtime-debug add-on is selected", async () => {
    const dirWithoutAddon = await makeDir();
    const withoutAddon = resolveCapabilityInitOptions({
      capabilityId: "miniprogram",
    });
    await runScaffold(dirWithoutAddon, {
      templateName: withoutAddon.templateName,
      projectProfile: getProjectProfile(withoutAddon.projectProfileName)!,
      capabilityInit: withoutAddon,
    });

    const dirWithAddon = await makeDir();
    await runScaffold(dirWithAddon, {
      templateName: runtimeDebugCapabilityInit.templateName,
      projectProfile: getProjectProfile(
        runtimeDebugCapabilityInit.projectProfileName,
      )!,
      capabilityInit: runtimeDebugCapabilityInit,
    });

    const verifyWithout = await readFile(
      join(dirWithoutAddon, ".sandcastle", "verify.sh"),
      "utf-8",
    );
    const verifyWith = await readFile(
      join(dirWithAddon, ".sandcastle", "verify.sh"),
      "utf-8",
    );
    expect(verifyWith).toBe(verifyWithout);
  });

  it("records runtime-debug in capability manifest when selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: runtimeDebugCapabilityInit.templateName,
      projectProfile: getProjectProfile(
        runtimeDebugCapabilityInit.projectProfileName,
      )!,
      capabilityInit: runtimeDebugCapabilityInit,
    });

    const manifest = JSON.parse(
      await readFile(join(dir, ".sandcastle", "capability.json"), "utf-8"),
    ) as { addons: string[] };
    expect(manifest.addons).toEqual([RUNTIME_DEBUG_ADDON_ID]);
  });
});
