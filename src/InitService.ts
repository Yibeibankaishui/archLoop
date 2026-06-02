import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { cp } from "node:fs/promises";
import { execSync } from "node:child_process";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  buildCapabilityManifest,
  validateCapabilityRegistries,
  type CapabilityManifest,
  type ResolvedCapabilityInit,
  validateCapabilityTemplateSelection,
} from "./capabilityPacks.js";
import {
  appendMiniprogramVerificationToPrompt,
  listTemplatePromptFiles,
  shouldAssembleMiniprogramPrompts,
} from "./capabilityPromptAssembly.js";
import {
  getPresetAgentDefinition,
  getPresetBundlesRoot,
  PRESET_AGENT_DEFINITIONS,
  validatePresetRegistries,
  type PresetAgentDefinition,
} from "./presetAgents.js";
import { renderBootstrapScript } from "./bootstrap.js";
import {
  DEFAULT_PROJECT_PROFILE,
  type ProjectProfileEntry,
} from "./projectProfiles.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { SCAFFOLD_TEMPLATES } from "./initTemplates.js";

export {
  DEFAULT_PROJECT_PROFILE,
  DEFAULT_PROJECT_PROFILE_NAME,
  formatProjectProfileNames,
  getProjectProfile,
  listProjectProfiles,
  type ProjectProfileEntry,
} from "./projectProfiles.js";

const GITIGNORE = `.env
auth/
logs/
worktrees/
`;

export type { TemplateMetadata } from "./initTemplates.js";
export { listTemplates } from "./initTemplates.js";

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

export interface AuthRequirement {
  readonly id: string;
  readonly label: string;
  readonly envVars: readonly string[];
  readonly authMounts: readonly AuthMountEntry[];
  readonly githubLoginSupported?: boolean;
}

export interface AuthSetupSummary {
  readonly lines: readonly string[];
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

{{PROJECT_PROFILE_TOOLS}}

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

{{PROJECT_PROFILE_TOOLS}}

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

const CODEX_DOCKERFILE_INSTALL = `# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex @openai/codex-linux-x64 \\
  && codex --version`;

const CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{BACKLOG_MANAGER_TOOLS}}

{{PROJECT_PROFILE_TOOLS}}

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

${CODEX_DOCKERFILE_INSTALL}

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

{{PROJECT_PROFILE_TOOLS}}

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
RUN curl https://cursor.com/install -fsS | bash \\
  && test -x "$HOME/.local/bin/agent"

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

{{PROJECT_PROFILE_TOOLS}}

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
      root: CODEX_DOCKERFILE_INSTALL,
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
RUN curl https://cursor.com/install -fsS | bash \\
  && test -x "$HOME/.local/bin/agent"`,
      pathEntries: ["/home/agent/.local/bin"],
    },
    dockerfileTemplate: CURSOR_DOCKERFILE,
    envVars: ["CURSOR_API_KEY"],
    envExample: `# Cursor API key
