import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Docker Desktop macOS bundle (docker + credential helpers). */
export const DOCKER_DESKTOP_MACOS_BIN =
  "/Applications/Docker.app/Contents/Resources/bin";

/**
 * Resolve the docker CLI binary.
 *
 * Priority:
 * 1) ARCHLOOP_DOCKER_BIN override
 * 2) `docker` from PATH
 * 3) macOS Docker Desktop bundled CLI path
 */
export const dockerCommand = (): string => {
  const override = process.env.ARCHLOOP_DOCKER_BIN?.trim();
  if (override) return override;

  const macDockerDesktop = join(DOCKER_DESKTOP_MACOS_BIN, "docker");
  if (process.platform === "darwin" && existsSync(macDockerDesktop)) {
    return macDockerDesktop;
  }

  return "docker";
};

/**
 * `env` for child processes that invoke the Docker CLI.
 *
 * Docker Desktop stores helpers such as `docker-credential-desktop` next to
 * `docker`. Minimal PATH environments (IDE tasks, some CI agents) omit that
 * directory, which breaks `docker build` / pulls even when `docker` itself resolves.
 */
export const dockerCliEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (process.platform !== "darwin") {
    return env;
  }
  const credHelper = join(
    DOCKER_DESKTOP_MACOS_BIN,
    "docker-credential-desktop",
  );
  if (!existsSync(credHelper)) {
    return env;
  }
  const p = env.PATH ?? "";
  const parts = p.split(delimiter).filter((s) => s.length > 0);
  if (!parts.includes(DOCKER_DESKTOP_MACOS_BIN)) {
    env.PATH = [DOCKER_DESKTOP_MACOS_BIN, ...parts].join(delimiter);
  }
  return env;
};
