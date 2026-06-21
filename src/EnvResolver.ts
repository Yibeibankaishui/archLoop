import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";

import { parseEnvFileContent } from "./envFile.js";
import { mergeHubAndProjectEnv, readHubEnvFile } from "./hubEnv.js";
import { resolveHubAuthSessionEnv } from "./hubAuth.js";

export interface ResolveEnvOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

const parseEnvFile = (
  filePath: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) {
      return {};
    }
    return parseEnvFileContent(content);
  });

/**
 * Resolve env vars for archLoop runs from Hub env, project env, and process.env.
 *
 * Precedence:
 * - Keys declared only in the Hub env file: `process.env` overrides file values.
 * - Keys declared in `.archloop/.env`: project file value, then `process.env`,
 *   then Hub file value.
 * - Hub auth session env such as `CODEX_HOME` and `GH_CONFIG_DIR` is added
 *   when the Hub auth directory contains login state and no explicit env value
 *   was resolved.
 * - Repo root `.env` is not part of the resolution chain.
 */
export const resolveEnv = (
  repoDir: string,
  options: ResolveEnvOptions = {},
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const projectEnv = yield* parseEnvFile(join(repoDir, ".archloop", ".env"));

    const mergedEnv = mergeHubAndProjectEnv({
      hubFileEnv: readHubEnvFile(options),
      projectFileEnv: projectEnv,
      runtimeEnv: options.env,
    });

    return {
      ...resolveHubAuthSessionEnv(options),
      ...mergedEnv,
    };
  });
