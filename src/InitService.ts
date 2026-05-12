import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPresetAgentDefinition,
  getPresetBundlesRoot,
  PRESET_AGENT_DEFINITIONS,
  validatePresetRegistries,
  type PresetAgentDefinition,
} from "./presetAgents.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

const GITIGNORE = `.env
auth/
logs/
worktrees/
`;

export interface TemplateMetadata {
  name: string;
  description: string;
}

const TEMPLATES: TemplateMetadata[] = [
  {
    name: "blank",
    description: "Bare scaffold — write your own prompt and orchestration",
  },
  {
    name: "simple-loop",
    description: "Picks issues one by one and closes them",
  },
  {
    name: "sequential-reviewer",
    description:
      "Implements issues one by one, with a code review step after each",
  },
  {
    name: "parallel-planner",
    description:
      "Plans parallelizable issues, executes on separate branches, merges",
  },
  {
    name: "parallel-planner-with-review",
    description:
      "Plans parallelizable issues, executes with per-branch review, merges",
  },
];

export const listTemplates = (): TemplateMetadata[] => TEMPLATES;

// ---------------------------------------------------------------------------
// Agent registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface AgentEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly factoryImport: string;
}

interface AgentRuntimeDockerfileInstall {
  readonly root?: string;
  readonly user?: string;
  readonly pathEntries?: readonly string[];
}

interface EnvExampleBlock {
  readonly envVars: readonly string[];
  readonly content: string;
}

interface AuthMountEntry {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
}

export interface AgentRuntimeEntry {
  /** Filesystem-safe runtime identifier. */
  readonly name: string;
  readonly label: string;
  readonly dockerfileInstall: AgentRuntimeDockerfileInstall;
  readonly dockerfileTemplate: string;
  /** Env vars represented by envExample, used to deduplicate shared auth hints. */
  readonly envVars: readonly string[];
  /** Lines to include in the generated `.env.example` for this runtime's API key. */
  readonly envExample: string;
  /** Host auth/config directories to mount for this runtime. */
  readonly authMounts?: readonly AuthMountEntry[];
}

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
# macOS commonly uses GID 20 ("staff"), which already exists in Debian images.
RUN set -eux; \\
  if ! getent group "$AGENT_GID" >/dev/null; then \\
    groupmod -g "$AGENT_GID" node; \\
  fi; \\
  usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node; \\
  mkdir -p /home/agent/.config; \\
  chown -R "$AGENT_UID:$AGENT_GID" /home/agent
USER \${AGENT_UID}:\${AGENT_GID}
ENV HOME="/home/agent"

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const PI_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN set -eux; \\
  if ! getent group "$AGENT_GID" >/dev/null; then \\
    groupmod -g "$AGENT_GID" node; \\
  fi; \\
  usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node; \\
  mkdir -p /home/agent/.config; \\
  chown -R "$AGENT_UID:$AGENT_GID" /home/agent

# Install pi coding agent (run as root before USER agent)
RUN npm install -g @mariozechner/pi-coding-agent

USER \${AGENT_UID}:\${AGENT_GID}
ENV HOME="/home/agent"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN set -eux; \\
  if ! getent group "$AGENT_GID" >/dev/null; then \\
    groupmod -g "$AGENT_GID" node; \\
  fi; \\
  usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node; \\
  mkdir -p /home/agent/.config; \\
  chown -R "$AGENT_UID:$AGENT_GID" /home/agent

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex

USER \${AGENT_UID}:\${AGENT_GID}
ENV HOME="/home/agent"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CURSOR_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN set -eux; \\
  if ! getent group "$AGENT_GID" >/dev/null; then \\
    groupmod -g "$AGENT_GID" node; \\
  fi; \\
  usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node; \\
  mkdir -p /home/agent/.config; \\
  chown -R "$AGENT_UID:$AGENT_GID" /home/agent

USER \${AGENT_UID}:\${AGENT_GID}
ENV HOME="/home/agent"

# Install Cursor Agent CLI
RUN curl https://cursor.com/install -fsS | bash

# Add Cursor Agent to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const OPENCODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN set -eux; \\
  if ! getent group "$AGENT_GID" >/dev/null; then \\
    groupmod -g "$AGENT_GID" node; \\
  fi; \\
  usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node; \\
  mkdir -p /home/agent/.config; \\
  chown -R "$AGENT_UID:$AGENT_GID" /home/agent