CURSOR_API_KEY=`,
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

const prepareAuthMountHostDirectories = (
  fs: FileSystem.FileSystem,
  repoDir: string,
  mounts: readonly AuthMountEntry[],
): Effect.Effect<void, Error> => {
  const directories = new Set<string>();
  for (const mount of mounts) {
    directories.add(
      isAbsolute(mount.hostPath)
        ? mount.hostPath
        : join(repoDir, mount.hostPath),
    );
  }

  return Effect.all(
    [...directories].map((directory) =>
      fs
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError((e) => new Error(e.message))),
    ),
    { concurrency: "unbounded" },
  ).pipe(Effect.asVoid);
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
const DOCKER_IMPORT_LINE =
  'import { docker } from "@ai-hero/sandcastle/sandboxes/docker";';
const NO_SANDBOX_IMPORT_LINE =
  'import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";';
const DOCKER_PROVIDER_SNIPPET = `const sandboxProvider = docker({
  mounts: [],
});`;
const NO_SANDBOX_PROVIDER_SNIPPET = "const sandboxProvider = noSandbox();";

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

export const collectAuthRequirements = ({
  installedRuntimes,
  backlogManager,
}: {
  installedRuntimes: readonly AgentRuntimeEntry[];
  backlogManager: BacklogManagerEntry;
}): AuthRequirement[] => {
  const runtimeRequirements: AuthRequirement[] = installedRuntimes.map(
    (runtime) => ({
      id: runtime.name,
      label: runtime.label,
      envVars: runtime.envVars,
      authMounts: runtime.authMounts ?? [],
    }),
  );

  const backlogRequirement: AuthRequirement = {
    id: backlogManager.name,
    label: backlogManager.label,
    envVars: backlogManager.envVars,
    authMounts: backlogManager.authMounts ?? [],
    ...(backlogManager.name === "github-issues"
      ? { githubLoginSupported: true }
      : {}),
  };

  return [...runtimeRequirements, backlogRequirement];
};

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
  {
    name: "no-sandbox",
    label: "No Sandbox",
    // Keep scaffold output stable; no-sandbox init still writes Dockerfile
    // so users can opt into containerized runs later without re-initializing.
    containerfileName: "Dockerfile",
    cliNamespace: "docker",
  },
];

export const listSandboxProviders = (): SandboxProviderEntry[] =>
  SANDBOX_PROVIDER_REGISTRY;

export const getSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);

const INIT_SANDBOX_PROVIDER_REGISTRY: SandboxProviderEntry[] =
  SANDBOX_PROVIDER_REGISTRY.filter(
    (p) => p.name === "docker" || p.name === "no-sandbox",
  );

export const listInitSandboxProviders = (): SandboxProviderEntry[] =>
  INIT_SANDBOX_PROVIDER_REGISTRY;

export const getInitSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  INIT_SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

const PRESET_AGENT_NEXT_STEP =
  "Preset agent roles are in .sandcastle/agents/ with bundled skills under .sandcastle/skills/. See .sandcastle/agent-profiles.json for recommended provider/model; compose prompts from main.mts using run() as needed. Recommendations may require matching installed runtimes.";

/** Default sandbox bootstrap hook timeout (5 minutes) for dependency installs. */
export const BOOTSTRAP_HOOK_TIMEOUT_MS = 300_000;

/** Numeric literal in non-blank template `main.mts` files; keep in sync with `BOOTSTRAP_HOOK_TIMEOUT_MS`. */
const BOOTSTRAP_HOOK_TIMEOUT_MS_LITERAL = "300_000";

if (
  Number(BOOTSTRAP_HOOK_TIMEOUT_MS_LITERAL.replaceAll("_", "")) !==
  BOOTSTRAP_HOOK_TIMEOUT_MS
) {
  throw new Error(
    "BOOTSTRAP_HOOK_TIMEOUT_MS_LITERAL must match BOOTSTRAP_HOOK_TIMEOUT_MS",
  );
}

const BOOTSTRAP_SCAFFOLD_NOTE =
  "`.sandcastle/bootstrap.sh` was generated from your Project profile during init (user-editable scaffold; init does not run or validate it)";

const blankBootstrapNextStep = `${BOOTSTRAP_SCAFFOLD_NOTE}. The blank template does not run bootstrap unless you wire \`sandbox.onSandboxReady\` yourself`;

const nonBlankBootstrapNextStep = `${BOOTSTRAP_SCAFFOLD_NOTE}. Non-blank templates run it from \`sandbox.onSandboxReady\` with a 5-minute default hook timeout (${BOOTSTRAP_HOOK_TIMEOUT_MS_LITERAL} ms) after the worktree is mounted and before the agent starts — not during image build. Customize the script for your stack; raise \`timeoutMs\` in \`main.mts\` if installs need longer`;

export const runMainCommand = (mainFilename: string): string =>
  `tsx .sandcastle/${mainFilename}`;

const sandcastleNpmScript = (mainFilename: string): string =>
  `tsx .sandcastle/${mainFilename}`;

const require = createRequire(import.meta.url);
const SANDCASTLE_PACKAGE_VERSION = (
  require("../package.json") as { version: string }
).version;

export const SANDCASTLE_NPM_PACKAGE = "@ai-hero/sandcastle";
export const TSX_NPM_PACKAGE = "tsx";
const TSX_VERSION_RANGE = "^4.21.0";

export type ProjectPackageSetup =
  | "created"
  | "updated"
  | "unchanged"
  | "invalid-skipped";

export interface EnsureProjectPackageOptions {
  mainFilename: string;
  sandcastleVersion?: string;
}

export interface EnsureProjectPackageResult {
  setup: ProjectPackageSetup;
  needsInstall: boolean;
}

const defaultPackageName = (repoDir: string): string => {
  const raw = basename(repoDir)
    .replace(/[^a-z0-9-_.]/gi, "-")
    .toLowerCase();
  return raw.length > 0 ? raw : "sandcastle-project";
};

const sandcastleDevDependencyRange = (version: string): string => `^${version}`;

const copyPackageJsonRecord = (value: unknown): Record<string, string> =>
  typeof value === "object" && value !== null
    ? { ...(value as Record<string, string>) }
    : {};

