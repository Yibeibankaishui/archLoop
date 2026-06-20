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

/** Paths like `.sandcastle/bootstrap.sh` referenced by sandbox hook commands. */
const SANDCASTLE_SCRIPT_PATH_PATTERN =
  /(?:^|\s)(?:bash\s+)?((?:\.\/)?\.sandcastle\/[\w./-]+\.sh)\b/g;

export const extractSandcastleScriptPaths = (command: string): string[] => {
  const paths = new Set<string>();
  for (const match of command.matchAll(SANDCASTLE_SCRIPT_PATH_PATTERN)) {
    const raw = match[1]!;
    paths.add(raw.startsWith("./") ? raw.slice(2) : raw);
  }
  return [...paths];
};

export const collectSandboxHookScriptPaths = (
  hooks: SandboxHooks | undefined,
): string[] => {
  const paths = new Set<string>();
  for (const command of collectSandboxHookCommands(hooks)) {
    for (const relativePath of extractSandcastleScriptPaths(command)) {
      paths.add(relativePath);
    }
  }
  return [...paths];
};

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
  "Non-blank templates expect this file under \`.sandcastle/\` on the host worktree. That directory is local agent orchestration scaffold from \`sandcastle init\` — it is not part of the application repo and should not be committed to git.\n\n" +
  "Fix:\n" +
  `- Ensure \`${relativePath}\` exists locally (re-run \`sandcastle init\` for your project profile, or copy the script from init output).\n` +
  "- If a merge agent stashed it with \`git stash push -u\`, run \`git stash pop\` to restore local \`.sandcastle/\` files.\n" +
  "- After changing \`.sandcastle/main.ts\` hooks, restart the long-lived \`main.ts\` process so it reloads configuration.";

/**
 * Copy hook-referenced `.sandcastle/*.sh` scripts from the host repo into an
 * issue worktree when they exist on the host but not in the worktree (typical
 * when `.sandcastle/` is gitignored init scaffold).
 */
export const syncSandboxHookScriptsToWorktree = (
  hostRepoDir: string,
  worktreePath: string,
  hooks: SandboxHooks | undefined,
  timeoutMs?: number,
): Effect.Effect<
  void,
  CopyToWorktreeTimeoutError | CopyToWorktreeError
> =>
  Effect.gen(function* () {
    if (hostRepoDir === worktreePath) return;

    const pathsToCopy = collectSandboxHookScriptPaths(hooks).filter(
      (relativePath) => {
        const worktreeScript = join(worktreePath, relativePath);
        if (existsSync(worktreeScript)) return false;
        return existsSync(join(hostRepoDir, relativePath));
      },
    );

    if (pathsToCopy.length === 0) return;

    yield* copyToWorktree(pathsToCopy, hostRepoDir, worktreePath, timeoutMs);
  });

/**
 * Fail before sandbox hook execution when a hook command references a
 * `.sandcastle/*.sh` script that is absent from the host worktree.
 */
export const validateSandboxHookScripts = (
  hostWorktreePath: string,
  hooks: SandboxHooks | undefined,
): Effect.Effect<void, MissingSandboxHookScriptError> =>
  Effect.gen(function* () {
    for (const command of collectSandboxHookCommands(hooks)) {
      for (const relativePath of extractSandcastleScriptPaths(command)) {
        const absolutePath = join(hostWorktreePath, relativePath);
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