# Install OpenCode CLI (run as root before USER agent)
RUN npm install -g opencode-ai@latest

USER \${AGENT_UID}:\${AGENT_GID}
ENV HOME="/home/agent"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const AGENT_REGISTRY: AgentEntry[] = [
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-6",
    factoryImport: "claudeCode",
  },
  {
    name: "pi",
    label: "Pi",
    defaultModel: "claude-sonnet-4-6",
    factoryImport: "pi",
  },
  {
    name: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4-mini",
    factoryImport: "codex",
  },
  {
    name: "cursor",
    label: "Cursor",
    defaultModel: "auto",
    factoryImport: "cursor",
  },
  {
    name: "opencode",
    label: "OpenCode",
    defaultModel: "opencode/big-pickle",
    factoryImport: "opencode",
  },
];

export const listAgents = (): AgentEntry[] => AGENT_REGISTRY;

const AGENT_RUNTIME_REGISTRY: AgentRuntimeEntry[] = [
  {
    name: "claude-code",
    label: "Claude Code",
    dockerfileInstall: {
      user: `# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash`,
      pathEntries: ["/home/agent/.local/bin"],
    },
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
    envVars: ["ANTHROPIC_API_KEY"],
    envExample: `# Anthropic API key
# If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191
ANTHROPIC_API_KEY=`,
  },
  {
    name: "pi",
    label: "Pi",
    dockerfileInstall: {
      root: `# Install pi coding agent (run as root before USER agent)
RUN npm install -g @mariozechner/pi-coding-agent`,
    },
    dockerfileTemplate: PI_DOCKERFILE,
    envVars: ["ANTHROPIC_API_KEY"],
    envExample: `# Anthropic API key
ANTHROPIC_API_KEY=`,
  },
  {
    name: "codex",
    label: "Codex",
    dockerfileInstall: {
      root: `# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex`,
    },
    dockerfileTemplate: CODEX_DOCKERFILE,
    envVars: ["OPENAI_KEY"],
    envExample: `# OpenAI API key
OPENAI_KEY=`,
    authMounts: [
      { hostPath: ".sandcastle/auth/codex", sandboxPath: "/home/agent/.codex" },
    ],
  },
  {
    name: "cursor",
    label: "Cursor",
    dockerfileInstall: {
      user: `# Install Cursor Agent CLI
RUN curl https://cursor.com/install -fsS | bash`,
      pathEntries: ["/home/agent/.local/bin"],
    },
    dockerfileTemplate: CURSOR_DOCKERFILE,
    envVars: ["CURSOR_API_KEY"],
    envExample: `# Cursor API key
CURSOR_API_KEY=`,
    authMounts: [
      {
        hostPath: ".sandcastle/auth/cursor",
        sandboxPath: "/home/agent/.cursor",
      },
      {
        hostPath: ".sandcastle/auth/cursor-config",
        sandboxPath: "/home/agent/.config/cursor",
      },
    ],
  },
  {
    name: "opencode",
    label: "OpenCode",
    dockerfileInstall: {
      root: `# Install OpenCode CLI (run as root before USER agent)
RUN npm install -g opencode-ai@latest`,
    },
    dockerfileTemplate: OPENCODE_DOCKERFILE,
    envVars: ["OPENCODE_API_KEY"],
    envExample: `# OpenCode API key
OPENCODE_API_KEY=`,
  },
];

export const listAgentRuntimes = (): AgentRuntimeEntry[] =>
  AGENT_RUNTIME_REGISTRY;

export const getAgentRuntime = (name: string): AgentRuntimeEntry | undefined =>
  AGENT_RUNTIME_REGISTRY.find((runtime) => runtime.name === name);

const DOCKERFILE_SECTION_SEPARATOR = "\n\n";
const MULTI_RUNTIME_USER_MARKER = "USER ${AGENT_UID}:${AGENT_GID}";
const MULTI_RUNTIME_FOOTER_MARKER = "WORKDIR /home/agent";
const MULTI_RUNTIME_USER_BLOCK = `${MULTI_RUNTIME_USER_MARKER}
ENV HOME="/home/agent"`;

const isDockerfileInstallSection = (
  install: string | undefined,
): install is string => install !== undefined && install.length > 0;

const hasDockerfileContent = (part: string): boolean => part.trim().length > 0;