type ReadPackageJsonResult =
  | { readonly tag: "missing" }
  | { readonly tag: "invalid" }
  | { readonly tag: "ok"; readonly pkg: Record<string, unknown> };

const readPackageJson = (
  fs: FileSystem.FileSystem,
  pkgPath: string,
): Effect.Effect<ReadPackageJsonResult, never, never> =>
  Effect.gen(function* () {
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return { tag: "missing" };
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      return {
        tag: "ok",
        pkg: JSON.parse(content) as Record<string, unknown>,
      };
    } catch {
      return { tag: "invalid" };
    }
  });

const writePackageJson = (
  fs: FileSystem.FileSystem,
  pkgPath: string,
  pkg: Record<string, unknown>,
): Effect.Effect<void, Error, never> =>
  fs
    .writeFileString(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    .pipe(Effect.mapError((e) => new Error(e.message)));

export const ensureProjectPackage = (
  repoDir: string,
  options: EnsureProjectPackageOptions,
): Effect.Effect<EnsureProjectPackageResult, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sandcastleVersion =
      options.sandcastleVersion ?? SANDCASTLE_PACKAGE_VERSION;
    const pkgPath = join(repoDir, "package.json");
    const script = sandcastleNpmScript(options.mainFilename);
    const sandcastleRange = sandcastleDevDependencyRange(sandcastleVersion);
    const parsed = yield* readPackageJson(fs, pkgPath);

    if (parsed.tag === "invalid") {
      return { setup: "invalid-skipped", needsInstall: false };
    }

    if (parsed.tag === "missing") {
      const pkg: Record<string, unknown> = {
        name: defaultPackageName(repoDir),
        private: true,
        scripts: { sandcastle: script },
        devDependencies: {
          [SANDCASTLE_NPM_PACKAGE]: sandcastleRange,
          [TSX_NPM_PACKAGE]: TSX_VERSION_RANGE,
        },
      };
      yield* writePackageJson(fs, pkgPath, pkg);
      return { setup: "created", needsInstall: true };
    }

    const pkg = parsed.pkg;
    let changed = false;
    const scripts = copyPackageJsonRecord(pkg.scripts);
    if (scripts.sandcastle === undefined) {
      scripts.sandcastle = script;
      changed = true;
    }

    const devDependencies = copyPackageJsonRecord(pkg.devDependencies);
    if (devDependencies[SANDCASTLE_NPM_PACKAGE] === undefined) {
      devDependencies[SANDCASTLE_NPM_PACKAGE] = sandcastleRange;
      changed = true;
    }
    if (devDependencies[TSX_NPM_PACKAGE] === undefined) {
      devDependencies[TSX_NPM_PACKAGE] = TSX_VERSION_RANGE;
      changed = true;
    }

    if (!changed) {
      return { setup: "unchanged", needsInstall: false };
    }

    pkg.scripts = scripts;
    pkg.devDependencies = devDependencies;
    yield* writePackageJson(fs, pkgPath, pkg);
    return { setup: "updated", needsInstall: true };
  });

export const installProjectDependencies = (
  repoDir: string,
): Effect.Effect<boolean, never, never> =>
  Effect.sync(() => {
    try {
      execSync("npm install --ignore-scripts", {
        cwd: repoDir,
        stdio: "inherit",
        env: process.env,
      });
      return true;
    } catch {
      return false;
    }
  });

const packageScriptNextStep = (
  packageSetup: ProjectPackageSetup | undefined,
  mainFilename: string,
): string => {
  if (packageSetup === "created" || packageSetup === "updated") {
    return `package.json was configured with ${SANDCASTLE_NPM_PACKAGE}, ${TSX_NPM_PACKAGE}, and a "sandcastle" script during init`;
  }
  if (packageSetup === "invalid-skipped") {
    return `Fix package.json (invalid JSON), then run: npm init -y && npm install --save-dev ${SANDCASTLE_NPM_PACKAGE} ${TSX_NPM_PACKAGE} && add "sandcastle": "${runMainCommand(mainFilename)}" to scripts`;
  }
  return `Add "sandcastle": "${runMainCommand(mainFilename)}" to your package.json scripts`;
};

const DEPENDENCY_INSTALL_NEXT_STEP =
  "Run `npm install` in the project root (init could not install dependencies automatically)";

const appendOptionalNumberedStep = (
  lines: string[],
  step: number,
  message: string | undefined,
): number => {
  if (message === undefined) return step;
  lines.push(`${step}. ${message}`);
  return step + 1;
};

