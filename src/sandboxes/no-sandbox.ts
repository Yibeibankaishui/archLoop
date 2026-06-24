/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "archloop/sandboxes/no-sandbox";
 *   await interactive({ agent: claudeCode("claude-opus-4-6"), sandbox: noSandbox() });
 *
 * Accepted by `run()`, `interactive()`, and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 */

import { spawn, type StdioOptions } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  NoSandboxProvider,
  NoSandboxHandle,
  ExecResult,
  InteractiveExecOptions,
} from "../SandboxProvider.js";

export interface NoSandboxOptions {
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
}

const createIsolatedGitGlobalConfig = (
  env: NodeJS.ProcessEnv,
): { readonly path: string; readonly cleanup: () => void } => {
  const tmpDir = mkdtempSync(join(tmpdir(), "archloop-gitconfig-"));
  const configPath = join(tmpDir, ".gitconfig");
  const sourcePath = env.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig");
  const sourceContent = existsSync(sourcePath)
    ? readFileSync(sourcePath, "utf8")
    : "";

  writeFileSync(configPath, sourceContent);

  return {
    path: configPath,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
};

const DEFAULT_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const ensureSystemPath = (pathValue: string | undefined): string => {
  const segments = (pathValue ?? "").split(":").filter(Boolean);
  for (const segment of DEFAULT_SYSTEM_PATH.split(":")) {
    if (!segments.includes(segment)) segments.push(segment);
  }
  return segments.join(":");
};

const killProcessTree = (
  proc: ReturnType<typeof spawn>,
): ReturnType<typeof setTimeout> | undefined => {
  if (proc.exitCode !== null || proc.signalCode !== null) return undefined;

  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && proc.pid !== undefined) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch {
      // Process is already gone.
    }
  };

  kill("SIGTERM");
  return setTimeout(() => kill("SIGKILL"), 5_000);
};

/**
 * Create a no-sandbox provider.
 *
 * The returned provider runs the agent directly on the host. All three
 * branch strategies are supported (head, merge-to-head, branch),
 * defaulting to head.
 */
export const noSandbox = (options?: NoSandboxOptions): NoSandboxProvider => ({
  tag: "none",
  name: "no-sandbox",
  env: options?.env ?? {},
  create: async (createOptions): Promise<NoSandboxHandle> => {
    const worktreePath = createOptions.worktreePath;
    const baseEnv = { ...process.env, ...createOptions.env };
    const isolatedGitConfig = createIsolatedGitGlobalConfig(baseEnv);
    const processEnv = {
      ...baseEnv,
      GIT_CONFIG_GLOBAL: isolatedGitConfig.path,
      PATH: ensureSystemPath(baseEnv.PATH),
      SHELL:
        baseEnv.SHELL && existsSync(baseEnv.SHELL) ? baseEnv.SHELL : "/bin/zsh",
    };

    const handle: NoSandboxHandle = {
      worktreePath,

      exec: (
        command: string,
        opts?: {
          onLine?: (line: string) => void;
          cwd?: string;
          sudo?: boolean;
          stdin?: string;
          signal?: AbortSignal;
        },
      ): Promise<ExecResult> => {
        // sudo is a no-op for no-sandbox — the user is already on the host
        const cwd = opts?.cwd ?? worktreePath;

        return new Promise((resolve, reject) => {
          if (opts?.signal?.aborted) {
            resolve({
              stdout: "",
              stderr: "Command aborted before start",
              exitCode: 130,
            });
            return;
          }

          const proc = spawn("sh", ["-c", command], {
            cwd,
            env: processEnv,
            detached: process.platform !== "win32",
            stdio: [
              opts?.stdin !== undefined ? "pipe" : "ignore",
              "pipe",
              "pipe",
            ],
          });

          if (opts?.stdin !== undefined) {
            proc.stdin!.write(opts.stdin);
            proc.stdin!.end();
          }

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => {
            forceKillHandle = killProcessTree(proc);
          };
          opts?.signal?.addEventListener("abort", onAbort, { once: true });

          if (opts?.onLine) {
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutChunks.push(line);
              opts.onLine!(line);
            });
          } else {
            proc.stdout!.on("data", (chunk: Buffer) => {
              stdoutChunks.push(chunk.toString());
            });
          }

          proc.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          proc.on("error", (error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          proc.on("close", (code, signal) => {
            opts?.signal?.removeEventListener("abort", onAbort);
            if (forceKillHandle !== undefined) clearTimeout(forceKillHandle);
            resolve({
              stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
              stderr: stderrChunks.join(""),
              exitCode: code ?? (signal ? 130 : 0),
            });
          });
        });
      },

      interactiveExec: (
        args: string[],
        opts: InteractiveExecOptions,
      ): Promise<{ exitCode: number }> => {
        return new Promise((resolve, reject) => {
          const [cmd, ...rest] = args;
          const proc = spawn(cmd!, rest, {
            cwd: opts.cwd ?? worktreePath,
            env: processEnv,
            stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
          });

          proc.on("error", (error: Error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          proc.on("close", (code: number | null) => {
            resolve({ exitCode: code ?? 0 });
          });
        });
      },

      close: async (): Promise<void> => {
        isolatedGitConfig.cleanup();
      },
    };

    return handle;
  },
});