const renderInstalledRuntimesDockerfile = (
  runtimes: readonly AgentRuntimeEntry[],
): string => {
  if (runtimes.length === 1) {
    return runtimes[0]!.dockerfileTemplate;
  }

  const userMarkerIndex = CLAUDE_CODE_DOCKERFILE.indexOf(
    MULTI_RUNTIME_USER_MARKER,
  );
  const footerMarkerIndex = CLAUDE_CODE_DOCKERFILE.indexOf(
    MULTI_RUNTIME_FOOTER_MARKER,
  );
  const base = CLAUDE_CODE_DOCKERFILE.slice(0, userMarkerIndex).trimEnd();
  const footer = CLAUDE_CODE_DOCKERFILE.slice(footerMarkerIndex).trimStart();
  const rootInstalls = runtimes
    .map((runtime) => runtime.dockerfileInstall.root)
    .filter(isDockerfileInstallSection);
  const userInstalls = runtimes
    .map((runtime) => runtime.dockerfileInstall.user)
    .filter(isDockerfileInstallSection);
  const pathEntries = [
    ...new Set(
      runtimes.flatMap(
        (runtime) => runtime.dockerfileInstall.pathEntries ?? [],
      ),
    ),
  ];
  const pathBlock =
    pathEntries.length > 0
      ? `# Add agent CLIs to PATH
ENV PATH="${pathEntries.join(":")}:$PATH"`
      : "";

  return [
    base,
    rootInstalls.join(DOCKERFILE_SECTION_SEPARATOR),
    MULTI_RUNTIME_USER_BLOCK,
    userInstalls.join(DOCKERFILE_SECTION_SEPARATOR),
    pathBlock,
    footer,
  ]
    .filter(hasDockerfileContent)
    .join(DOCKERFILE_SECTION_SEPARATOR);
};

const resolveInstalledRuntimes = (
  agent: AgentEntry,
  installedRuntimes: readonly AgentRuntimeEntry[] | undefined,
): Effect.Effect<readonly AgentRuntimeEntry[], Error, never> =>
  Effect.gen(function* () {
    if (installedRuntimes !== undefined) {
      if (installedRuntimes.length === 0) {
        yield* Effect.fail(
          new Error("At least one installed agent runtime is required."),
        );
      }
      return installedRuntimes;
    }

    const defaultRuntime = getAgentRuntime(agent.name);
    if (defaultRuntime) {
      return [defaultRuntime];
    }

    return yield* Effect.fail(
      new Error(`No agent runtime found for default agent "${agent.name}".`),
    );
  });

const renderEnvExample = (blocks: readonly EnvExampleBlock[]): string => {
  const seenEnvVars = new Set<string>();
  const parts: string[] = [];

  for (const block of blocks) {
    if (!block.content) continue;

    const hasNewEnvVar = block.envVars.some(
      (envVar) => !seenEnvVars.has(envVar),
    );
    if (!hasNewEnvVar) continue;

    parts.push(block.content);
    for (const envVar of block.envVars) {
      seenEnvVars.add(envVar);
    }
  }

  return parts.join("\n") + "\n";
};

