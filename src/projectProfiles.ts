export interface ProjectProfileEntry {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /**
   * Dockerfile/Containerfile fragment composed after backlog manager tools.
   * Empty for profiles that do not add language-specific image layers.
   */
  readonly containerfileTools: string;
  /** Content written to `.sandcastle/bootstrap.sh` during init. */
  readonly bootstrapScript: string;
}

const bootstrapScriptPreamble = (
  summary: string,
  generationNote: string,
): string => `#!/usr/bin/env bash
set -euo pipefail

# Sandcastle repository bootstrap — ${summary}.
# ${generationNote}; runs from sandbox.onSandboxReady after the worktree is mounted.

`;

const GENERIC_BOOTSTRAP_SCRIPT =
  bootstrapScriptPreamble("customize for your stack", "Generated as a no-op") +
  "exit 0\n";

const GENERIC_PROJECT_PROFILE: ProjectProfileEntry = {
  name: "generic",
  label: "Generic",
  description:
    "Language-agnostic scaffold with a no-op bootstrap script you can customize",
  containerfileTools: "",
  bootstrapScript: GENERIC_BOOTSTRAP_SCRIPT,
};

const NODE_BOOTSTRAP_SCRIPT =
  bootstrapScriptPreamble(
    "Node.js dependencies",
    "Generated for the Node project profile",
  ) +
  `if [[ ! -f package.json ]]; then
  echo "No package.json found; skipping Node dependency installation."
  exit 0
fi

if [[ -f pnpm-lock.yaml ]]; then
  echo "Detected pnpm-lock.yaml; installing dependencies with pnpm..."
  corepack enable pnpm
  pnpm install --frozen-lockfile
elif [[ -f yarn.lock ]]; then
  echo "Detected yarn.lock; installing dependencies with yarn..."
  corepack enable yarn
  yarn install --immutable
elif [[ -f package-lock.json ]]; then
  echo "Detected package-lock.json; installing dependencies with npm ci..."
  npm ci
else
  echo "No lockfile found; installing dependencies with npm install..."
  npm install
fi
`;

export const NODE_PROJECT_PROFILE: ProjectProfileEntry = {
  name: "node",
  label: "Node",
  description:
    "Node.js projects with lockfile-aware dependency install at sandbox ready time",
  containerfileTools: "",
  bootstrapScript: NODE_BOOTSTRAP_SCRIPT,
};

const PYTHON_CONTAINERFILE_TOOLS = `# Python development tools (pip, venv) and uv
RUN apt-get update && apt-get install -y \\
  python3 \\
  python3-pip \\
  python3-venv \\
  && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh`;

const PYTHON_BOOTSTRAP_SCRIPT =
  bootstrapScriptPreamble(
    "Python projects",
    "Generated for the Python project profile. Prepares dependencies only; does not run tests or full verification",
  ) +
  `cd "\${SANDBOX_REPO_DIR:-.}"

is_poetry_project() {
  if [[ -f poetry.lock ]]; then
    return 0
  fi
  if [[ -f pyproject.toml ]] && grep -qE '^\\[tool\\.poetry\\]' pyproject.toml 2>/dev/null; then
    return 0
  fi
  return 1
}

ensure_venv() {
  local activate=".venv/bin/activate"

  if [[ -d .venv && ! -f "$activate" ]]; then
    echo "Sandcastle bootstrap: removing incomplete .venv"
    rm -rf .venv
  fi

  if [[ ! -f "$activate" ]]; then
    echo "Sandcastle bootstrap: creating .venv"
    if ! python3 -m venv .venv; then
      rm -rf .venv
      echo "Sandcastle bootstrap: failed to create venv."
      echo "Install python3-venv and/or uv on the host (no-sandbox runs bootstrap on the host), or use a Docker sandbox provider."
      exit 1
    fi
  fi

  # shellcheck source=/dev/null
  source "$activate"
}

if is_poetry_project; then
  echo "Sandcastle bootstrap: Poetry project detected."
  echo "Poetry is not installed in the default Python profile image."
  echo "Customize .sandcastle/Dockerfile (or Containerfile) and bootstrap.sh to add Poetry support."
  exit 0
fi

if [[ -f uv.lock ]]; then
  echo "Sandcastle bootstrap: syncing dependencies with uv (uv.lock)"
  uv sync --frozen
  exit 0
fi

if [[ -f pyproject.toml ]] && command -v uv >/dev/null 2>&1; then
  echo "Sandcastle bootstrap: syncing dependencies with uv (pyproject.toml)"
  uv sync
  exit 0
fi

if [[ -f requirements.txt ]]; then
  ensure_venv
  echo "Sandcastle bootstrap: installing requirements.txt with pip"
  python -m pip install -r requirements.txt
  exit 0
fi

if [[ -f pyproject.toml ]]; then
  ensure_venv
  echo "Sandcastle bootstrap: installing pyproject.toml with pip"
  python -m pip install -e .
  exit 0
fi

echo "Sandcastle bootstrap: no Python dependency manifest found; skipping dependency setup."
exit 0
`;

