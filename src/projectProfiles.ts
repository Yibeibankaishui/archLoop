export interface ProjectProfileEntry {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /**
   * Dockerfile/Containerfile fragment composed after backlog manager tools.
   * Empty for profiles that do not add language-specific image layers.
   */
  readonly containerfileTools: string;
  /** Content written to `.archloop/bootstrap.sh` during init. */
  readonly bootstrapScript: string;
  /**
   * Init-time substitution for `{{PROJECT_PROFILE_VERIFY_GUIDANCE}}` in
   * scaffolded workflow prompts (stack-specific verification commands).
   */
  readonly promptVerifyGuidance: string;
}

const bootstrapScriptPreamble = (
  summary: string,
  generationNote: string,
): string => `#!/usr/bin/env bash
set -euo pipefail

# archLoop repository bootstrap — ${summary}.
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
  promptVerifyGuidance:
    "your project's verification commands (customize this prompt section after init to match your stack)",
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
  promptVerifyGuidance: "`npm run typecheck` and `npm run test`",
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
    echo "archLoop bootstrap: removing incomplete .venv"
    rm -rf .venv
  fi

  if [[ ! -f "$activate" ]]; then
    echo "archLoop bootstrap: creating .venv"
    if ! python3 -m venv .venv; then
      rm -rf .venv
      echo "archLoop bootstrap: failed to create venv."
      echo "Install python3-venv and/or uv on the host (no-sandbox runs bootstrap on the host), or use a Docker sandbox provider."
      exit 1
    fi
  fi

  # shellcheck source=/dev/null
  source "$activate"
}

# Detect a preferred extras name from [project.optional-dependencies] in
# pyproject.toml. Picks the first of dev, test, tests that exists, and prints
# just the bare extra name (e.g. "dev"). Prints nothing when no preferred extra
# is present, when pyproject.toml has no optional-dependencies table, or when
# the running Python is too old to parse TOML (pre-3.11, no tomllib).
detect_optional_extra() {
  [[ -f pyproject.toml ]] || return 0
  python3 - <<'PY' 2>/dev/null || true
try:
    import tomllib
except ImportError:
    raise SystemExit(0)
import pathlib
try:
    data = tomllib.loads(pathlib.Path("pyproject.toml").read_text())
except Exception:
    raise SystemExit(0)
opt = data.get("project", {}).get("optional-dependencies", {})
for name in ("dev", "test", "tests"):
    if name in opt:
        print(name)
        break
PY
}

if is_poetry_project; then
  echo "archLoop bootstrap: Poetry project detected."
  echo "Poetry is not installed in the default Python profile image."
  echo "Customize .archloop/Dockerfile (or Containerfile) and bootstrap.sh to add Poetry support."
  exit 0
fi

if [[ -f uv.lock ]]; then
  echo "archLoop bootstrap: syncing dependencies with uv (uv.lock)"
  uv sync --frozen
  extra="$(detect_optional_extra)"
  if [[ -n "$extra" ]]; then
    echo "archLoop bootstrap: installing [$extra] extras with uv"
    uv sync --frozen --extra "$extra"
  fi
  exit 0
fi

if [[ -f pyproject.toml ]] && command -v uv >/dev/null 2>&1; then
  echo "archLoop bootstrap: syncing dependencies with uv (pyproject.toml)"
  extra="$(detect_optional_extra)"
  if [[ -n "$extra" ]]; then
    echo "archLoop bootstrap: including [$extra] extras"
    uv sync --extra "$extra"
  else
    uv sync
  fi
  exit 0
fi

if [[ -f requirements.txt ]]; then
  ensure_venv
  echo "archLoop bootstrap: installing requirements.txt with pip"
  python -m pip install -r requirements.txt
  exit 0
fi

if [[ -f pyproject.toml ]]; then
  ensure_venv
  extra="$(detect_optional_extra)"
  if [[ -n "$extra" ]]; then
    echo "archLoop bootstrap: installing pyproject.toml with pip (including [$extra] extras)"
    python -m pip install -e ".[$extra]"
  else
    echo "archLoop bootstrap: installing pyproject.toml with pip"
    python -m pip install -e .
  fi
  exit 0
fi

echo "archLoop bootstrap: no Python dependency manifest found; skipping dependency setup."
exit 0
`;

export const PYTHON_PROJECT_PROFILE: ProjectProfileEntry = {
  name: "python",
  label: "Python",
  description:
    "Python, pip, venv, and uv in the sandbox image with setup-only bootstrap for common dependency layouts",
  containerfileTools: PYTHON_CONTAINERFILE_TOOLS,
  bootstrapScript: PYTHON_BOOTSTRAP_SCRIPT,
  promptVerifyGuidance:
    "`python -m pytest` when tests are configured, plus any type or lint checks your project uses (e.g. `mypy`, `ruff check`)",
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
  promptVerifyGuidance:
    "`cmake --build build` for CMake projects configured by bootstrap, or `make` for Makefile projects",
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