export function getNextStepsLines(
  template: string,
  mainFilename: string,
  options?: {
    presetAgentIds?: readonly string[];
    authSetupSummary?: AuthSetupSummary;
    hostRequirementSummary?: AuthSetupSummary;
    packageSetup?: ProjectPackageSetup;
    dependencyInstallFailed?: boolean;
    capabilityBlankTemplateWarning?: string;
  },
): string[] {
  const presetHintText =
    options?.presetAgentIds && options.presetAgentIds.length > 0
      ? PRESET_AGENT_NEXT_STEP
      : undefined;
  const authSetupLines = options?.authSetupSummary?.lines ?? [];
  const hostRequirementLines = options?.hostRequirementSummary?.lines ?? [];
  const packageSetup = options?.packageSetup;
  const dependencyInstallFailed = options?.dependencyInstallFailed === true;
  const packageScriptStep = packageScriptNextStep(packageSetup, mainFilename);
  const dependencyInstallStep = dependencyInstallFailed
    ? DEPENDENCY_INSTALL_NEXT_STEP
    : undefined;
  const capabilityBlankWarning = options?.capabilityBlankTemplateWarning;

  if (template === "blank") {
    let step = 1;
    const lines: string[] = [
      "Next steps:",
      `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
      "   If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191",
      `${step++}. Read and customize .sandcastle/prompt.md to describe what you want the agent to do`,
      `${step++}. Customize .sandcastle/${mainFilename} — it uses the JS API (\`run()\`) to control how the agent runs and can mix installed agent providers after init`,
      `${step++}. ${packageScriptStep}`,
    ];
    lines.push(`${step++}. ${blankBootstrapNextStep}`);
    if (capabilityBlankWarning) {
      lines.push(`${step++}. ${capabilityBlankWarning}`);
    }
    if (presetHintText) {
      lines.push(`${step++}. ${presetHintText}`);
    }
    for (const line of authSetupLines) {
      lines.push(`${step++}. ${line}`);
    }
    for (const line of hostRequirementLines) {
      lines.push(`${step++}. ${line}`);
    }
    step = appendOptionalNumberedStep(lines, step, dependencyInstallStep);
    lines.push(`${step++}. Run \`npm run sandcastle\` to start the agent`);
    return lines;
  }

  const hasReviewer = template.includes("review");
  let step = 1;
  const lines: string[] = [
    "Next steps:",
    `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
    "   If you want to use your Claude subscription instead of an API key, see https://github.com/mattpocock/sandcastle/issues/191",
    `${step++}. ${packageScriptStep}`,
    `${step++}. Edit .sandcastle/${mainFilename} to mix installed agent providers after init; the selected default agent only seeds the scaffolded example`,
    `${step++}. ${nonBlankBootstrapNextStep}`,
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
  for (const line of authSetupLines) {
    lines.push(`${step++}. ${line}`);
  }
  for (const line of hostRequirementLines) {
    lines.push(`${step++}. ${line}`);
  }
  step = appendOptionalNumberedStep(lines, step, dependencyInstallStep);
  lines.push(`${step++}. Run \`npm run sandcastle\` to start the agent`);
  return lines;
}

// ---------------------------------------------------------------------------
// Scaffolding helpers
// ---------------------------------------------------------------------------

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}

function resolveCapabilityBlankTemplateWarning(
  capabilityInit: ResolvedCapabilityInit | undefined,
  templateName: string,
): string | undefined {
  if (capabilityInit === undefined) {
    return undefined;
  }
  return validateCapabilityTemplateSelection(
    capabilityInit.capabilityId,
    templateName,
  ).blankTemplateWarning;
}

