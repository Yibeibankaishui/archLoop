import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { copyToWorktree } from "./CopyToWorktree.js";
import type {
  CopyToWorktreeError,
  CopyToWorktreeTimeoutError,
} from "./errors.js";
import { MissingSandboxHookScriptError } from "./errors.js";
import type { SandboxHooks } from "./SandboxLifecycle.js";

/** Paths like `.archloop/bootstrap.sh` referenced by sandbox hook commands. */
const ARCHLOOP_SCRIPT_PATH_PATTERN =
  /(?:^|\s)(?:bash\s+)?((?:\.\/)?\.archloop\/[\w./-]+\.sh)\b/g;

export const extractarchLoopScriptPaths = (command: string): string[] => {
  const paths = new Set<string>();
  for (const match of command.matchAll(ARCHLOOP_SCRIPT_PATH_PATTERN)) {
    const raw = match[1]!;
    paths.add(raw.startsWith("./") ? raw.slice(2) : raw);
  }
  return [...paths];
};

export const collectSandboxHookScriptPaths = (
  hooks: SandboxHooks | undefined,
): string[] => [
  ...new Set(
    collectSandboxHookCommands(hooks).flatMap(extractarchLoopScriptPaths),
  ),
];

export const collectSandboxHookCommands = (
  hooks: SandboxHooks | undefined,
): string[] => {
  if (!hooks) return [];
  const commands: string[] = [];
  for (const hook of hooks.sandbox?.onSandboxReady ?? []) {
    commands.push(hook.command);
  }
  for (const hook of hooks.host?.onSandboxReady ?? []) {
    commands.push(hook.command);
  }
  return commands;
};

export const formatMissingSandboxHookScriptMessage = (
  relativePath: string,
  command: string,
): string =>
  `Sandbox hook references missing script \`${relativePath}\` (command: \`${command}\`).\n\n` +
  "Non-blank templates expect this file under \`.archloop/\` on the host worktree. That directory is local agent orchestration scaffold from \`archloop init\` — it is not part of the application repo and should not be committed to git.\n\n" +
  "Fix:\n" +
  `- Ensure \`${relativePath}\` exists locally (re-run \`archloop init\` for your project profile, or copy the script from init output).\n` +
  "- If a merge agent stashed it with \`git stash push -u\`, run \`git stash pop\` to restore local \`.archloop/\` files.\n" +
  "- After changing \`.archloop/main.ts\` hooks, restart the long-lived \`main.ts\` process so it reloads configuration.";

/**
 * Copy hook-referenced `.archloop/*.sh` scripts from the host repo into an
 * issue worktree when they exist on the host but not in the worktree (typical
 * when `.archloop/` is gitignored init scaffold).
 */
export const syncSandboxHookScriptsToWorktree = (
  hostRepoDir: string,
  worktreePath: string,
  hooks: SandboxHooks | undefined,
  timeoutMs?: number,
): Effect.Effect<void, CopyToWorktreeTimeoutError | CopyToWorktreeError> =>
  Effect.gen(function* () {
    if (hostRepoDir === worktreePath) return;

    const pathsToCopy = collectSandboxHookScriptPaths(hooks).filter(
      (relativePath) =>
        !existsSync(join(worktreePath, relativePath)) &&
        existsSync(join(hostRepoDir, relativePath)),
    );

    if (pathsToCopy.length === 0) return;

    yield* copyToWorktree(pathsToCopy, hostRepoDir, worktreePath, timeoutMs);
  });

/**
 * Sync hook scripts from the host repo, then validate they exist in the
 * target worktree before sandbox hook execution.
 */
export const prepareSandboxHookScripts = (
  hostRepoDir: string,
  worktreePath: string,
  hooks: SandboxHooks | undefined,
  timeoutMs?: number,
): Effect.Effect<
  void,
  | CopyToWorktreeTimeoutError
  | CopyToWorktreeError
  | MissingSandboxHookScriptError
> =>
  Effect.gen(function* () {
    yield* syncSandboxHookScriptsToWorktree(
      hostRepoDir,
      worktreePath,
      hooks,
      timeoutMs,
    );
    yield* validateSandboxHookScripts(worktreePath, hooks);
  });

/**
 * Fail before sandbox hook execution when a hook command references a
 * `.archloop/*.sh` script that is absent from the worktree.
 */
export const validateSandboxHookScripts = (
  worktreePath: string,
  hooks: SandboxHooks | undefined,
): Effect.Effect<void, MissingSandboxHookScriptError> =>
  Effect.gen(function* () {
    for (const command of collectSandboxHookCommands(hooks)) {
      for (const relativePath of extractarchLoopScriptPaths(command)) {
        const absolutePath = join(worktreePath, relativePath);
        if (!existsSync(absolutePath)) {
          return yield* Effect.fail(
            new MissingSandboxHookScriptError({
              command,
              scriptPath: relativePath,
              message: formatMissingSandboxHookScriptMessage(
                relativePath,
                command,
              ),
            }),
          );
        }
      }
    }
  });