export const PYTHON_PROJECT_PROFILE: ProjectProfileEntry = {
  name: "python",
  label: "Python",
  description:
    "Python, pip, venv, and uv in the sandbox image with setup-only bootstrap for common dependency layouts",
  containerfileTools: PYTHON_CONTAINERFILE_TOOLS,
  bootstrapScript: PYTHON_BOOTSTRAP_SCRIPT,
};

const CPP_CONTAINERFILE_TOOLS = `# Install common C++ build tooling
RUN apt-get update && apt-get install -y \\
  build-essential \\
  cmake \\
  ninja-build \\
  && rm -rf /var/lib/apt/lists/*`;

const CPP_BOOTSTRAP_SCRIPT =
  bootstrapScriptPreamble(
    "C++ projects",
    "Generated for the C++ project profile. Setup-only: configures CMake or recognizes Makefiles; does not build by default",
  ) +
  `root="\${SANDBOX_REPO_DIR:-.}"

if [[ -f "\$root/CMakeLists.txt" ]]; then
  build_dir="\$root/build"
  echo "Configuring CMake project (configure only, no build)..."
  cmake -S "\$root" -B "\$build_dir"
elif [[ -f "\$root/Makefile" || -f "\$root/makefile" ]]; then
  echo "Makefile project detected. No default build step; customize bootstrap.sh when ready."
else
  echo "No supported C++ build signal found (CMakeLists.txt or Makefile). Customize bootstrap.sh for your project."
fi

exit 0
`;

export const CPP_PROJECT_PROFILE: ProjectProfileEntry = {
  name: "cpp",
  label: "C++",
  description:
    "C++ toolchain with setup-only bootstrap for CMake and Makefile projects",
  containerfileTools: CPP_CONTAINERFILE_TOOLS,
  bootstrapScript: CPP_BOOTSTRAP_SCRIPT,
};

export const DEFAULT_PROJECT_PROFILE = GENERIC_PROJECT_PROFILE;
export const DEFAULT_PROJECT_PROFILE_NAME = GENERIC_PROJECT_PROFILE.name;

const PROJECT_PROFILE_REGISTRY: readonly ProjectProfileEntry[] = [
  GENERIC_PROJECT_PROFILE,
  NODE_PROJECT_PROFILE,
  PYTHON_PROJECT_PROFILE,
  CPP_PROJECT_PROFILE,
];

export const listProjectProfiles = (): readonly ProjectProfileEntry[] =>
  PROJECT_PROFILE_REGISTRY;

export const formatProjectProfileNames = (): string =>
  PROJECT_PROFILE_REGISTRY.map((profile) => profile.name).join(", ");

export const getProjectProfile = (
  name: string,
): ProjectProfileEntry | undefined =>
  PROJECT_PROFILE_REGISTRY.find((profile) => profile.name === name);
