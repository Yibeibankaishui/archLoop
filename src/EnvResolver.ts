import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";

import { parseEnvFileContent } from "./envFile.js";
import { mergeHubAndProjectEnv, readHubEnvFile } from "./hubEnv.js";

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
 * Resolve env vars for Sandcastle runs from Hub env, project env, and process.env.
 *
 * Precedence:
 * - Keys declared only in the Hub env file: `process.env` overrides file values.
 * - Keys declared in `.sandcastle/.env`: project file value, then `process.env`,
 *   then Hub file value.
 * - Repo root `.env` is not part of the resolution chain.
 */
export const resolveEnv = (
  repoDir: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const projectEnv = yield* parseEnvFile(
      join(repoDir, ".sandcastle", ".env"),
    );

    return mergeHubAndProjectEnv({
      hubFileEnv: readHubEnvFile(),
      projectFileEnv: projectEnv,
    });
  });
