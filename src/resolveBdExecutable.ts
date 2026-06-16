import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const PINNED_BEADS_VERSION = "1.0.4";

const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const resolveEnvBdExecutable = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const override = env.SANDCASTLE_BD_PATH?.trim();
  if (!override) {
    return undefined;
  }
  return fileExists(override) ? override : undefined;
};

export const resolveBundledBdExecutable = (): string | undefined => {
  try {
    const packageJsonPath = require.resolve("@beads/bd/package.json");
    const executable = join(
      dirname(packageJsonPath),
      "bin",
      process.platform === "win32" ? "bd.exe" : "bd",
    );
    return fileExists(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
};

const commandExists = (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const checkCommand =
    process.platform === "win32" ? `where ${command}` : `command -v ${command}`;
  try {
    execSync(checkCommand, {
      stdio: "ignore",
      env: {
        ...process.env,
        ...env,
      },
    });
    return true;
  } catch {
    return false;
  }
};

export const resolveBdExecutable = (
  env: NodeJS.ProcessEnv = process.env,
): string =>
  resolveEnvBdExecutable(env) ?? resolveBundledBdExecutable() ?? "bd";

export const isBdAvailable = (env: NodeJS.ProcessEnv = process.env): boolean =>
  resolveEnvBdExecutable(env) !== undefined ||
  resolveBundledBdExecutable() !== undefined ||
  commandExists("bd", env);
