import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeVenvPathEnv } from "./venvPathInjection.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

/**
 * Tests for issue #96: prepend `.venv/bin` to PATH at sandbox-start time when
 * the worktree contains a Python venv. Detection is filesystem-based so the
 * function is profile-agnostic — only the existence of `.venv/bin` matters.
 */
describe("composeVenvPathEnv", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "archloop-venv-path-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  const makeVenvBin = () => {
    mkdirSync(join(workdir, ".venv", "bin"), { recursive: true });
  };

  it("prepends host .venv/bin to PATH for the no-sandbox provider when .venv/bin exists", () => {
    makeVenvBin();
    const result = composeVenvPathEnv({
      worktreePath: workdir,
      providerTag: "none",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/agent" },
    });
    expect(result.PATH).toBe(`${workdir}/.venv/bin:/usr/bin:/bin`);
    // Other env keys are passed through.
    expect(result.HOME).toBe("/home/agent");
  });

  it("prepends sandbox-side .venv/bin to PATH for bind-mount providers", () => {
    makeVenvBin();
    const result = composeVenvPathEnv({
      worktreePath: workdir,
      providerTag: "bind-mount",
      env: { PATH: "/usr/bin" },
    });
    expect(result.PATH).toBe(`${SANDBOX_REPO_DIR}/.venv/bin:/usr/bin`);
  });

  it("prepends sandbox-side .venv/bin to PATH for isolated providers", () => {
    makeVenvBin();
    const result = composeVenvPathEnv({
      worktreePath: workdir,
      providerTag: "isolated",
      env: { PATH: "/usr/bin" },
    });
    expect(result.PATH).toBe(`${SANDBOX_REPO_DIR}/.venv/bin:/usr/bin`);
  });

  it("returns env unchanged when .venv/bin is absent (graceful no-op)", () => {
    const env = { PATH: "/usr/bin", FOO: "bar" };
    const result = composeVenvPathEnv({
      worktreePath: workdir,
      providerTag: "none",
      env,
    });
    expect(result).toEqual(env);
    // Same shape — non-Python profiles see no change.
    expect(result.PATH).toBe("/usr/bin");
  });

  it("does not mutate the input env", () => {
    makeVenvBin();
    const env = { PATH: "/usr/bin" };
    composeVenvPathEnv({
      worktreePath: workdir,
      providerTag: "none",
      env,
    });
    expect(env.PATH).toBe("/usr/bin");
  });

  it("falls back to process.env.PATH when the input env has no PATH", () => {
    makeVenvBin();
    const original = process.env.PATH;
    process.env.PATH = "/host/bin:/host/usr/bin";
    try {
      const result = composeVenvPathEnv({
        worktreePath: workdir,
        providerTag: "bind-mount",
        env: {},
      });
      // Without this fallback the agent's spawned shell loses /bin from
      // PATH and every `spawn("sh", …)` fails with ENOENT. See issue #96
      // follow-up: empty input env must not erase the host PATH.
      expect(result.PATH).toBe(
        `${SANDBOX_REPO_DIR}/.venv/bin:/host/bin:/host/usr/bin`,
      );
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });

  it("yields only .venv/bin when both input env.PATH and process.env.PATH are empty", () => {
    makeVenvBin();
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      const result = composeVenvPathEnv({
        worktreePath: workdir,
        providerTag: "bind-mount",
        env: {},
      });
      expect(result.PATH).toBe(`${SANDBOX_REPO_DIR}/.venv/bin`);
    } finally {
      if (original !== undefined) process.env.PATH = original;
    }
  });

  it("treats only a `.venv` directory without `bin` as no venv", () => {
    mkdirSync(join(workdir, ".venv"), { recursive: true });
    const result = composeVenvPathEnv({
      worktreePath: workdir,
      providerTag: "none",
      env: { PATH: "/usr/bin" },
    });
    expect(result.PATH).toBe("/usr/bin");
  });
});