const dedupeAuthMounts = (
  mounts: readonly AuthMountEntry[],
): AuthMountEntry[] => {
  const seen = new Set<string>();
  const deduped: AuthMountEntry[] = [];

  for (const mount of mounts) {
    const key = `${mount.hostPath}\0${mount.sandboxPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(mount);
  }

  return deduped;
};

const renderAuthMount = (mount: AuthMountEntry): string => {
  const fields = [
    `hostPath: ${JSON.stringify(mount.hostPath)}`,
    `sandboxPath: ${JSON.stringify(mount.sandboxPath)}`,
  ];
  if (mount.readonly) {
    fields.push("readonly: true");
  }
  return `    { ${fields.join(", ")} },`;
};

const EMPTY_AUTH_MOUNTS_PROPERTY = "  mounts: [],";

const renderAuthMountsProperty = (
  mounts: readonly AuthMountEntry[],
): string => {
  if (mounts.length === 0) {
    return EMPTY_AUTH_MOUNTS_PROPERTY;
  }

  return `  mounts: [
${mounts.map(renderAuthMount).join("\n")}
  ],`;
};

// ---------------------------------------------------------------------------
// Backlog manager registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface BacklogManagerEntry {
  readonly name: string;
  readonly label: string;
  readonly templateArgs: {
    readonly LIST_TASKS_COMMAND: string;
    readonly VIEW_TASK_COMMAND: string;
    readonly CLOSE_TASK_COMMAND: string;
    readonly BACKLOG_MANAGER_TOOLS: string;
  };
  /** Env vars represented by envExample, used to deduplicate shared auth hints. */
  readonly envVars: readonly string[];
  /** Lines to append to `.env.example` for this backlog manager, or empty string if none needed. */
  readonly envExample: string;
  /** Host auth/config directories to mount for this backlog manager. */
  readonly authMounts?: readonly AuthMountEntry[];
}

const GITHUB_CLI_TOOLS = `# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*`;

const BEADS_TOOLS = `# Install system dependencies for Beads
RUN apt-get update && apt-get install -y \\
  dpkg-dev \\
  libicu72 \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH_DIR=$(dpkg-architecture -qDEB_HOST_MULTIARCH) \\
  && for lib in /usr/lib/$ARCH_DIR/libicu*.so.72; do \\
       ln -s "$lib" "\${lib%.72}.74"; \\
     done

RUN curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

RUN corepack enable`;

const BACKLOG_MANAGER_REGISTRY: BacklogManagerEntry[] = [
  {
    name: "github-issues",
    label: "GitHub Issues",
    templateArgs: {
      LIST_TASKS_COMMAND: `gh issue list --state open -l Sandcastle --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,
      VIEW_TASK_COMMAND: "gh issue view <ID>",
      CLOSE_TASK_COMMAND: `gh issue close <ID> --comment "Completed by Sandcastle"`,
      BACKLOG_MANAGER_TOOLS: GITHUB_CLI_TOOLS,
    },
    envVars: ["GH_TOKEN"],
    envExample: `# GitHub personal access token
GH_TOKEN=`,
    authMounts: [
      {
        hostPath: ".sandcastle/auth/gh",
        sandboxPath: "/home/agent/.config/gh",
      },
    ],
  },
  {
    name: "beads",
    label: "Beads",
    templateArgs: {
      LIST_TASKS_COMMAND: "bd ready --json",
      VIEW_TASK_COMMAND: "bd show <ID>",
      CLOSE_TASK_COMMAND: `bd close <ID> "Completed by Sandcastle"`,
      BACKLOG_MANAGER_TOOLS: BEADS_TOOLS,
    },
    envVars: [],
    envExample: "",
  },
];

export const listBacklogManagers = (): BacklogManagerEntry[] =>
  BACKLOG_MANAGER_REGISTRY;

export const getBacklogManager = (
  name: string,
): BacklogManagerEntry | undefined =>
  BACKLOG_MANAGER_REGISTRY.find((b) => b.name === name);

export const getAgent = (name: string): AgentEntry | undefined =>
  AGENT_REGISTRY.find((a) => a.name === name);

// ---------------------------------------------------------------------------
// Sandbox provider registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface SandboxProviderEntry {
  readonly name: string;
  readonly label: string;
  /** Filename written to .sandcastle/ (e.g. "Dockerfile" or "Containerfile") */
  readonly containerfileName: string;
  /** CLI namespace for build/remove commands (e.g. "docker" or "podman") */
  readonly cliNamespace: string;
}

const SANDBOX_PROVIDER_REGISTRY: SandboxProviderEntry[] = [
  {
    name: "docker",
    label: "Docker",
    containerfileName: "Dockerfile",
    cliNamespace: "docker",
  },
  {
    name: "podman",
    label: "Podman",
    containerfileName: "Containerfile",
    cliNamespace: "podman",
  },
];

export const listSandboxProviders = (): SandboxProviderEntry[] =>
  SANDBOX_PROVIDER_REGISTRY;

export const getSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

export function getNextStepsLines(
  template: string,
  mainFilename: string,
  options?: { presetAgentIds?: readonly string[] },
): string[] {
  const presetHintText =
    options?.presetAgentIds && options.presetAgentIds.length > 0
      ? "Preset agent roles are in .sandcastle/agents/ with bundled skills under .sandcastle/skills/. See .sandcastle/agent-profiles.json for recommended provider/model; compose prompts from main.mts using run() as needed."
      : undefined;

  if (template === "blank") {
    let step = 1;
    const lines: string[] = [
      "Next steps:",
      `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      "   If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191",
      `${step++}. Read and customize .sandcastle/prompt.md to describe what you want the agent to do`,
      `${step++}. Customize .sandcastle/${mainFilename} — it uses the JS API (\`run()\`) to control how the agent runs`,
      `${step++}. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
    ];
    if (presetHintText) {
      lines.push(`${step++}. ${presetHintText}`);
    }
    lines.push(`${step++}. Run \`npm run sandcastle\` to start the agent`);
    return lines;
  } else {
    const hasReviewer = template.includes("review");
    let step = 1;
    const lines: string[] = [
      "Next steps:",
      `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      "   If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191",
      `${step++}. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      `${step++}. Templates use \`copyToWorktree: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup — the \`npm install\` in the onSandboxReady hook is a safety net for platform-specific binaries. Adjust both if you use a different package manager`,
      `${step++}. Read and customize the prompt files in .sandcastle/ — they shape what the agent does`,
    ];
    if (hasReviewer) {
      lines.push(
        `${step++}. Customize .sandcastle/CODING_STANDARDS.md with your project's standards — the reviewer agent loads it during review`,
      );
    }
    if (presetHintText) {
      lines.push(`${step++}. ${presetHintText}`);
    }
    lines.push(`${step++}. Run \`npm run sandcastle\` to start the agent`);
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Scaffolding helpers
// ---------------------------------------------------------------------------

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}

const getTemplateDir = (
  templateName: string,
): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const template = TEMPLATES.find((t) => t.name === templateName);
    if (!template) {
      const names = TEMPLATES.map((t) => t.name).join(", ");
      yield* Effect.fail(
        new Error(`Unknown template: "${templateName}". Available: ${names}`),
      );
    }
    return join(getTemplatesDir(), templateName);
  });

const COMPILED_FILE_EXTENSIONS = [
  ".js",
  ".js.map",
  ".d.ts",
  ".d.ts.map",
  ".mjs",
  ".mjs.map",
  ".d.mts",
  ".d.mts.map",
];

const copyTemplateFiles = (
  templateDir: string,
  destDir: string,
  mainFilename: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(templateDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* Effect.all(
      files
        .filter(
          (f) =>
            f !== "template.json" &&
            f !== ".env.example" &&
            !COMPILED_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)),
        )
        .map((f) => {
          const destName = f === "main.mts" ? mainFilename : f;
          return fs
            .copyFile(join(templateDir, f), join(destDir, destName))
            .pipe(Effect.mapError((e) => new Error(e.message)));
        }),
      { concurrency: "unbounded" },
    );
  });

