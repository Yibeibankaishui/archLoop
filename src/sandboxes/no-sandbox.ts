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
        },
      ): Promise<ExecResult> => {
        // sudo is a no-op for no-sandbox — the user is already on the host
        const cwd = opts?.cwd ?? worktreePath;

        return new Promise((resolve, reject) => {
          const proc = spawn("sh", ["-c", command], {
            cwd,
            env: processEnv,
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

          proc.on("close", (code) => {
            resolve({
              stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
              stderr: stderrChunks.join(""),
              exitCode: code ?? 0,
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