const getTemplateDir = (
  templateName: string,
): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const template = SCAFFOLD_TEMPLATES.find((t) => t.name === templateName);
    if (!template) {
      const names = SCAFFOLD_TEMPLATES.map((t) => t.name).join(", ");
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
  sandboxProvider: SandboxProviderEntry,
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

    if (sandboxProvider.name === "no-sandbox") {
      content = content.replace(DOCKER_IMPORT_LINE, NO_SANDBOX_IMPORT_LINE);
      content = content.replace(
        DOCKER_PROVIDER_SNIPPET,
        NO_SANDBOX_PROVIDER_SNIPPET,
      );
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
const assembleMiniprogramCapabilityPrompts = (
  configDir: string,
  templateName: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const promptFile of listTemplatePromptFiles(templateName)) {
      const filePath = join(configDir, promptFile);
      const exists = yield* fs
        .exists(filePath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        throw new Error(
          `Expected template prompt "${promptFile}" for "${templateName}" was not scaffolded.`,
        );
      }
      const content = yield* fs
        .readFileString(filePath)
        .pipe(Effect.mapError((e) => new Error(e.message)));
      const updated = appendMiniprogramVerificationToPrompt(content);
      if (updated !== content) {
        yield* fs
          .writeFileString(filePath, updated)
          .pipe(Effect.mapError((e) => new Error(e.message)));
      }
    }
  });

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
  projectProfile?: ProjectProfileEntry;
  /** Optional preset agent role ids (see `presetAgents.ts`). */
  presetAgentIds?: readonly string[];
  /** Resolved capability pack selection from `resolveCapabilityInitOptions`. */
  capabilityInit?: ResolvedCapabilityInit;
  /** Sandcastle package version for generated devDependency (defaults to this CLI's version). */
  sandcastleVersion?: string;
  /** Skip `npm install` after package.json changes (tests). */
  skipDependencyInstall?: boolean;
}

export interface ScaffoldResult {
  mainFilename: string;
  presetAgentIds?: readonly string[];
  packageSetup: ProjectPackageSetup;
  dependencyInstallFailed?: boolean;
  capabilityBlankTemplateWarning?: string;
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
    validateCapabilityRegistries();
    const {
      agent,
      model,
      installedRuntimes,
      templateName = "blank",
      createLabel = true,
      backlogManager = BACKLOG_MANAGER_REGISTRY[0]!, // default: github-issues
      sandboxProvider = SANDBOX_PROVIDER_REGISTRY[0]!, // default: docker
      projectProfile = DEFAULT_PROJECT_PROFILE,
      presetAgentIds = [],
      capabilityInit,
      skipDependencyInstall = false,
    } = options;
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");
    const capabilityBlankTemplateWarning =
      resolveCapabilityBlankTemplateWarning(capabilityInit, templateName);

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
    const authRequirements = collectAuthRequirements({
      installedRuntimes: selectedRuntimes,
      backlogManager,
    });
    const dockerfileTemplate =
      renderInstalledRuntimesDockerfile(selectedRuntimes);
    const selectedAuthMounts = dedupeAuthMounts(
      authRequirements.flatMap((requirement) => requirement.authMounts),
    );

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* prepareAuthMountHostDirectories(fs, repoDir, selectedAuthMounts);

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
        fs
          .writeFileString(
            join(configDir, "bootstrap.sh"),
            renderBootstrapScript(projectProfile.name),
          )
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
      sandboxProvider,
      selectedAuthMounts,
    );

    // Replace backlog manager and project profile template arguments in all text files (must run before label stripping)
    yield* substituteTemplateArgs(configDir, {
      ...backlogManager.templateArgs,
      PROJECT_PROFILE_TOOLS: projectProfile.containerfileTools,
    });

    // Strip --label Sandcastle from prompt files when the user declined label creation
    if (!createLabel) {
      yield* rewritePromptFiles(configDir);
    }

    if (presetAgentIds.length > 0) {
      yield* copyPresetAgentsIntoConfig(configDir, presetAgentIds);
      yield* rewriteMainCopyToWorktreeForPresets(configDir, mainFilename);
    }

    if (
      capabilityInit &&
      shouldAssembleMiniprogramPrompts(
        capabilityInit.capabilityId,
        capabilityInit.verification,
      )
    ) {
      yield* assembleMiniprogramCapabilityPrompts(configDir, templateName);
    }

    if (capabilityInit?.writeCapabilityManifest) {
      const manifest: CapabilityManifest =
        buildCapabilityManifest(capabilityInit);
      yield* fs
        .writeFileString(
          join(configDir, "capability.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        )
        .pipe(Effect.mapError((e) => new Error(e.message)));
    }

    const packageResult = yield* ensureProjectPackage(repoDir, {
      mainFilename,
      sandcastleVersion: options.sandcastleVersion,
    });
    const shouldInstallDependencies =
      packageResult.needsInstall && !skipDependencyInstall;
    const dependencyInstallFailed =
      shouldInstallDependencies &&
      !(yield* installProjectDependencies(repoDir));

    return {
      mainFilename,
      packageSetup: packageResult.setup,
      ...(dependencyInstallFailed ? { dependencyInstallFailed } : {}),
      ...(capabilityBlankTemplateWarning
        ? { capabilityBlankTemplateWarning }
        : {}),
      ...(presetAgentIds.length > 0
        ? { presetAgentIds: [...presetAgentIds] }
        : {}),
    };
  });
