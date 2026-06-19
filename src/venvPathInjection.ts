/**
 * Python venv PATH injection (issue #96).
 *
 * When a worktree contains a `.venv/bin` directory at sandbox-start time,
 * prepend it to the agent's PATH so that bare `python` / `pytest` invocations
 * resolve to the venv interpreter instead of the host system Python.
 *
 * This is the runtime half of #96. The init half scaffolds a prompt fragment
 * informing the agent that a venv is present (see `capabilityPromptAssembly`).
 *
 * Behaviour:
 *
 *   - If `<worktreePath>/.venv/bin` does not exist on the host filesystem,
 *     the env is returned unchanged. (Graceful no-op for non-Python profiles
 *     and for fresh worktrees where bootstrap hasn't created the venv yet.)
 *
 *   - For the `none` provider the worktree path on the host is also the
 *     path the agent's shell sees, so the host `.venv/bin` path is prepended
 *     directly.
 *
 *   - For `bind-mount` and `isolated` providers the worktree is presented to
 *     the agent at the canonical sandbox repo path (`SANDBOX_REPO_DIR`), so
 *     the sandbox-side `.venv/bin` path is prepended.
 *
 * The function is intentionally pure / synchronous: it inspects the host
 * filesystem only, returns a fresh env record, and never mutates its input.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

export interface ComposeVenvPathEnvOptions {
  /** Host filesystem path to the worktree the sandbox will run against. */
  readonly worktreePath: string;
  /** Sandbox provider tag — controls whether we prepend host- or sandbox-side path. */
  readonly providerTag: "bind-mount" | "isolated" | "none";
  /** Env to extend. Not mutated. */
  readonly env: Record<string, string>;
}

const VENV_BIN_SUBPATH = ".venv/bin";

/**
 * Return a copy of `env` with `.venv/bin` prepended to PATH when the worktree
 * has a `.venv/bin` directory on the host. Returns the same shape unchanged
 * when no venv is detected.
 */
export const composeVenvPathEnv = (
  options: ComposeVenvPathEnvOptions,
): Record<string, string> => {
  const { worktreePath, providerTag, env } = options;

  const hostVenvBin = join(worktreePath, VENV_BIN_SUBPATH);
  if (!existsSync(hostVenvBin)) {
    return env;
  }

  const venvBinForAgent =
    providerTag === "none"
      ? hostVenvBin
      : `${SANDBOX_REPO_DIR}/${VENV_BIN_SUBPATH}`;

  const existingPath = env.PATH ?? "";
  const newPath =
    existingPath.length > 0
      ? `${venvBinForAgent}:${existingPath}`
      : venvBinForAgent;

  return {
    ...env,
    PATH: newPath,
  };
};
