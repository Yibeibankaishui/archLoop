import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROJECT_PROFILE,
  DEFAULT_PROJECT_PROFILE_NAME,
  getProjectProfile,
  listProjectProfiles,
  NODE_PROJECT_PROFILE,
} from "./projectProfiles.js";

// Extract the embedded `python3 - <<'PY' ... PY` helper from the generated
// Python bootstrap so behavioral tests can run it in isolation against
// synthetic pyproject.toml files. The helper is intentionally self-contained
// so it can be exercised end-to-end without spinning up a sandbox.
const extractDetectExtraPython = (script: string): string => {
  const match = script.match(/<<'PY'[^\n]*\n([\s\S]*?)\nPY\n/);
  if (!match || match[1] === undefined) {
    throw new Error(
      "Could not extract embedded detect_optional_extra Python heredoc",
    );
  }
  return match[1];
};

const probeTomllibAvailable = (): boolean => {
  const result = spawnSync("python3", ["-c", "import tomllib"], {
    stdio: "ignore",
  });
  return result.status === 0;
};

const runDetect = (
  pyScript: string,
  pyprojectContents: string | null,
): string => {
  const dir = mkdtempSync(join(tmpdir(), "archloop-extras-"));
  try {
    if (pyprojectContents !== null) {
      writeFileSync(join(dir, "pyproject.toml"), pyprojectContents);
    }
    const result = spawnSync("python3", ["-c", pyScript], {
      cwd: dir,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `detect helper failed (status ${result.status}): ${result.stderr}`,
      );
    }
    return result.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("Project profile registry", () => {
  it("defaults to generic", () => {
    expect(DEFAULT_PROJECT_PROFILE_NAME).toBe("generic");
    expect(DEFAULT_PROJECT_PROFILE).toBe(getProjectProfile("generic"));
  });

  it("lists registered profiles", () => {
    const names = listProjectProfiles().map((profile) => profile.name);
    expect(names).toContain("generic");
    expect(names).toContain("node");
    expect(names).toContain("python");
    expect(names).toContain("cpp");
  });

  it("generic profile does not add containerfile tools", () => {
    expect(DEFAULT_PROJECT_PROFILE.containerfileTools).toBe("");
  });

  it("generic profile scaffolds a no-op bootstrap script", () => {
    const script = DEFAULT_PROJECT_PROFILE.bootstrapScript;
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("exit 0");
    expect(script).not.toContain("npm install");
    expect(script).not.toContain("pip install");
  });

  it("resolves node profile from registry", () => {
    expect(getProjectProfile("node")).toBe(NODE_PROJECT_PROFILE);
    expect(NODE_PROJECT_PROFILE.label).toBe("Node");
    expect(NODE_PROJECT_PROFILE.containerfileTools).toBe("");
  });

  it("node profile bootstrap chooses install commands from lockfiles", () => {
    const script = NODE_PROJECT_PROFILE.bootstrapScript;
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("pnpm-lock.yaml");
    expect(script).toContain("pnpm install");
    expect(script).toContain("yarn.lock");
    expect(script).toContain("yarn install");
    expect(script).toContain("package-lock.json");
    expect(script).toContain("npm ci");
    expect(script).toContain("npm install");
    expect(script).toContain("No package.json found");
    expect(script).not.toContain("npm test");
    expect(script).not.toContain("npm run build");
  });

  describe("python profile", () => {
    const python = () => getProjectProfile("python")!;

    it("is listed in the registry", () => {
      expect(python().name).toBe("python");
      expect(
        listProjectProfiles().some((profile) => profile.name === "python"),
      ).toBe(true);
    });

    it("adds Python, pip, venv, and uv to containerfile tools", () => {
      const { containerfileTools } = python();
      expect(containerfileTools).toContain("python3");
      expect(containerfileTools).toContain("python3-pip");
      expect(containerfileTools).toContain("python3-venv");
      expect(containerfileTools).toContain("uv");
      expect(containerfileTools).not.toMatch(
        /pip install poetry|poetry install/i,
      );
    });

    it("bootstrap handles uv, pip, Poetry guidance, and hardened venv creation", () => {
      const script = python().bootstrapScript;
      expect(script).toContain("#!/usr/bin/env bash");
      expect(script).toContain("ensure_venv");
      expect(script).toContain('local activate=".venv/bin/activate"');
      expect(script).toContain("removing incomplete .venv");
      expect(script).toContain("failed to create venv");
      expect(script).toContain("python3-venv");
      expect(script).toContain("no-sandbox");
      expect(script).not.toContain("[[ ! -d .venv ]]");
      expect(script).toContain("poetry.lock");
      expect(script).toMatch(/tool\\.poetry/);
      expect(script).toContain("uv sync");
      expect(script).toContain("requirements.txt");
      expect(script).toContain("python3 -m venv");
      expect(script).toContain("pip install");
      expect(script).not.toContain("pytest");
      expect(script).not.toContain("poetry install");
    });

    it("bootstrap detects optional extras with tomllib and prefers dev > test > tests", () => {
      const script = python().bootstrapScript;
      // Helper exists and uses tomllib so detection works on Python 3.11+.
      expect(script).toContain("detect_optional_extra");
      expect(script).toContain("import tomllib");
      // Priority order is dev, then test, then tests.
      expect(script).toMatch(/for name in \("dev", "test", "tests"\)/);
      // 3.10 fallback: tomllib import failure must not abort bootstrap.
      expect(script).toContain("except ImportError");
      // Pip path installs extras when present, falls back to bare install.
      expect(script).toContain('python -m pip install -e ".[$extra]"');
      expect(script).toContain("python -m pip install -e .");
      // uv branches install extras with --extra <name>.
      expect(script).toContain('uv sync --extra "$extra"');
      expect(script).toContain('uv sync --frozen --extra "$extra"');
    });

    describe("detect_optional_extra (embedded Python helper)", () => {
      const pyHelper = () => extractDetectExtraPython(python().bootstrapScript);
      const tomllibAvailable = probeTomllibAvailable();
      const itIfTomllib = tomllibAvailable ? it : it.skip;

      itIfTomllib("picks 'dev' when only dev extras are declared", () => {
        const toml = [
          "[project]",
          'name = "demo"',
          'version = "0.0.0"',
          "",
          "[project.optional-dependencies]",
          'dev = ["pytest"]',
          "",
        ].join("\n");
        expect(runDetect(pyHelper(), toml)).toBe("dev");
      });

      itIfTomllib(
        "picks 'test' when test extras are present but dev is not",
        () => {
          const toml = [
            "[project]",
            'name = "demo"',
            'version = "0.0.0"',
            "",
            "[project.optional-dependencies]",
            'test = ["pytest"]',
            "",
          ].join("\n");
          expect(runDetect(pyHelper(), toml)).toBe("test");
        },
      );

      itIfTomllib(
        "prefers 'dev' over 'test' and 'tests' when multiple extras coexist",
        () => {
          const toml = [
            "[project]",
            'name = "demo"',
            'version = "0.0.0"',
            "",
            "[project.optional-dependencies]",
            'dev = ["pytest"]',
            'test = ["pytest"]',
            'tests = ["pytest"]',
            "",
          ].join("\n");
          expect(runDetect(pyHelper(), toml)).toBe("dev");
        },
      );

      itIfTomllib("prints nothing when no preferred extras are present", () => {
        const toml = [
          "[project]",
          'name = "demo"',
          'version = "0.0.0"',
          "",
          "[project.optional-dependencies]",
          'docs = ["sphinx"]',
          "",
        ].join("\n");
        expect(runDetect(pyHelper(), toml)).toBe("");
      });

      itIfTomllib(
        "prints nothing when no optional-dependencies table exists",
        () => {
          const toml = [
            "[project]",
            'name = "demo"',
            'version = "0.0.0"',
            "",
          ].join("\n");
          expect(runDetect(pyHelper(), toml)).toBe("");
        },
      );

      it("prints nothing on tomllib ImportError (Python <3.11)", () => {
        // Mask the stdlib tomllib import so the helper hits its fallback
        // branch even when running under Python 3.11+.
        const masked = `import sys\nsys.modules["tomllib"] = None\n${pyHelper()}`;
        const toml = [
          "[project]",
          'name = "demo"',
          'version = "0.0.0"',
          "",
          "[project.optional-dependencies]",
          'dev = ["pytest"]',
          "",
        ].join("\n");
        expect(runDetect(masked, toml)).toBe("");
      });
    });
  });

  describe("cpp profile", () => {
    const profile = () => getProjectProfile("cpp")!;

    it("adds common C++ containerfile tools", () => {
      const { containerfileTools } = profile();
      expect(containerfileTools).toContain("build-essential");
      expect(containerfileTools).toContain("cmake");
      expect(containerfileTools).toContain("ninja-build");
    });

    it("scaffolds setup-only bootstrap behavior", () => {
      const script = profile().bootstrapScript;
      expect(script).toContain("#!/usr/bin/env bash");
      expect(script).toContain("CMakeLists.txt");
      expect(script).toContain("cmake -S");
      expect(script).not.toContain("cmake --build");
      expect(script).toContain("Makefile");
      expect(script).not.toMatch(/\bmake\b[^l]/);
      expect(script).toContain("No supported C++ build signal found");
    });
  });

  it("returns undefined for unknown profiles", () => {
    expect(getProjectProfile("rust")).toBeUndefined();
  });

  it.each([
    {
      profileName: "generic" as const,
      includes: ["customize this prompt section"],
      excludes: [
        "npm run typecheck",
        "npm run test",
        "python -m pytest",
        "cmake --build",
      ],
    },
    {
      profileName: "node" as const,
      includes: ["npm run typecheck", "npm run test"],
      excludes: ["python -m pytest", "cmake --build"],
    },
    {
      profileName: "python" as const,
      includes: ["python -m pytest", "mypy"],
      excludes: ["npm run typecheck", "npm run test", "cmake --build"],
    },
    {
      profileName: "cpp" as const,
      includes: ["cmake --build build", "make"],
      excludes: ["npm run typecheck", "npm run test", "python -m pytest"],
    },
  ])(
    "$profileName profile defines stack-specific prompt verification guidance",
    ({ profileName, includes, excludes }) => {
      const profile = getProjectProfile(profileName)!;
      for (const text of includes) {
        expect(profile.promptVerifyGuidance).toContain(text);
      }
      for (const text of excludes) {
        expect(profile.promptVerifyGuidance).not.toContain(text);
      }
    },
  );
});