const copyPresetAgentsIntoConfig = (
  configDir: string,
  presetAgentIds: readonly string[],
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (presetAgentIds.length === 0) {
      return;
    }
    validatePresetRegistries();
    const bundlesRoot = getPresetBundlesRoot();
    const fs = yield* FileSystem.FileSystem;

    const agents: PresetAgentDefinition[] = [];
    for (const id of presetAgentIds) {
      const def = getPresetAgentDefinition(id);
      if (!def) {
        yield* Effect.fail(
          new Error(
            `Unknown preset agent: "${id}". Available: ${PRESET_AGENT_DEFINITIONS.map((a) => a.id).join(", ")}`,
          ),
        );
      }
      agents.push(def!);
    }

    const skillIdSet = new Set<string>();
    for (const a of agents) {
      for (const sid of a.skillIds) {
        skillIdSet.add(sid);
      }
    }
    const skillIds = [...skillIdSet].sort((a, b) => a.localeCompare(b));

    yield* fs
      .makeDirectory(join(configDir, "agents"), { recursive: true })
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* fs
      .makeDirectory(join(configDir, "skills"), { recursive: true })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    for (const skillId of skillIds) {
      const src = join(bundlesRoot, "skills", skillId);
      const dest = join(configDir, "skills", skillId);
      yield* Effect.tryPromise({
        try: () => cp(src, dest, { recursive: true }),
        catch: (e) =>
          new Error(
            `Failed to copy skill "${skillId}": ${e instanceof Error ? e.message : String(e)}`,
          ),
      });
    }

    for (const agent of agents) {
      const from = join(bundlesRoot, "agents", agent.promptFile);
      const to = join(configDir, "agents", `${agent.id}.md`);
      yield* fs
        .copyFile(from, to)
        .pipe(Effect.mapError((e) => new Error(e.message)));
    }

    const profiles: Record<
      string,
      {
        promptRelativePath: string;
        recommendedAgentName: string;
        recommendedModel: string;
        recommendedEffort?: string;
        skillIds: string[];
      }
    > = {};
    for (const agent of agents) {
      profiles[agent.id] = {
        promptRelativePath: `agents/${agent.id}.md`,
        recommendedAgentName: agent.recommendedAgentName,
        recommendedModel: agent.recommendedModel,
        ...(agent.recommendedEffort
          ? { recommendedEffort: agent.recommendedEffort }
          : {}),
        skillIds: [...agent.skillIds],
      };
    }

    const manifest = { version: 1 as const, profiles };
    yield* fs
      .writeFileString(
        join(configDir, "agent-profiles.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      )
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

/**
 * Rewrite generated main file values that depend on init selections.
 *
 * Templates use `claudeCode` and an empty `mounts` array as placeholders. When
 * init selects a different agent, model, or auth mount set, this function
 * rewrites those placeholders in one pass.
 */
const rewriteMainFile = (
  configDir: string,
  agent: AgentEntry,
  model: string,
  mainFilename: string,
  authMounts: readonly AuthMountEntry[],
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, mainFilename);

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (!exists) return;

    let content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    // Templates use main.mts as the canonical filename in comments.
    // When the target is main.ts, rewrite those references.
    if (mainFilename === "main.ts") {
      content = content.replace(/main\.mts/g, "main.ts");
    }

    // Replace factory function name in imports (e.g. claudeCode → pi)
    // and all factory calls with the correct model.
    // Templates always use claudeCode as the placeholder factory.
    content = content.replace(/\bclaudeCode\b/g, agent.factoryImport);
    // Replace model strings in factory calls: factoryImport("any-model")
    const factoryCallRe = new RegExp(
      `${agent.factoryImport}\\(["']([^"']+)["']\\)`,
      "g",
    );
    content = content.replace(
      factoryCallRe,
      `${agent.factoryImport}("${model}")`,
    );

    content = content.replace(
      EMPTY_AUTH_MOUNTS_PROPERTY,
      renderAuthMountsProperty(authMounts),
    );

    yield* fs
      .writeFileString(mainTsPath, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

const PRESET_COPY_TO_WORKTREE_PATHS = [
  ".sandcastle/agents",
  ".sandcastle/skills",
] as const;

const parseQuotedArrayItems = (raw: string): string[] =>
  [...raw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!.trim());

const mergeCopyToWorktreeItems = (existingRaw: string): string => {
  const items = parseQuotedArrayItems(existingRaw);
  for (const p of PRESET_COPY_TO_WORKTREE_PATHS) {
    if (!items.includes(p)) items.push(p);
  }
  return items.map((p) => `"${p}"`).join(", ");
};

const rewriteMainCopyToWorktreeForPresets = (
  configDir: string,
  mainFilename: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, mainFilename);

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (!exists) return;

    let content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    // Handle both template styles:
    // - copyToWorktree: ["node_modules"]
    // - const copyToWorktree = ["node_modules"];
    content = content.replace(
      /copyToWorktree:\s*\[([^\]]*)\]/g,
      (_m, items: string) =>
        `copyToWorktree: [${mergeCopyToWorktreeItems(items)}]`,
    );
    content = content.replace(
      /const copyToWorktree = \[([^\]]*)\];/g,
      (_m, items: string) =>
        `const copyToWorktree = [${mergeCopyToWorktreeItems(items)}];`,
    );

    yield* fs
      .writeFileString(mainTsPath, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

/**
 * When the user opted out of the Sandcastle label, strip ` --label Sandcastle`
 * and ` -l Sandcastle`
 * from all `.md` files in the scaffolded config directory so that `gh issue list`
 * commands work without a label filter.
 */
const rewritePromptFiles = (
  configDir: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    yield* Effect.all(
      mdFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          const content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const updated = content
            .replace(/ --label Sandcastle/g, "")
            .replace(/ -l Sandcastle/g, "");
          if (updated !== content) {
            yield* fs
              .writeFileString(filePath, updated)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

/** Text file extensions eligible for `{{KEY}}` template argument substitution. */
const TEXT_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".env",
  ".example",
  // Dockerfile / Containerfile have no extension — handled by name check below
]);

const isTextFile = (filename: string): boolean => {
  if (
    filename === "Dockerfile" ||
    filename === "Containerfile" ||
    filename === ".gitignore"
  )
    return true;
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return TEXT_FILE_EXTENSIONS.has(filename.slice(dotIdx));
};

/**
 * Replace `{{KEY}}` template arguments in all text files in the scaffolded
 * config directory.
 */
const substituteTemplateArgs = (
  configDir: string,
  templateArgs: Record<string, string>,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const textFiles = files.filter(isTextFile);
    yield* Effect.all(
      textFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          let content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const original = content;
          for (const [key, value] of Object.entries(templateArgs)) {
            content = content.replace(
              new RegExp(`\\{\\{${key}\\}\\}`, "g"),
              value,
            );
          }
          if (content !== original) {
            yield* fs
              .writeFileString(filePath, content)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  agent: AgentEntry;
  model: string;
  installedRuntimes?: readonly AgentRuntimeEntry[];
  templateName?: string;
  createLabel?: boolean;
  backlogManager?: BacklogManagerEntry;
  sandboxProvider?: SandboxProviderEntry;
  /** Optional preset agent role ids (see `presetAgents.ts`). */
  presetAgentIds?: readonly string[];
}

export interface ScaffoldResult {
  mainFilename: string;
  presetAgentIds?: readonly string[];
}

/**
 * Detect whether the project's package.json has `"type": "module"`.
 * If so, we can use plain `.ts`; otherwise we use `.mts` to ensure ESM.
 */
const detectMainFilename = (
  repoDir: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return "main.mts";
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      return pkg["type"] === "module" ? "main.ts" : "main.mts";
    } catch {
      return "main.mts";
    }
  });

export const scaffold = (
  repoDir: string,
  options: ScaffoldOptions,
): Effect.Effect<ScaffoldResult, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      agent,
      model,
      installedRuntimes,
      templateName = "blank",
      createLabel = true,
      backlogManager = BACKLOG_MANAGER_REGISTRY[0]!, // default: github-issues
      sandboxProvider = SANDBOX_PROVIDER_REGISTRY[0]!, // default: docker
      presetAgentIds = [],
    } = options;
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");

    const exists = yield* fs
      .exists(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (exists) {
      yield* Effect.fail(
        new Error(
          ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
        ),
      );
    }

    const mainFilename = yield* detectMainFilename(repoDir);
    const selectedRuntimes = yield* resolveInstalledRuntimes(
      agent,
      installedRuntimes,
    );
    const dockerfileTemplate =
      renderInstalledRuntimesDockerfile(selectedRuntimes);
    const selectedAuthMounts = dedupeAuthMounts([
      ...selectedRuntimes.flatMap((runtime) => runtime.authMounts ?? []),
      ...(backlogManager.authMounts ?? []),
    ]);

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const templateDir = yield* getTemplateDir(templateName);

    // Build .env.example from installed runtime + backlog manager env blocks
    const envExampleContent = renderEnvExample([
      ...selectedRuntimes.map((runtime) => ({
        envVars: runtime.envVars,
        content: runtime.envExample,
      })),
      {
        envVars: backlogManager.envVars,
        content: backlogManager.envExample,
      },
    ]);

    yield* Effect.all(
      [
        fs
          .writeFileString(
            join(configDir, sandboxProvider.containerfileName),
            dockerfileTemplate,
          )
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".gitignore"), GITIGNORE)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".env.example"), envExampleContent)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".env"), envExampleContent)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        copyTemplateFiles(templateDir, configDir, mainFilename),
      ],
      { concurrency: "unbounded" },
    );

    yield* rewriteMainFile(
      configDir,
      agent,
      model,
      mainFilename,
      selectedAuthMounts,
    );

    // Replace backlog manager template arguments in all text files (must run before label stripping)
    yield* substituteTemplateArgs(configDir, backlogManager.templateArgs);

    // Strip --label Sandcastle from prompt files when the user declined label creation
    if (!createLabel) {
      yield* rewritePromptFiles(configDir);
    }

    if (presetAgentIds.length > 0) {
      yield* copyPresetAgentsIntoConfig(configDir, presetAgentIds);
      yield* rewriteMainCopyToWorktreeForPresets(configDir, mainFilename);
    }

    return {
      mainFilename,
      ...(presetAgentIds.length > 0
        ? { presetAgentIds: [...presetAgentIds] }
        : {}),
    };
  });
